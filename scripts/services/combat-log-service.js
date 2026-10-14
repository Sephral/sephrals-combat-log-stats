import { getSystemAdapter } from "../adapters/adapter-registry.js";
import { ACTION_STATUS, CONFIDENCE, EVENT_TYPES, HOOKS, LOG_STATUS, MODULE_ID, RESOURCE_INTERPRETATIONS, SEGMENT_REASONS, SETTINGS, SHARE_MODES, SIDES, SOURCE_KINDS } from "../constants.js";
import { closeCurrentSegment, createCombatLog, createSessionSegment, snapshotParticipant } from "../models/combat-log.js";
import { getSetting } from "../settings.js";
import { cloneData, debugLog, getProperty, isoNow, isTrackingGM } from "../utils.js";
import { CombatEventLedger } from "./event-ledger.js";
import { isResourceDelta } from "./event-insights.js";
import { CombatLogPersistenceService } from "./persistence-service.js";
import { CombatStatsService } from "./stats-service.js";
import { CorrelationService } from "./correlation-service.js";
import { actorTrace, applicationTrace, buildDebugLog, collectEnvironment, DebugTrace, messageTrace } from "./debug-log-service.js";
import { PlayerReportService } from "./player-report-service.js";

// How long a system damage application (dnd5e.preApplyDamage) waits for the matching hit point update.
const APPLICATION_WINDOW_MS = 5000;
// Crucible changes the pools of a confirmed action card and sets the card's confirmed flag right after. A change
// older than this was not caused by the confirmation.
const CONFIRMATION_WINDOW_MS = 15000;
// Events arrive in bursts (a roll, its chat card, the hit point update, a condition). One write per burst.
const DEFAULT_PERSIST_DELAY_MS = 750;

function isCombatStarted(combat) {
  return Boolean(combat?.started ?? (Number(combat?.round) > 0));
}

export class CombatLogService {
  constructor({ persistDelayMs = DEFAULT_PERSIST_DELAY_MS } = {}) {
    this.persistence = new CombatLogPersistenceService();
    this.activeLogs = new Map();
    this.actorSnapshots = new Map();
    this.pendingApplications = new Map();
    // Raw hook calls for the debug log, newest last.
    this.debugTrace = new DebugTrace();
    this.pendingSaves = new Map();
    // Logs whose write has started but not finished.
    this.savingLogs = new Map();
    this.persistTimer = null;
    this.persistDelayMs = persistDelayMs;
    this.correlation = new CorrelationService({ windowMs: getSetting(SETTINGS.RESOURCE_DELTA_WINDOW_MS, 60000) });
    this.playerReports = new PlayerReportService();
    this.adapter.registerSystemHooks?.(this);
  }

  get adapter() {
    return getSystemAdapter(game?.system?.id ?? "generic");
  }

  async ready() {
    // Resuming saves the logs (world setting and world data file). Only the tracking GM writes them.
    if (!isTrackingGM()) return;
    await this.restoreStashedLogs();
    if (!getSetting(SETTINGS.AUTO_RESUME_ACTIVE_COMBATS, true)) return;
    const logs = await this.persistence.loadActiveLogs();
    for (const log of logs) await this.resumeLog(log);
  }

  async resumeLog(log) {
    const combat = this.findCombatForLog(log);
    if (!combat) {
      log.status = LOG_STATUS.ORPHANED;
      log.lastSeenAt = isoNow();
      await this.persistence.saveLog(log);
      return log;
    }

    log.sessionSegments.push(createSessionSegment(SEGMENT_REASONS.RESUMED_AFTER_RELOAD));
    new CombatEventLedger(log).combatResumed(combat);
    this.activeLogs.set(combat.id, log);
    await this.detectOfflineDeltas(log, combat);
    this.captureActorSnapshots(combat);
    return this.saveAndCompute(log, { immediate: true });
  }

  findCombatForLog(log) {
    return game?.combats?.contents?.find((combat) => combat.id === log.combatId || combat.uuid === log.combatUuid) ?? null;
  }

  // The live log of a running combat, otherwise the stored one.
  async getLog(logId) {
    const live = Array.from(this.activeLogs.values()).find((log) => log.id === logId);
    if (live) return live;
    await this.flushPendingSaves();
    const log = await this.persistence.loadLog(logId);
    // The stored numbers follow the settings of the last save. Read them again with the current settings (damage
    // per round basis, unclear changes); logs saved before 1.1 also lack the per round numbers. The store stays as is.
    if (log) log.computed = CombatStatsService.compute(log, this.statsOptions());
    return log;
  }

  statsOptions() {
    return {
      includeUnclearDeltasInStats: getSetting(SETTINGS.INCLUDE_UNCLEAR_DELTAS_IN_STATS, false),
      defaultDprMethod: getSetting(SETTINGS.DEFAULT_DPR_METHOD, "appliedNet")
    };
  }

  // Encounters that are only prepared get no log. combatStart passes force, it fires before round 1 is written.
  async startCombat(combat, { force = false } = {}) {
    if (!combat || !getSetting(SETTINGS.ENABLE_AUTO_TRACKING, true)) return null;
    const existing = this.activeLogs.get(combat.id);
    if (existing) return existing;
    if (!force && !isCombatStarted(combat)) return null;
    const log = createCombatLog(combat, this.adapter);
    this.applyDefaultShareSettings(log);
    new CombatEventLedger(log).combatStarted(combat);
    this.activeLogs.set(combat.id, log);
    this.captureActorSnapshots(combat);
    return this.saveAndCompute(log);
  }

  applyDefaultShareSettings(log) {
    log.shareSettings = {
      ...log.shareSettings,
      shareMode: getSetting(SETTINGS.DEFAULT_SHARE_MODE, log.shareSettings?.shareMode ?? SHARE_MODES.GM_ONLY),
      anonymizeEnemies: getSetting(SETTINGS.DEFAULT_ANONYMIZE_ENEMIES, log.shareSettings?.anonymizeEnemies ?? true)
    };
  }

  // Ends a log. Foundry has no "combat ended" hook: ending a combat deletes the Combat document.
  async endCombat(combat, reason = SEGMENT_REASONS.COMBAT_ENDED, data = {}) {
    const log = this.activeLogs.get(combat?.id);
    if (!log) return null;
    const now = isoNow();
    closeCurrentSegment(log, reason, now);
    log.status = LOG_STATUS.ENDED;
    log.endedAt = now;
    log.lastSeenAt = now;
    new CombatEventLedger(log).combatEvent(EVENT_TYPES.COMBAT_ENDED, combat, { reason, ...data });
    this.updateFinalResources(log, combat);
    this.activeLogs.delete(combat.id);
    await this.saveAndCompute(log, { immediate: true });
    await this.runEndOfCombatReports(log);
    return this.saveAndCompute(log, { immediate: true });
  }

  async runEndOfCombatReports(log) {
    const autoPost = getSetting(SETTINGS.AUTO_POST_PLAYER_SUMMARY_ON_END, false);
    const autoJournal = getSetting(SETTINGS.AUTO_EXPORT_JOURNAL_ON_END, false);
    // With player reports turned off the combat stays private, it is not even marked as shared.
    if ((!autoPost && !autoJournal) || !getSetting(SETTINGS.ENABLE_PLAYER_SHARING, true)) return;
    prepareAutoReportSharing(log);
    if (!this.playerReports.canShare(log)) return;
    if (autoPost) await this.playerReports.postChatSummary(log);
    if (autoJournal) await this.playerReports.createJournalReport(log);
  }

  async deleteCombat(combat) {
    return this.endCombat(combat, SEGMENT_REASONS.COMBAT_ENDED, { deletedCombatDocument: true });
  }

  async updateCombat(combat, changed = {}, previous = combat?.previous ?? {}) {
    if (!("round" in changed) && !("turn" in changed)) return null;
    const log = await this.ensureLogForCombat(combat);
    if (!log) return null;
    const ledger = new CombatEventLedger(log);
    if ("round" in changed) ledger.combatEvent(EVENT_TYPES.ROUND_CHANGED, combat, { oldValue: previous?.round ?? null, newValue: combat.round });
    if ("turn" in changed) ledger.combatEvent(EVENT_TYPES.TURN_CHANGED, combat, { oldValue: previous?.turn ?? null, newValue: combat.turn, combatantId: combat?.combatant?.id ?? "" });
    return this.saveAndCompute(log);
  }

  async ensureLogForCombat(combat) {
    if (!combat) return null;
    return this.activeLogs.get(combat.id) ?? this.startCombat(combat);
  }

  async combatantCreated(combatant) {
    const combat = combatant?.combat ?? game?.combat;
    const log = await this.ensureLogForCombat(combat);
    if (!log) return null;
    if (!log.participants.some((entry) => entry.combatantId === combatant.id)) {
      const participant = snapshotParticipant(combatant, this.adapter);
      log.participants.push(participant);
      log.latestSnapshots ??= {};
      log.latestSnapshots[participant.combatantId] = cloneData(participant.initialResources);
    }
    // Hit point changes made on other clients arrive without a preUpdateActor on this client.
    if (combatant?.actor?.uuid) this.actorSnapshots.set(combatant.actor.uuid, actorDataSnapshot(combatant.actor));
    new CombatEventLedger(log).append({
      type: EVENT_TYPES.COMBATANT_CREATED,
      combatantId: combatant.id,
      actorUuid: combatant.actor?.uuid ?? "",
      tokenUuid: combatant.token?.uuid ?? "",
      round: combat?.round ?? null,
      turn: combat?.turn ?? null,
      source: { kind: SOURCE_KINDS.HOOK, id: combatant.id },
      confidence: CONFIDENCE.SAFE,
      data: { name: combatant.name }
    });
    return this.saveAndCompute(log);
  }

  async combatantUpdated(combatant, changed = {}) {
    const combat = combatant?.combat ?? game?.combat;
    const log = this.activeLogs.get(combat?.id);
    if (!log) return null;
    const participant = log.participants.find((entry) => entry.combatantId === combatant.id);
    if (participant) {
      const fresh = snapshotParticipant(combatant, this.adapter);
      // Keep what the GM set by hand and the starting resources.
      Object.assign(participant, fresh, {
        initialResources: participant.initialResources,
        side: participant.sideLocked ? participant.side : fresh.side,
        sideLocked: Boolean(participant.sideLocked)
      });
    }
    // Initiative rolls and hidden toggles are not worth an event of their own.
    if (!("defeated" in changed) && !("hidden" in changed)) return this.saveAndCompute(log);
    new CombatEventLedger(log).append({
      type: EVENT_TYPES.COMBATANT_UPDATED,
      combatantId: combatant.id,
      actorUuid: combatant.actor?.uuid ?? "",
      tokenUuid: combatant.token?.uuid ?? "",
      round: combat?.round ?? null,
      turn: combat?.turn ?? null,
      source: { kind: SOURCE_KINDS.HOOK, id: combatant.id },
      confidence: CONFIDENCE.SAFE,
      data: { changed: pick(changed, ["defeated", "hidden"]) }
    });
    return this.saveAndCompute(log);
  }

  async combatantRemoved(combatant) {
    const combat = combatant?.combat ?? game?.combat;
    const log = this.activeLogs.get(combat?.id);
    if (!log) return null;
    new CombatEventLedger(log).append({
      type: EVENT_TYPES.COMBATANT_REMOVED,
      combatantId: combatant.id,
      actorUuid: combatant.actor?.uuid ?? "",
      tokenUuid: combatant.token?.uuid ?? "",
      round: combat?.round ?? null,
      turn: combat?.turn ?? null,
      source: { kind: SOURCE_KINDS.HOOK, id: combatant.id },
      confidence: CONFIDENCE.SAFE,
      data: { name: combatant.name }
    });
    return this.saveAndCompute(log);
  }

  async activeEffectChanged(type, effect, changed = {}) {
    if (!getSetting(SETTINGS.TRACK_ACTIVE_EFFECTS, true)) return null;
    // Only effects that sit on an actor are in play. Item effects are templates or passive bonuses.
    const actor = effect?.parent?.documentName === "Actor" ? effect.parent : null;
    if (!actor) return null;
    // Duration ticks update effects every turn; only a status or enable change matters.
    if (type === EVENT_TYPES.ACTIVE_EFFECT_UPDATED && !("disabled" in (changed ?? {})) && !("statuses" in (changed ?? {}))) return null;
    const matchingLogs = this.findLogsForActor(actor);
    if (!matchingLogs.length) return null;
    const statuses = Array.from(effect?.statuses ?? []).map(String);
    for (const log of matchingLogs) {
      const combat = this.findCombatForLog(log);
      const target = this.findParticipantForActor(log, actor);
      const source = this.findEffectSource(log, effect, target, combat);
      const control = type === EVENT_TYPES.ACTIVE_EFFECT_CREATED && isControlEffect(statuses, actor, this.adapter) && Boolean(source.participant);
      const automatic = this.adapter.automaticStatuses?.() ?? [];
      new CombatEventLedger(log).append({
        type,
        round: combat?.round ?? null,
        turn: combat?.turn ?? null,
        combatantId: source.participant?.combatantId ?? "",
        actorUuid: source.participant?.actorUuid ?? "",
        tokenUuid: source.participant?.tokenUuid ?? "",
        source: { kind: SOURCE_KINDS.ACTIVE_EFFECT_UPDATE, id: effect?.id ?? effect?.uuid ?? "" },
        confidence: source.guessed ? CONFIDENCE.PROBABLE : CONFIDENCE.SAFE,
        data: {
          effectId: effect?.id ?? "",
          effectUuid: effect?.uuid ?? "",
          name: effect?.name ?? effect?.label ?? "",
          icon: effect?.img ?? effect?._source?.img ?? effect?._source?.icon ?? "",
          disabled: Boolean(effect?.disabled),
          statuses,
          control,
          ...(statuses.length ? { automatic: statuses.every((status) => automatic.includes(status)) } : {}),
          sourceCombatantId: source.participant?.combatantId ?? "",
          sourceGuessed: Boolean(source.guessed),
          targetCombatantId: target?.combatantId ?? "",
          targetActorUuid: target?.actorUuid ?? actor.uuid ?? "",
          changes: type === EVENT_TYPES.ACTIVE_EFFECT_UPDATED ? pick(changed ?? {}, ["disabled", "statuses"]) : {}
        }
      });
      await this.saveAndCompute(log);
    }
    return matchingLogs;
  }

  // Who applied an effect: the actor behind effect.origin, otherwise the combatant whose turn it is
  // when the effect lands on the other side.
  findEffectSource(log, effect, target, combat) {
    const origin = String(effect?.origin ?? "");
    if (origin) {
      const originActor = actorFromUuid(origin);
      const participant = originActor ? this.findParticipantForActor(log, originActor) : null;
      if (participant && participant.combatantId !== target?.combatantId) return { participant, guessed: false };
      if (participant) return { participant: null, guessed: false };
    }
    const activeId = combat?.combatant?.id ?? "";
    const active = log.participants.find((entry) => entry.combatantId === activeId) ?? null;
    if (active && target && active.combatantId !== target.combatantId && opposingSides(active.side, target.side)) {
      return { participant: active, guessed: true };
    }
    return { participant: null, guessed: false };
  }

  async chatMessageCreated(message) {
    this.debugTrace.add("createChatMessage", messageTrace(message));
    if (!getSetting(SETTINGS.TRACK_CHAT_MESSAGES, true)) return null;
    const log = this.findLogForMessage(message);
    if (!log) return null;
    const combat = this.findCombatForLog(log);
    const speakerParticipant = this.findParticipantForSpeaker(log, message?.speaker);
    const whispered = Boolean(message?.whisper?.length);
    // Chat text is not stored: the log can be read by every client, whispers included.
    new CombatEventLedger(log).append({
      type: EVENT_TYPES.CHAT_MESSAGE_CREATED,
      round: combat?.round ?? null,
      turn: combat?.turn ?? null,
      combatantId: speakerParticipant?.combatantId ?? "",
      actorUuid: speakerParticipant?.actorUuid ?? (message?.speaker?.actor ? `Actor.${message.speaker.actor}` : ""),
      tokenUuid: speakerParticipant?.tokenUuid ?? speakerTokenUuid(message?.speaker),
      userId: messageAuthorId(message),
      visibility: whispered ? "gm" : "public",
      source: { kind: SOURCE_KINDS.CHAT_MESSAGE, id: message.id },
      confidence: CONFIDENCE.SAFE,
      data: { speakerAlias: whispered ? "" : String(message?.speaker?.alias ?? ""), rollCount: Array.from(message?.rolls ?? []).length }
    });

    // A re-created copy of a card (midi-qol) carries rolls that are already recorded under the first card.
    const original = this.adapter.findCopiedCard?.(message);
    if (original) {
      log.messageAliases ??= {};
      log.messageAliases[message.id] = log.messageAliases[original] ?? original;
      await this.recordAddedRolls(message, log);
    } else if (getSetting(SETTINGS.TRACK_ROLLS, true)) this.recordRolls(log, message, combat);
    this.recordChatApplications(log, message, combat);
    this.recordPlannedAction(log, message, combat);
    return this.saveAndCompute(log);
  }

  // Action cards whose outcome waits for the GM (Crucible). The planned changes per target are kept, so the
  // changes of the confirmation can be matched to them exactly.
  recordPlannedAction(log, message, combat) {
    const planned = this.adapter.extractPlannedAction?.(message);
    if (!planned || !message?.id) return null;
    if (findActionEvent(log, message.id)) return null;
    const source = this.findParticipantForSpeaker(log, message?.speaker) ?? this.findParticipantForUuids(log, planned.tokenUuid, planned.actorUuid);
    const rollEvent = (log.events ?? []).find((event) => event.source?.id === message.id && String(event.type).startsWith("roll."));
    const outcomes = (planned.outcomes ?? []).map((outcome) => {
      const target = this.findParticipantForUuids(log, outcome.targetTokenUuid, outcome.targetActorUuid);
      return {
        targetCombatantId: target?.combatantId ?? "",
        targetActorUuid: outcome.targetActorUuid ?? "",
        targetTokenUuid: outcome.targetTokenUuid ?? "",
        targetName: target?.name ?? "",
        pools: { ...(outcome.pools ?? {}) },
        statuses: [...(outcome.statuses ?? [])],
        damageTypes: [...(outcome.damageTypes ?? [])],
        isCritical: Boolean(outcome.isCritical),
        isFumble: Boolean(outcome.isFumble),
        state: "pending",
        deltaEventIds: []
      };
    }).filter((outcome) => Object.keys(outcome.pools).length || outcome.statuses.length);
    const sourceId = source?.combatantId ?? "";
    const toOthers = outcomes.filter((outcome) => !sourceId || outcome.targetCombatantId !== sourceId);
    return new CombatEventLedger(log).append({
      type: EVENT_TYPES.ACTION_USED,
      round: combat?.round ?? null,
      turn: combat?.turn ?? null,
      combatantId: sourceId,
      actorUuid: source?.actorUuid ?? planned.actorUuid ?? "",
      tokenUuid: source?.tokenUuid ?? planned.tokenUuid ?? "",
      userId: messageAuthorId(message),
      visibility: message?.whisper?.length ? "gm" : "public",
      source: { kind: SOURCE_KINDS.CHAT_MESSAGE, id: message.id },
      confidence: CONFIDENCE.SAFE,
      data: {
        messageId: message.id,
        actionName: planned.actionName ?? "",
        actionKind: planned.actionKind ?? "",
        actionId: planned.actionId ?? "",
        status: planned.confirmed ? ACTION_STATUS.CONFIRMED : ACTION_STATUS.PENDING,
        rollEventId: rollEvent?.id ?? null,
        targetCombatantIds: outcomes.map((outcome) => outcome.targetCombatantId).filter(Boolean),
        plannedDamage: sumPool(toOthers, "health", -1),
        plannedHealing: sumPool(outcomes, "health", 1),
        plannedMorale: sumPool(toOthers, "morale", -1),
        outcomes
      }
    });
  }

  // Crucible sets flags.crucible.confirmed after the pools of every target changed, and clears it on undo.
  async chatMessageUpdated(message, changed = {}) {
    if (!message?.id) return null;
    this.debugTrace.add("updateChatMessage", messageTrace(message, changed));
    if (Array.isArray(changed?.rolls)) await this.recordAddedRolls(message);
    const confirmed = this.adapter.readConfirmation?.(message, changed);
    if (typeof confirmed !== "boolean") return null;
    const touched = [];
    for (const log of this.activeLogs.values()) {
      const action = findActionEvent(log, message.id);
      if (!action) continue;
      action.data.status = confirmed ? ACTION_STATUS.CONFIRMED : ACTION_STATUS.REVERSED;
      action.data[confirmed ? "confirmedAt" : "reversedAt"] = isoNow();
      this.resolvePlannedCandidates(log, action, { reversal: !confirmed });
      this.finalizeConfirmedAction(log, action, { reversal: !confirmed });
      touched.push(await this.saveAndCompute(log));
    }
    return touched;
  }

  // midi-qol and other automation fill an item card step by step: the attack and damage rolls arrive as updates
  // of the card. Rolls already recorded for the message stay, new ones are added. A roll that was replaced (a reroll)
  // takes over its event, and rolls the card no longer holds (an attack rolled again) are dropped.
  async recordAddedRolls(message, knownLog = null) {
    if (!getSetting(SETTINGS.TRACK_ROLLS, true) || this.adapter.skipRolls?.(message)) return null;
    const log = knownLog ?? this.findLogForMessage(message);
    if (!log) return null;
    const sourceId = log.messageAliases?.[message.id] ?? message.id;
    const rolls = Array.from(message?.rolls ?? []);
    const recorded = (log.events ?? []).filter((event) => event.source?.kind === SOURCE_KINDS.ROLL && event.source?.id === sourceId);
    const combat = this.findCombatForLog(log);
    let changed = false;
    recorded.slice(0, rolls.length).forEach((event, index) => {
      const fingerprint = rollFingerprint(rolls[index]);
      if (!event.data?.fingerprint || event.data.fingerprint === fingerprint) return;
      Object.assign(event, this.rollEventFields(log, message, combat, rolls[index], index), { round: event.round, turn: event.turn });
      changed = true;
    });
    if (recorded.length > rolls.length) {
      const dropped = new Set(recorded.slice(rolls.length).filter((event) => event.data?.fingerprint).map((event) => event.id));
      if (dropped.size) {
        log.events = log.events.filter((event) => !dropped.has(event.id));
        changed = true;
      }
    }
    if (rolls.length > recorded.length) {
      this.recordRolls(log, message, combat, { fromIndex: recorded.length, sourceId });
      changed = true;
    }
    return changed && !knownLog ? this.saveAndCompute(log) : null;
  }

  // A deleted action card that was never confirmed is no open action anymore.
  async chatMessageDeleted(message) {
    if (!message?.id) return null;
    const touched = [];
    for (const log of this.activeLogs.values()) {
      const action = findActionEvent(log, message.id);
      if (!action || action.data.status === ACTION_STATUS.CONFIRMED) continue;
      action.data.status = ACTION_STATUS.DELETED;
      touched.push(await this.saveAndCompute(log));
    }
    return touched;
  }

  recordRolls(log, message, combat, { fromIndex = 0, sourceId = message?.id } = {}) {
    if (this.adapter.skipRolls?.(message)) return;
    const ledger = new CombatEventLedger(log);
    Array.from(message?.rolls ?? []).forEach((roll, index) => {
      if (index < fromIndex) return;
      ledger.append({ ...this.rollEventFields(log, message, combat, roll, index), source: { kind: SOURCE_KINDS.ROLL, id: sourceId } });
    });
  }

  // The fingerprint tells a replaced roll of a card from the one recorded before.
  rollEventFields(log, message, combat, roll, index) {
    const sourceParticipant = this.findParticipantForSpeaker(log, message?.speaker);
    const targets = this.resolveMessageTargets(log, this.adapter.extractMessageTargets(message));
    const classification = this.adapter.classifyRoll(roll, message);
    return {
      type: classification.type,
      round: combat?.round ?? null,
      turn: combat?.turn ?? null,
      combatantId: sourceParticipant?.combatantId ?? "",
      actorUuid: sourceParticipant?.actorUuid ?? (message?.speaker?.actor ? `Actor.${message.speaker.actor}` : ""),
      tokenUuid: sourceParticipant?.tokenUuid ?? speakerTokenUuid(message?.speaker),
      userId: messageAuthorId(message),
      visibility: message?.whisper?.length ? "gm" : "public",
      confidence: classification.confidence,
      data: {
        ...this.adapter.extractRollData(roll, message, classification),
        rollIndex: index,
        fingerprint: rollFingerprint(roll),
        targetCombatantIds: targets.map((target) => target.combatantId),
        targetActorUuids: targets.map((target) => target.actorUuid).filter(Boolean),
        targetTokenUuids: targets.map((target) => target.tokenUuid).filter(Boolean),
        targetNames: targets.map((target) => target.name).filter(Boolean)
      }
    };
  }

  recordChatApplications(log, message, combat) {
    const applications = this.adapter.extractChatApplications(message);
    if (!applications.length) return [];
    const ledger = new CombatEventLedger(log);
    const sourceParticipant = this.findParticipantForSpeaker(log, message?.speaker);
    const events = [];
    for (const application of applications) {
      const target = this.findParticipantForChatApplication(log, application);
      // Without a known speaker the source stays empty; the target never "deals" its own damage.
      const source = sourceParticipant && sourceParticipant.combatantId !== target?.combatantId ? sourceParticipant : null;
      events.push(ledger.append({
        type: application.type,
        round: combat?.round ?? null,
        turn: combat?.turn ?? null,
        combatantId: source?.combatantId ?? "",
        actorUuid: source?.actorUuid ?? "",
        tokenUuid: source?.tokenUuid ?? "",
        userId: messageAuthorId(message),
        visibility: message?.whisper?.length ? "gm" : "public",
        source: { kind: SOURCE_KINDS.CHAT_MESSAGE, id: `${message.id}:application:${events.length + 1}` },
        confidence: application.confidence ?? CONFIDENCE.PROBABLE,
        tags: ["chat-applied"],
        data: {
          amount: application.amount,
          targetCombatantId: target?.combatantId ?? "",
          targetActorUuid: target?.actorUuid ?? application.targetActorUuid ?? "",
          targetTokenUuid: target?.tokenUuid ?? application.targetTokenUuid ?? "",
          targetName: target?.name ?? application.targetName ?? "",
          extractionReason: application.reason ?? "chatApplication"
        }
      }));
    }
    return events;
  }

  // Called from system hooks (dnd5e.preApplyDamage) right before the hit point update they cause.
  // expected: the hit points the application will write ({ value, temp }), when the system tells.
  noteSystemApplication(actor, { amount = 0, message = null, sourceActorUuid = "", reversal = false, expected = null, options = null } = {}) {
    if (!actor?.uuid || !isTrackingGM()) return;
    this.debugTrace.add("dnd5e.preApplyDamage", applicationTrace(actor, { amount, message, sourceActorUuid }, options));
    const queue = this.pendingApplications.get(actor.uuid) ?? [];
    queue.push({ amount, messageId: message?.id ?? "", message, sourceActorUuid, reversal, expected, at: Date.now() });
    this.pendingApplications.set(actor.uuid, queue);
  }

  // The application that wrote these hit points. One that announced other values never happened (0 damage after an
  // immunity writes nothing); it and anything older is dropped instead of being credited to the next change.
  takeSystemApplication(actor, after = null) {
    const queue = this.pendingApplications.get(actor?.uuid) ?? [];
    const now = Date.now();
    while (queue.length && now - queue[0].at > APPLICATION_WINDOW_MS) queue.shift();
    const hp = getProperty(after ?? {}, "system.attributes.hp") ?? {};
    const fits = (expected, value) => expected === undefined || expected === null || value === undefined || Number(expected) === Number(value);
    const index = after ? queue.findIndex((entry) => fits(entry.expected?.value, hp.value) && fits(entry.expected?.temp, hp.temp)) : (queue.length ? 0 : -1);
    const application = index >= 0 ? queue.splice(0, index + 1).at(-1) : null;
    if (!queue.length) this.pendingApplications.delete(actor?.uuid);
    return application;
  }

  async actorUpdated(actor, changed = {}, options = {}, userId = game?.user?.id) {
    if (!getSetting(SETTINGS.TRACK_RESOURCE_DELTAS, true)) return null;
    const matchingLogs = this.findLogsForActor(actor);
    if (!matchingLogs.length) return null;
    this.debugTrace.add("updateActor", actorTrace(actor, changed, options, userId));
    const before = this.actorSnapshots.get(actor.uuid) ?? null;
    const after = actorDataSnapshot(actor);
    this.actorSnapshots.set(actor.uuid, after);
    if (!before) return null;
    const resourcePaths = getSetting(SETTINGS.RESOURCE_PATHS, {})?.[game?.system?.id] ?? this.adapter.getResourcePaths();
    const deltas = this.adapter.detectResourceDeltas(before, after, resourcePaths, actor);
    if (!deltas.length) return null;
    const application = this.takeSystemApplication(actor, after) ?? this.adapter.describeUpdateApplication?.(actor, before, after, options) ?? null;
    if (options?.isRest) return null;
    // Changes of one update (temporary and regular hit points) belong together.
    const updateId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

    for (const log of matchingLogs) {
      const combat = this.findCombatForLog(log);
      const participant = this.findParticipantForActor(log, actor);
      // An application without message, attacker or undo (dnd5e 5.2's tray, the token HUD) explains nothing: the
      // nearby rolls are matched instead.
      const described = application ? this.describeApplication(log, application) : null;
      const applicationSource = described && (described.source || described.messageId || described.reversal) ? described : null;
      const planned = applicationSource || typeof this.adapter.extractPlannedAction !== "function" ? null : this.matchPlannedOutcome(log, participant, deltas);
      const updateEvents = [];
      for (const delta of deltas) {
        const isHpValue = delta.resourcePath.endsWith("hp.value");
        // Temporary hit points that soak a system damage application count as damage.
        if (application && !application.reversal && delta.interpretedAs === RESOURCE_INTERPRETATIONS.TEMP_HP_LOSS) {
          delta.interpretedAs = RESOURCE_INTERPRETATIONS.DAMAGE;
          delta.absorbedByTempHp = true;
        }
        const event = new CombatEventLedger(log).append({
          type: EVENT_TYPES.RESOURCE_DELTA,
          round: combat?.round ?? null,
          turn: combat?.turn ?? null,
          combatantId: participant?.combatantId ?? "",
          actorUuid: participant?.actorUuid ?? actor.uuid,
          tokenUuid: participant?.tokenUuid ?? "",
          userId,
          source: { kind: SOURCE_KINDS.ACTOR_UPDATE, id: actor.id },
          confidence: delta.confidence,
          data: {
            ...delta,
            updateId,
            initiatorUserId: userId,
            targetCombatantId: participant?.combatantId ?? "",
            targetActorUuid: participant?.actorUuid ?? actor.uuid,
            targetTokenUuid: participant?.tokenUuid ?? "",
            targetDowned: typeof delta.targetDowned === "boolean" ? delta.targetDowned : isHpValue && Number(delta.oldValue) > 0 && Number(delta.newValue) <= 0,
            correlation: null
          }
        });
        updateEvents.push(event);
        if (applicationSource) this.applySystemAttribution(event, applicationSource, log);
        else if (planned?.match) event.data.correlation = { status: "plannedAction", confidence: planned.match.confidence };
        else {
          event.data.correlation = this.correlation.correlateResourceDelta(log, event);
          this.applyCorrelatedSourceAttribution(log, event, participant);
        }
        const duplicate = this.findDuplicateAppliedEvent(log, event);
        if (duplicate) {
          event.confidence = CONFIDENCE.SAFE;
          event.data.interpretedAs = RESOURCE_INTERPRETATIONS.IGNORED;
          event.data.duplicateOfEventId = duplicate.id;
          event.data.notes = "Confirmed by actor HP change; already counted from chat application.";
        }
      }
      if (planned?.match) this.applyPlannedAttribution(log, updateEvents, planned.match);
      else if (planned?.candidates?.length) {
        for (const event of updateEvents) {
          event.data.plannedCandidates = planned.candidates;
          event.data.correlation = { status: "awaitingConfirmation", rollEventId: null, candidateRollEventIds: [], confidence: CONFIDENCE.UNCLEAR, reason: "Several action cards fit this change." };
        }
      }
      if (participant?.combatantId) {
        log.latestSnapshots ??= {};
        log.latestSnapshots[participant.combatantId] = this.adapter.snapshotResources(actor, resourcePaths);
      }
      await this.saveAndCompute(log);
    }
    return matchingLogs;
  }

  // Finds the action card whose planned change for this combatant equals the pool changes of this update.
  // Exactly one card is a safe match. One card whose change was cut short (a second hit on a target that already
  // dropped) is a probable match. Several equal cards wait for the confirmation of their message.
  matchPlannedOutcome(log, participant, deltas) {
    if (!participant?.combatantId) return null;
    const pools = {};
    for (const delta of deltas) {
      if (!delta.pool) continue;
      pools[delta.pool] = (pools[delta.pool] ?? 0) + (Number(delta.delta) || 0);
    }
    if (!Object.keys(pools).length) return null;
    const exact = [];
    const clamped = [];
    for (const action of log.events ?? []) {
      if (action.type !== EVENT_TYPES.ACTION_USED || action.ignored || action.data?.status === ACTION_STATUS.DELETED) continue;
      (action.data?.outcomes ?? []).forEach((outcome, outcomeIndex) => {
        if (outcome.targetCombatantId !== participant.combatantId) return;
        const candidate = { actionEventId: action.id, outcomeIndex, reversal: false };
        if (outcome.state === "applied") {
          if (samePools(negatePools(outcome.pools), pools)) exact.push({ ...candidate, reversal: true });
        } else if (samePools(outcome.pools, pools)) exact.push(candidate);
        else if (fitsWithin(outcome.pools, pools)) clamped.push(candidate);
      });
    }
    // Probable until the card's own confirmation arrives (finalizeConfirmedAction makes it safe).
    if (exact.length === 1) return { match: { ...exact[0], confidence: CONFIDENCE.PROBABLE } };
    if (exact.length > 1) return { candidates: exact };
    // Cut short only counts when the pool really ran out: the change ends at 0 or in a new state.
    const ranOut = deltas.filter((delta) => delta.pool).every((delta) => Number(delta.delta) < 0 && (Number(delta.newValue) <= 0 || Boolean(delta.downState)));
    if (clamped.length === 1 && ranOut) return { match: { ...clamped[0], confidence: CONFIDENCE.PROBABLE } };
    return null;
  }

  // The card's confirmation arrived: the changes matched to it a moment ago are safe. Changes matched long before
  // came from something else that only looked like this card, so they lose the card again and the latest
  // unassigned change of the target is checked instead.
  finalizeConfirmedAction(log, action, { reversal = false, now = Date.now() } = {}) {
    const recent = (event) => now - new Date(event.createdAt).getTime() <= CONFIRMATION_WINDOW_MS;
    const ownEvents = (log.events ?? []).filter((event) => isResourceDelta(event) && !event.ignored && event.data?.correlation?.actionEventId === action.id);
    if (reversal) {
      for (const event of ownEvents) if (event.data.reversal && recent(event)) event.confidence = CONFIDENCE.SAFE;
      return;
    }
    (action.data?.outcomes ?? []).forEach((outcome, outcomeIndex) => {
      if (!Object.keys(outcome.pools ?? {}).length) return;
      const applied = (outcome.deltaEventIds ?? []).map((id) => (log.events ?? []).find((event) => event.id === id)).filter(Boolean);
      if (outcome.state === "applied" && applied.length && applied.every(recent)) {
        for (const event of applied) event.confidence = CONFIDENCE.SAFE;
        return;
      }
      if (outcome.state === "applied") {
        for (const event of applied) releasePlannedAttribution(event, action);
        outcome.state = "pending";
        outcome.deltaEventIds = [];
      }
      // Newest unassigned change of this target: exact is safe, a change cut short is probable.
      const groups = new Map();
      for (const event of log.events ?? []) {
        if (!isResourceDelta(event) || event.ignored || !recent(event) || event.data?.attribution || !event.data?.pool) continue;
        if (event.data.targetCombatantId !== outcome.targetCombatantId) continue;
        const key = event.data.updateId || event.id;
        groups.set(key, [...(groups.get(key) ?? []), event]);
      }
      const candidates = Array.from(groups.values()).reverse();
      const poolsOf = (events) => events.reduce((pools, event) => ({ ...pools, [event.data.pool]: (pools[event.data.pool] ?? 0) + (Number(event.data.delta) || 0) }), {});
      const exact = candidates.find((events) => samePools(outcome.pools, poolsOf(events)));
      const shortened = exact ? null : candidates.find((events) => fitsWithin(outcome.pools, poolsOf(events)));
      const match = exact ?? shortened;
      if (match) this.applyPlannedAttribution(log, match, { actionEventId: action.id, outcomeIndex, confidence: exact ? CONFIDENCE.SAFE : CONFIDENCE.PROBABLE });
    });
  }

  // Credits the changes of one update to the action card: its actor is the source, its action the name.
  // An undone card turns the changes into corrections and opens the card again.
  applyPlannedAttribution(log, events, { actionEventId, outcomeIndex, reversal = false, confidence = CONFIDENCE.SAFE } = {}) {
    const action = (log.events ?? []).find((entry) => entry.id === actionEventId);
    const outcome = action?.data?.outcomes?.[outcomeIndex];
    if (!outcome) return false;
    const source = (log.participants ?? []).find((participant) => participant.combatantId === action.combatantId) ?? null;
    const originals = new Map((outcome.deltaEventIds ?? [])
      .map((id) => (log.events ?? []).find((entry) => entry.id === id))
      .filter(Boolean)
      .map((entry) => [entry.data?.pool ?? "", entry]));
    for (const event of events) {
      delete event.data.plannedCandidates;
      event.data.correlation = { status: "plannedAction", rollEventId: action.data.rollEventId ?? null, messageId: action.data.messageId, actionEventId: action.id, confidence };
      event.data.actionName ||= action.data.actionName ?? "";
      event.data.actionKind ||= action.data.actionKind ?? "";
      if (reversal) {
        const original = originals.get(event.data.pool ?? "");
        event.data.interpretedAs = Number(event.data.delta) > 0 ? RESOURCE_INTERPRETATIONS.CORRECTION_DAMAGE_DOWN : RESOURCE_INTERPRETATIONS.CORRECTION_HEALING_DOWN;
        event.data.reversalOf = original?.id ?? "";
        event.data.targetDowned = false;
        event.data.downState = "";
        event.data.reversal = true;
        if (original) original.data.reversed = true;
      }
      // Costs an actor pays with its own health stay damage taken without a source.
      const selfDamage = source?.combatantId === event.data.targetCombatantId && Number(event.data.delta) < 0;
      if (source && !selfDamage) {
        event.data.attribution = "systemApplied";
        event.data.sourceCombatantId = source.combatantId;
        event.combatantId = source.combatantId;
        event.actorUuid = source.actorUuid ?? "";
        event.tokenUuid = source.tokenUuid ?? "";
      }
      event.confidence = confidence;
    }
    if (reversal) {
      outcome.state = "pending";
      outcome.reversals = (Number(outcome.reversals) || 0) + 1;
      outcome.deltaEventIds = [];
    } else {
      outcome.state = "applied";
      outcome.deltaEventIds = events.map((event) => event.id);
    }
    return true;
  }

  // Changes that fit several equal action cards belong to the card whose confirmation (or undo) arrives next.
  resolvePlannedCandidates(log, action, { reversal = false } = {}) {
    const fits = (entry) => entry.actionEventId === action.id && Boolean(entry.reversal) === reversal;
    const waiting = (log.events ?? []).filter((event) => isResourceDelta(event) && !event.ignored && (event.data?.plannedCandidates ?? []).some(fits));
    const byUpdate = new Map();
    for (const event of waiting) {
      const key = event.data.updateId || event.id;
      byUpdate.set(key, [...(byUpdate.get(key) ?? []), event]);
    }
    let resolved = 0;
    for (const events of byUpdate.values()) {
      const candidate = events[0].data.plannedCandidates.find(fits);
      const outcome = action.data?.outcomes?.[candidate.outcomeIndex];
      if (!outcome || outcome.state !== (reversal ? "applied" : "pending")) continue;
      if (!this.applyPlannedAttribution(log, events, { ...candidate, confidence: CONFIDENCE.SAFE })) continue;
      resolved += 1;
      // The other waiting changes can no longer belong to this outcome.
      for (const other of waiting) {
        if (events.includes(other) || !other.data.plannedCandidates) continue;
        other.data.plannedCandidates = other.data.plannedCandidates.filter((entry) => !(entry.actionEventId === action.id && entry.outcomeIndex === candidate.outcomeIndex));
      }
    }
    return resolved;
  }

  findParticipantForUuids(log, tokenUuid = "", actorUuid = "") {
    const participants = log.participants ?? [];
    if (tokenUuid) {
      const byToken = participants.find((participant) => participant.tokenUuid === tokenUuid);
      if (byToken) return byToken;
    }
    if (!actorUuid) return null;
    const actorId = /^Actor\.([^.]+)$/.exec(actorUuid)?.[1] ?? "";
    return participants.find((participant) => participant.actorUuid === actorUuid)
      ?? (actorId ? participants.find((participant) => participant.actorId === actorId && participant.actorLink !== false) : null)
      ?? null;
  }

  // Everything a bug report needs: the log, the raw chat messages of the fight and the recent hook calls.
  debugLog(log) {
    if (!log) return null;
    const combat = globalThis.game?.combats?.get?.(log.combatId);
    return buildDebugLog({
      log,
      messages: globalThis.game?.messages?.contents ?? [],
      trace: this.debugTrace.entries,
      environment: collectEnvironment(),
      combat: combat?.toObject?.() ?? null
    });
  }

  // An actor UUID of a synthetic token actor (Scene.x.Token.y.Actor.z) leads to its token.
  findParticipantForActorUuid(log, actorUuid = "") {
    if (!actorUuid) return null;
    const tokenUuid = /^(.+\.Token\.[^.]+)\.Actor\.[^.]+$/.exec(actorUuid)?.[1] ?? "";
    return this.findParticipantForUuids(log, tokenUuid, tokenUuid ? "" : actorUuid);
  }

  describeApplication(log, application) {
    const message = application.message ?? globalThis.game?.messages?.get?.(application.messageId) ?? null;
    // The attacker named by the application (midi-qol) comes before the speaker of a card found for it.
    const source = this.findParticipantForActorUuid(log, application.sourceActorUuid)
      ?? (message ? this.findParticipantForSpeaker(log, message.speaker) : null);
    const action = message && typeof this.adapter.describeAction === "function" ? this.adapter.describeAction(message) : {};
    const rollEvent = application.messageId ? (log.events ?? []).find((event) => event.source?.id === application.messageId && String(event.type).startsWith("roll.")) : null;
    return { source, action, messageId: application.messageId, rollEventId: rollEvent?.id ?? null, reversal: Boolean(application.reversal) };
  }

  applySystemAttribution(event, application, log = null) {
    if (application.reversal && log && this.applySystemReversal(log, event)) return;
    const { source, action, messageId, rollEventId } = application;
    event.data.actionName ||= action?.actionName ?? "";
    event.data.actionKind ||= action?.actionKind ?? "";
    event.data.correlation = { status: source ? "system" : "systemWithoutSource", rollEventId, messageId, confidence: CONFIDENCE.SAFE };
    if (!source || source.combatantId === event.data.targetCombatantId && event.data.interpretedAs === RESOURCE_INTERPRETATIONS.DAMAGE) return;
    event.data.attribution = "systemApplied";
    event.data.sourceCombatantId = source.combatantId;
    event.combatantId = source.combatantId;
    event.actorUuid = source.actorUuid ?? "";
    event.tokenUuid = source.tokenUuid ?? "";
    event.confidence = CONFIDENCE.SAFE;
  }

  // An undo (midi-qol's damage card) gives back what an earlier change took: it becomes a correction of that change
  // and keeps its source. Returns false when the change does not go back up or down.
  applySystemReversal(log, event) {
    const delta = Number(event.data?.delta) || 0;
    const interpretation = event.data?.interpretedAs;
    // Temporary hit points that come back undo the part of a hit they soaked.
    if (!delta || ![RESOURCE_INTERPRETATIONS.DAMAGE, RESOURCE_INTERPRETATIONS.HEALING, RESOURCE_INTERPRETATIONS.TEMP_HP_GAIN].includes(interpretation)) return false;
    const damageUndone = delta > 0;
    const undone = damageUndone ? RESOURCE_INTERPRETATIONS.DAMAGE : RESOURCE_INTERPRETATIONS.HEALING;
    const original = [...(log.events ?? [])].reverse().find((entry) => entry !== event && isResourceDelta(entry) && !entry.ignored
      && !entry.data?.reversed && entry.data?.interpretedAs === undone && entry.data?.resourcePath === event.data.resourcePath
      && entry.data?.targetCombatantId === event.data.targetCombatantId && Math.abs(Number(entry.data?.delta)) === Math.abs(delta));
    event.data.interpretedAs = damageUndone ? RESOURCE_INTERPRETATIONS.CORRECTION_DAMAGE_DOWN : RESOURCE_INTERPRETATIONS.CORRECTION_HEALING_DOWN;
    event.data.reversal = true;
    event.data.reversalOf = original?.id ?? "";
    event.data.targetDowned = false;
    event.data.correlation = { status: "systemReversal", rollEventId: null, confidence: CONFIDENCE.SAFE };
    event.confidence = CONFIDENCE.SAFE;
    if (!original) return true;
    original.data.reversed = true;
    event.data.actionName ||= original.data.actionName ?? "";
    event.data.actionKind ||= original.data.actionKind ?? "";
    if (original.data.attribution) {
      event.data.attribution = original.data.attribution;
      event.data.sourceCombatantId = original.data.sourceCombatantId ?? "";
      event.combatantId = original.combatantId;
      event.actorUuid = original.actorUuid ?? "";
      event.tokenUuid = original.tokenUuid ?? "";
    }
    return true;
  }

  // Changes made while nobody recorded. The adapter reads them like a live update, so Crucible's health that ran
  // into wounds is one change of the pool, not two.
  async detectOfflineDeltas(log, combat) {
    log.latestSnapshots ??= {};
    const resourcePaths = this.adapter.getResourcePaths();
    for (const combatant of combat?.combatants ?? []) {
      const actor = combatant.actor;
      if (!actor) continue;
      const participant = log.participants.find((entry) => entry.combatantId === combatant.id);
      if (!participant) continue;
      const previous = log.latestSnapshots[participant.combatantId];
      const current = this.adapter.snapshotResources(actor, resourcePaths);
      log.latestSnapshots[participant.combatantId] = current;
      if (!previous) continue;
      const deltas = this.adapter.detectResourceDeltas(nestedSnapshot(previous), nestedSnapshot(current), resourcePaths, actor);
      for (const delta of deltas) {
        new CombatEventLedger(log).append({
          type: EVENT_TYPES.RESOURCE_DELTA_OFFLINE,
          round: combat.round ?? null,
          turn: combat.turn ?? null,
          combatantId: participant.combatantId,
          actorUuid: participant.actorUuid ?? actor.uuid,
          tokenUuid: participant.tokenUuid ?? "",
          source: { kind: SOURCE_KINDS.RESUME, id: combat.id },
          confidence: CONFIDENCE.UNCLEAR,
          data: {
            resourcePath: delta.resourcePath,
            oldValue: delta.oldValue,
            newValue: delta.newValue,
            delta: delta.delta,
            ...(delta.pool ? { pool: delta.pool } : {}),
            ...(delta.parts ? { parts: delta.parts } : {}),
            interpretedAs: RESOURCE_INTERPRETATIONS.UNKNOWN,
            targetCombatantId: participant.combatantId,
            notes: "Detected while resuming an active combat log."
          }
        });
      }
    }
  }

  captureActorSnapshots(combat) {
    for (const combatant of combat?.combatants ?? []) {
      if (combatant.actor?.uuid) this.actorSnapshots.set(combatant.actor.uuid, actorDataSnapshot(combatant.actor));
    }
  }

  updateFinalResources(log, combat = null) {
    for (const participant of log.participants ?? []) {
      const combatant = combat?.combatants?.get?.(participant.combatantId) ?? null;
      const actor = combatant?.actor ?? (participant.actorUuid && typeof fromUuidSync === "function" ? safeFromUuidSync(participant.actorUuid) : null);
      participant.finalResources = actor ? this.adapter.snapshotResources(actor) : log.latestSnapshots?.[participant.combatantId] ?? null;
    }
  }

  // A linked actor can fight in two combats at once (another scene, a combat left running). The speaker's token
  // decides first; matched by actor only, the viewed combat wins, then the newest log.
  findLogForMessage(message) {
    const logs = Array.from(this.activeLogs.values());
    const speaker = message?.speaker ?? {};
    const tokenUuid = speakerTokenUuid(speaker);
    const byToken = logs.find((log) => (log.participants ?? []).some((participant) => (tokenUuid && participant.tokenUuid === tokenUuid) || (speaker.token && participant.tokenId === speaker.token)));
    if (byToken) return byToken;
    const bySpeaker = logs.filter((log) => this.findParticipantForSpeaker(log, speaker));
    if (bySpeaker.length) return bySpeaker.find((log) => log.combatId === game?.combat?.id) ?? bySpeaker.at(-1);
    return this.activeLogs.get(game?.combat?.id) ?? logs[0] ?? null;
  }

  // Token first: unlinked tokens of the same actor share the actor id.
  findParticipantForSpeaker(log, speaker = {}) {
    const participants = log.participants ?? [];
    const tokenUuid = speakerTokenUuid(speaker);
    if (tokenUuid) {
      const byToken = participants.find((participant) => participant.tokenUuid === tokenUuid);
      if (byToken) return byToken;
    }
    const tokenId = speaker?.token ?? "";
    if (tokenId) {
      const byTokenId = participants.find((participant) => participant.tokenId === tokenId);
      if (byTokenId) return byTokenId;
    }
    const actorId = speaker?.actor ?? "";
    if (!actorId) return null;
    return participants.find((participant) => participant.actorUuid === `Actor.${actorId}`)
      ?? participants.find((participant) => participant.actorId === actorId && participant.actorLink !== false)
      ?? null;
  }

  // The participant that belongs to an Actor document. Synthetic token actors are matched by their token.
  findParticipantForActor(log, actor) {
    if (!actor) return null;
    const participants = log.participants ?? [];
    if (actor.isToken || actor.token) {
      const tokenUuid = actor.token?.uuid ?? "";
      const byToken = tokenUuid ? participants.find((participant) => participant.tokenUuid === tokenUuid) : null;
      if (byToken) return byToken;
    }
    return participants.find((participant) => participant.actorUuid === actor.uuid)
      ?? (actor.isToken ? null : participants.find((participant) => participant.actorId === actor.id && participant.actorLink !== false))
      ?? null;
  }

  resolveMessageTargets(log, targets = {}) {
    const names = new Set((targets.names ?? []).map(normalizeName).filter(Boolean));
    return (log.participants ?? []).filter((participant) => {
      if ((targets.tokenUuids ?? []).includes(participant.tokenUuid)) return true;
      if ((targets.actorUuids ?? []).includes(participant.actorUuid)) return true;
      if (!(targets.tokenUuids ?? []).length && !(targets.actorUuids ?? []).length && names.has(normalizeName(participant.name))) return true;
      return false;
    });
  }

  findParticipantForChatApplication(log, application) {
    if (application.targetTokenUuid) {
      const byToken = (log.participants ?? []).find((participant) => participant.tokenUuid === application.targetTokenUuid);
      if (byToken) return byToken;
    }
    if (application.targetActorUuid) {
      const byActor = (log.participants ?? []).find((participant) => participant.actorUuid === application.targetActorUuid);
      if (byActor) return byActor;
    }
    const targetName = normalizeName(application.targetName);
    if (targetName) return (log.participants ?? []).find((participant) => normalizeName(participant.name) === targetName) ?? null;
    return null;
  }

  applyCorrelatedSourceAttribution(log, event, targetParticipant) {
    const correlation = event.data?.correlation;
    if (correlation?.status !== "correlated" || correlation.confidence === CONFIDENCE.UNCLEAR) return;
    if (![RESOURCE_INTERPRETATIONS.DAMAGE, RESOURCE_INTERPRETATIONS.HEALING].includes(event.data?.interpretedAs)) return;
    const rollEvent = (log.events ?? []).find((entry) => entry.id === correlation.rollEventId);
    if (!rollEvent?.combatantId) return;
    if (event.data.interpretedAs === RESOURCE_INTERPRETATIONS.DAMAGE && rollEvent.combatantId === targetParticipant?.combatantId) return;
    event.data.targetCombatantId = targetParticipant?.combatantId ?? event.combatantId ?? "";
    event.data.targetActorUuid = targetParticipant?.actorUuid ?? event.actorUuid ?? "";
    event.data.targetTokenUuid = targetParticipant?.tokenUuid ?? event.tokenUuid ?? "";
    event.data.attribution = "correlatedChatRoll";
    event.data.sourceCombatantId = rollEvent.combatantId;
    event.data.actionName ||= rollEvent.data?.actionName ?? "";
    event.data.actionKind ||= rollEvent.data?.actionKind ?? "";
    event.combatantId = rollEvent.combatantId;
    event.actorUuid = rollEvent.actorUuid ?? "";
    event.tokenUuid = rollEvent.tokenUuid ?? "";
  }

  findDuplicateAppliedEvent(log, deltaEvent) {
    if (![RESOURCE_INTERPRETATIONS.DAMAGE, RESOURCE_INTERPRETATIONS.HEALING].includes(deltaEvent.data?.interpretedAs)) return null;
    const appliedType = deltaEvent.data.interpretedAs === RESOURCE_INTERPRETATIONS.HEALING ? EVENT_TYPES.HEALING_APPLIED : EVENT_TYPES.DAMAGE_APPLIED;
    const amount = Math.abs(Number(deltaEvent.data?.delta ?? 0)) || 0;
    const targetCombatantId = deltaEvent.data?.targetCombatantId || deltaEvent.combatantId || "";
    const sourceCombatantId = deltaEvent.data?.sourceCombatantId || "";
    const deltaTime = new Date(deltaEvent.createdAt).getTime();
    return [...(log.events ?? [])].reverse().find((event) => {
      if (event.id === deltaEvent.id || event.type !== appliedType) return false;
      if (!event.tags?.includes("chat-applied")) return false;
      if (Math.abs(Number(event.data?.amount ?? 0)) !== amount) return false;
      if (sourceCombatantId && event.combatantId && event.combatantId !== sourceCombatantId) return false;
      if (targetCombatantId && event.data?.targetCombatantId && event.data.targetCombatantId !== targetCombatantId) return false;
      const eventTime = new Date(event.createdAt).getTime();
      return Number.isFinite(deltaTime) && Number.isFinite(eventTime) && Math.abs(deltaTime - eventTime) <= this.correlation.windowMs;
    }) ?? null;
  }

  findLogsForActor(actor) {
    return Array.from(this.activeLogs.values()).filter((log) => Boolean(this.findParticipantForActor(log, actor)));
  }

  // GM corrections from the log window.
  setEventSource(log, eventId, sourceCombatantId) {
    const event = (log?.events ?? []).find((entry) => entry.id === eventId);
    if (!event) return null;
    const target = event.data?.targetCombatantId || (event.data?.attribution ? "" : event.combatantId) || "";
    event.data.targetCombatantId = target;
    const source = (log.participants ?? []).find((participant) => participant.combatantId === sourceCombatantId) ?? null;
    if (source) {
      event.data.attribution = "manualSource";
      event.data.sourceCombatantId = source.combatantId;
      event.combatantId = source.combatantId;
      event.actorUuid = source.actorUuid ?? "";
      event.tokenUuid = source.tokenUuid ?? "";
    } else {
      delete event.data.attribution;
      delete event.data.sourceCombatantId;
      event.combatantId = target;
    }
    if (event.confidence === CONFIDENCE.UNCLEAR) event.confidence = CONFIDENCE.MANUAL;
    return event;
  }

  addManualAdjustment(log, { type, amount, sourceCombatantId = "", targetCombatantId = "", note = "" } = {}) {
    const allowed = [EVENT_TYPES.DAMAGE_MANUAL_ADDED, EVENT_TYPES.DAMAGE_MANUAL_REDUCED, EVENT_TYPES.HEALING_MANUAL_ADDED, EVENT_TYPES.HEALING_MANUAL_REDUCED];
    const value = Math.abs(Number(amount) || 0);
    if (!log || !allowed.includes(type) || !value) return null;
    const combat = this.findCombatForLog(log);
    const source = (log.participants ?? []).find((participant) => participant.combatantId === sourceCombatantId) ?? null;
    return new CombatEventLedger(log).append({
      type,
      round: combat?.round ?? lastRound(log),
      turn: combat?.turn ?? null,
      combatantId: source?.combatantId ?? "",
      actorUuid: source?.actorUuid ?? "",
      tokenUuid: source?.tokenUuid ?? "",
      source: { kind: SOURCE_KINDS.MANUAL, id: "manualAdjustment" },
      confidence: CONFIDENCE.MANUAL,
      tags: ["manual"],
      data: { amount: value, targetCombatantId, sourceCombatantId: source?.combatantId ?? "", note: String(note ?? "").slice(0, 200) }
    });
  }

  // Computes the stats right away and writes the store shortly after; bursts of events share one write.
  async saveAndCompute(log, { immediate = false } = {}) {
    log.computed = CombatStatsService.compute(log, this.statsOptions());
    if (log?.combatId && this.activeLogs.get(log.combatId)?.id === log.id) this.activeLogs.set(log.combatId, log);
    this.pendingSaves.set(log.id, log);
    if (immediate || this.persistDelayMs <= 0) await this.flushPendingSaves();
    else this.schedulePersist();
    globalThis.Hooks?.callAll?.(HOOKS.LOG_UPDATED, log);
    debugLog("Updated combat log", log.id, log.status, log.events.length);
    return log;
  }

  schedulePersist() {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.flushPendingSaves();
    }, this.persistDelayMs);
  }

  async flushPendingSaves() {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    const logs = Array.from(this.pendingSaves.values());
    this.pendingSaves.clear();
    for (const log of logs) this.savingLogs.set(log.id, log);
    for (const log of logs) {
      try {
        await this.persistence.saveLog(log);
      } finally {
        if (this.savingLogs.get(log.id) === log) this.savingLogs.delete(log.id);
      }
    }
  }

  // A write cannot finish while the page unloads (reload, closed tab). The logs still waiting go to the browser's
  // storage, synchronously, and the next start of this GM writes them (restoreStashedLogs).
  stashPendingSaves() {
    const logs = new Map([...this.savingLogs, ...this.pendingSaves]);
    if (!logs.size) return false;
    try {
      globalThis.localStorage?.setItem(stashKey(), JSON.stringify({ savedAt: isoNow(), logs: Array.from(logs.values()) }));
      return true;
    } catch (error) {
      console.warn(`${MODULE_ID} | Could not keep the unsaved combat logs`, error);
      return false;
    }
  }

  // Writes stashed logs that are newer than the stored ones: more events, and the stored events are all there.
  // A log another GM continued in the meantime has more events in the store and stays as it is.
  async restoreStashedLogs() {
    let stash = null;
    try {
      stash = JSON.parse(globalThis.localStorage?.getItem(stashKey()) ?? "null");
      globalThis.localStorage?.removeItem(stashKey());
    } catch {
      stash = null;
    }
    const restored = [];
    for (const log of Array.isArray(stash?.logs) ? stash.logs : []) {
      if (!log?.id || !Array.isArray(log.events)) continue;
      const stored = await this.persistence.loadLog(log.id);
      if (!isNewerLog(log, stored)) continue;
      await this.persistence.saveLog(log);
      restored.push(log.id);
    }
    if (restored.length) debugLog("Restored combat logs that were not saved before the page closed", restored);
    return restored;
  }

  // Another GM took over recording: write what is pending and stop holding the running logs.
  async releaseLogs() {
    await this.flushPendingSaves();
    this.activeLogs.clear();
    this.actorSnapshots.clear();
    this.pendingApplications.clear();
  }

  listActiveLogs() {
    return Array.from(this.activeLogs.values());
  }

  async deleteLog(logId) {
    if (!logId) return false;
    for (const [combatId, log] of this.activeLogs.entries()) {
      if (log.id === logId) this.activeLogs.delete(combatId);
    }
    this.pendingSaves.delete(logId);
    const deleted = await this.persistence.deleteLog(logId);
    if (deleted) globalThis.Hooks?.callAll?.(HOOKS.LOG_UPDATED, { id: logId, deleted: true });
    return deleted;
  }
}

// Resource snapshots are stored flat ({"system.attributes.hp.value": 7}); the adapters read nested data.
function nestedSnapshot(flat = {}) {
  const nested = {};
  for (const [path, value] of Object.entries(flat ?? {})) {
    const parts = String(path).split(".");
    let current = nested;
    for (const part of parts.slice(0, -1)) current = current[part] ??= {};
    current[parts.at(-1)] = value;
  }
  return nested;
}

function stashKey() {
  return `${MODULE_ID}.unsavedLogs.${game?.world?.id ?? "world"}`;
}

function isNewerLog(candidate, stored) {
  if (!stored) return true;
  const events = stored.events ?? [];
  if (candidate.events.length <= events.length) return false;
  const last = events.at(-1)?.id;
  return !last || candidate.events.some((event) => event.id === last);
}

function prepareAutoReportSharing(log) {
  const defaultShareMode = getSetting(SETTINGS.DEFAULT_SHARE_MODE, log.shareSettings?.shareMode ?? SHARE_MODES.SUMMARY_ONLY);
  const alreadyShared = Boolean(log.shareSettings?.isShared);
  log.shareSettings = {
    ...log.shareSettings,
    isShared: true,
    // A log the GM shared by hand keeps its mode; otherwise the configured default applies.
    shareMode: alreadyShared ? log.shareSettings.shareMode : (defaultShareMode === SHARE_MODES.GM_ONLY ? SHARE_MODES.SUMMARY_ONLY : defaultShareMode),
    includePartyStats: true,
    includeEnemyStats: log.shareSettings?.includeEnemyStats ?? true,
    includePrivateRolls: false,
    includeGMNotes: false,
    includeUnclearEvents: false,
    includeDPR: true,
    includeTimeline: true,
    includeCorrections: false,
    anonymizeEnemies: alreadyShared ? Boolean(log.shareSettings.anonymizeEnemies) : getSetting(SETTINGS.DEFAULT_ANONYMIZE_ENEMIES, log.shareSettings?.anonymizeEnemies ?? true),
    allowPlayersToOpenReport: true,
    shareUpdatedAt: isoNow()
  };
  if (!log.shareSettings.shareStartedAt) log.shareSettings.shareStartedAt = log.shareSettings.shareUpdatedAt;
}

function isControlEffect(statuses, actor, adapter) {
  const known = adapter?.controlStatuses?.() ?? [];
  const control = statuses.filter((status) => known.includes(status));
  if (!control.length) return false;
  // Unconscious at 0 hit points is the result of damage, not a control effect.
  const hp = Number(getProperty(actor, "system.attributes.hp.value"));
  if (control.every((status) => status === "unconscious") && Number.isFinite(hp) && hp <= 0) return false;
  return true;
}

// Takes a card's credit away from a change again: it counts as damage taken (or healing received) without a source.
function releasePlannedAttribution(event, action) {
  if (event.data.actionName === action?.data?.actionName) delete event.data.actionName;
  if (event.data.actionKind === action?.data?.actionKind) delete event.data.actionKind;
  delete event.data.attribution;
  delete event.data.sourceCombatantId;
  delete event.data.reversal;
  event.combatantId = event.data.targetCombatantId ?? "";
  event.actorUuid = event.data.targetActorUuid ?? "";
  event.tokenUuid = event.data.targetTokenUuid ?? "";
  event.confidence = CONFIDENCE.PROBABLE;
  event.data.correlation = { status: "uncorrelated", rollEventId: null, candidateRollEventIds: [], confidence: CONFIDENCE.UNCLEAR, reason: "The action card was confirmed later." };
}

function findActionEvent(log, messageId) {
  return (log?.events ?? []).find((event) => event.type === EVENT_TYPES.ACTION_USED && event.data?.messageId === messageId) ?? null;
}

// Planned change of one pool over several targets; direction -1 sums losses, 1 sums gains.
function sumPool(outcomes, pool, direction) {
  return outcomes.reduce((total, outcome) => {
    const delta = Number(outcome.pools?.[pool]) || 0;
    return total + (Math.sign(delta) === direction ? Math.abs(delta) : 0);
  }, 0);
}

function samePools(left = {}, right = {}) {
  const keys = new Set([...Object.keys(left ?? {}), ...Object.keys(right ?? {})]);
  for (const key of keys) if ((Number(left?.[key]) || 0) !== (Number(right?.[key]) || 0)) return false;
  return keys.size > 0;
}

function negatePools(pools = {}) {
  return Object.fromEntries(Object.entries(pools ?? {}).map(([key, value]) => [key, -(Number(value) || 0)]));
}

// The change goes the planned way but stops early, because the pool ran out or reached its limit.
function fitsWithin(planned = {}, actual = {}) {
  const keys = Object.keys(actual ?? {});
  if (!keys.length) return false;
  return keys.every((key) => {
    const want = Number(planned?.[key]) || 0;
    const got = Number(actual[key]) || 0;
    return want !== 0 && Math.sign(want) === Math.sign(got) && Math.abs(got) <= Math.abs(want);
  });
}

function opposingSides(left, right) {
  return (left === SIDES.FRIENDLY && right === SIDES.HOSTILE) || (left === SIDES.HOSTILE && right === SIDES.FRIENDLY);
}

function actorFromUuid(uuid) {
  const document = safeFromUuidSync(uuid);
  if (!document) return null;
  if (document.documentName === "Actor") return document;
  return document.actor ?? document.parent?.actor ?? (document.parent?.documentName === "Actor" ? document.parent : null);
}

function safeFromUuidSync(uuid) {
  if (typeof globalThis.fromUuidSync !== "function") return null;
  try {
    return globalThis.fromUuidSync(uuid, { strict: false }) ?? null;
  } catch {
    return null;
  }
}

// Formula, total and dice of a roll: equal for the same roll, different for a reroll.
export function rollFingerprint(roll) {
  const dice = Array.from(roll?.dice ?? []).map((die) => `${die?.faces}:${(die?.results ?? []).map((result) => result?.result).join(",")}`).join("|");
  return `${roll?.formula ?? ""}=${roll?.total ?? ""}#${dice}`;
}

function speakerTokenUuid(speaker = {}) {
  return speaker?.token && speaker?.scene ? `Scene.${speaker.scene}.Token.${speaker.token}` : "";
}

function lastRound(log) {
  return Math.max(0, ...(log?.events ?? []).map((event) => Number(event.round) || 0)) || null;
}

function pick(source, keys) {
  return Object.fromEntries(keys.filter((key) => key in (source ?? {})).map((key) => [key, source[key]]));
}

// ChatMessage#user was renamed to #author in v12. The old name logs a deprecation in v13 and is gone in v14.
function messageAuthorId(message) {
  return message?.author?.id ?? message?._source?.author ?? "";
}

function actorDataSnapshot(actor) {
  return cloneData(actor?.toObject?.() ?? actor?._source ?? actor ?? {});
}

function normalizeName(value) {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}
