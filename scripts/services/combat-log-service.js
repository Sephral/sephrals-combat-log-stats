import { getSystemAdapter } from "../adapters/adapter-registry.js";
import { CONFIDENCE, EVENT_TYPES, HOOKS, LOG_STATUS, RESOURCE_INTERPRETATIONS, SEGMENT_REASONS, SETTINGS, SHARE_MODES, SIDES, SOURCE_KINDS } from "../constants.js";
import { closeCurrentSegment, createCombatLog, createSessionSegment, snapshotParticipant } from "../models/combat-log.js";
import { getSetting } from "../settings.js";
import { cloneData, debugLog, getProperty, isoNow, isTrackingGM } from "../utils.js";
import { CombatEventLedger } from "./event-ledger.js";
import { CONTROL_STATUSES } from "./event-insights.js";
import { CombatLogPersistenceService } from "./persistence-service.js";
import { CombatStatsService } from "./stats-service.js";
import { CorrelationService } from "./correlation-service.js";
import { PlayerReportService } from "./player-report-service.js";

// How long a system damage application (dnd5e.preApplyDamage) waits for the matching hit point update.
const APPLICATION_WINDOW_MS = 5000;
// Events arrive in bursts (a roll, its chat card, the hit point update, a condition). One write per burst.
const DEFAULT_PERSIST_DELAY_MS = 750;

export class CombatLogService {
  constructor({ persistDelayMs = DEFAULT_PERSIST_DELAY_MS } = {}) {
    this.persistence = new CombatLogPersistenceService();
    this.activeLogs = new Map();
    this.actorSnapshots = new Map();
    this.pendingApplications = new Map();
    this.pendingSaves = new Map();
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
    return this.persistence.loadLog(logId);
  }

  async startCombat(combat) {
    if (!combat || !getSetting(SETTINGS.ENABLE_AUTO_TRACKING, true)) return null;
    const existing = this.activeLogs.get(combat.id);
    if (existing) return existing;
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
      const control = type === EVENT_TYPES.ACTIVE_EFFECT_CREATED && isControlEffect(statuses, actor) && Boolean(source.participant);
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

    if (getSetting(SETTINGS.TRACK_ROLLS, true)) this.recordRolls(log, message, combat);
    this.recordChatApplications(log, message, combat);
    return this.saveAndCompute(log);
  }

  recordRolls(log, message, combat) {
    const rolls = Array.from(message?.rolls ?? []);
    const ledger = new CombatEventLedger(log);
    const sourceParticipant = this.findParticipantForSpeaker(log, message?.speaker);
    const targets = this.resolveMessageTargets(log, this.adapter.extractMessageTargets(message));
    for (const roll of rolls) {
      const classification = this.adapter.classifyRoll(roll, message);
      ledger.append({
        type: classification.type,
        round: combat?.round ?? null,
        turn: combat?.turn ?? null,
        combatantId: sourceParticipant?.combatantId ?? "",
        actorUuid: sourceParticipant?.actorUuid ?? (message?.speaker?.actor ? `Actor.${message.speaker.actor}` : ""),
        tokenUuid: sourceParticipant?.tokenUuid ?? speakerTokenUuid(message?.speaker),
        userId: messageAuthorId(message),
        visibility: message?.whisper?.length ? "gm" : "public",
        source: { kind: SOURCE_KINDS.ROLL, id: message.id },
        confidence: classification.confidence,
        data: {
          ...this.adapter.extractRollData(roll, message),
          targetCombatantIds: targets.map((target) => target.combatantId),
          targetActorUuids: targets.map((target) => target.actorUuid).filter(Boolean),
          targetTokenUuids: targets.map((target) => target.tokenUuid).filter(Boolean),
          targetNames: targets.map((target) => target.name).filter(Boolean)
        }
      });
    }
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
  noteSystemApplication(actor, { amount = 0, message = null } = {}) {
    if (!actor?.uuid || !isTrackingGM()) return;
    const queue = this.pendingApplications.get(actor.uuid) ?? [];
    queue.push({ amount, messageId: message?.id ?? "", message, at: Date.now() });
    this.pendingApplications.set(actor.uuid, queue);
  }

  takeSystemApplication(actor) {
    const queue = this.pendingApplications.get(actor?.uuid) ?? [];
    const now = Date.now();
    while (queue.length && now - queue[0].at > APPLICATION_WINDOW_MS) queue.shift();
    const application = queue.shift() ?? null;
    if (!queue.length) this.pendingApplications.delete(actor?.uuid);
    return application;
  }

  async actorUpdated(actor, changed = {}, options = {}, userId = game?.user?.id) {
    if (!getSetting(SETTINGS.TRACK_RESOURCE_DELTAS, true)) return null;
    const matchingLogs = this.findLogsForActor(actor);
    if (!matchingLogs.length) return null;
    const before = this.actorSnapshots.get(actor.uuid) ?? null;
    const after = actorDataSnapshot(actor);
    this.actorSnapshots.set(actor.uuid, after);
    if (!before) return null;
    const resourcePaths = getSetting(SETTINGS.RESOURCE_PATHS, {})?.[game?.system?.id] ?? this.adapter.getResourcePaths();
    const deltas = this.adapter.detectResourceDeltas(before, after, resourcePaths);
    if (!deltas.length) return null;
    const application = this.takeSystemApplication(actor);
    if (options?.isRest) return null;
    // Changes of one update (temporary and regular hit points) belong together.
    const updateId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

    for (const log of matchingLogs) {
      const combat = this.findCombatForLog(log);
      const participant = this.findParticipantForActor(log, actor);
      const applicationSource = application ? this.describeApplication(log, application) : null;
      for (const delta of deltas) {
        const isHpValue = delta.resourcePath.endsWith("hp.value");
        // Temporary hit points that soak a system damage application count as damage.
        if (applicationSource && delta.interpretedAs === RESOURCE_INTERPRETATIONS.TEMP_HP_LOSS) {
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
            targetDowned: isHpValue && Number(delta.oldValue) > 0 && Number(delta.newValue) <= 0,
            correlation: null
          }
        });
        if (applicationSource) this.applySystemAttribution(event, applicationSource);
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
      if (participant?.combatantId) {
        log.latestSnapshots ??= {};
        log.latestSnapshots[participant.combatantId] = this.adapter.snapshotResources(actor, resourcePaths);
      }
      await this.saveAndCompute(log);
    }
    return matchingLogs;
  }

  describeApplication(log, application) {
    const message = application.message ?? globalThis.game?.messages?.get?.(application.messageId) ?? null;
    const source = message ? this.findParticipantForSpeaker(log, message.speaker) : null;
    const action = message && typeof this.adapter.describeAction === "function" ? this.adapter.describeAction(message) : {};
    const rollEvent = application.messageId ? (log.events ?? []).find((event) => event.source?.id === application.messageId && String(event.type).startsWith("roll.")) : null;
    return { source, action, messageId: application.messageId, rollEventId: rollEvent?.id ?? null };
  }

  applySystemAttribution(event, application) {
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

  async detectOfflineDeltas(log, combat) {
    log.latestSnapshots ??= {};
    for (const combatant of combat?.combatants ?? []) {
      const actor = combatant.actor;
      if (!actor) continue;
      const participant = log.participants.find((entry) => entry.combatantId === combatant.id);
      if (!participant) continue;
      const resourcePaths = this.adapter.getResourcePaths();
      const previous = log.latestSnapshots[participant.combatantId];
      const current = this.adapter.snapshotResources(actor, resourcePaths);
      log.latestSnapshots[participant.combatantId] = current;
      if (!previous) continue;
      for (const path of resourcePaths) {
        const oldValue = Number(previous[path]);
        const newValue = Number(current[path]);
        if (!Number.isFinite(oldValue) || !Number.isFinite(newValue) || oldValue === newValue) continue;
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
            resourcePath: path,
            oldValue,
            newValue,
            delta: newValue - oldValue,
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

  findLogForMessage(message) {
    const logs = Array.from(this.activeLogs.values());
    const bySpeaker = logs.find((log) => this.findParticipantForSpeaker(log, message?.speaker));
    if (bySpeaker) return bySpeaker;
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
    log.computed = CombatStatsService.compute(log, {
      includeUnclearDeltasInStats: getSetting(SETTINGS.INCLUDE_UNCLEAR_DELTAS_IN_STATS, false),
      defaultDprMethod: getSetting(SETTINGS.DEFAULT_DPR_METHOD, "appliedNet")
    });
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
    for (const log of logs) await this.persistence.saveLog(log);
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

function isControlEffect(statuses, actor) {
  const control = statuses.filter((status) => CONTROL_STATUSES.includes(status));
  if (!control.length) return false;
  // Unconscious at 0 hit points is the result of damage, not a control effect.
  const hp = Number(getProperty(actor, "system.attributes.hp.value"));
  if (control.every((status) => status === "unconscious") && Number.isFinite(hp) && hp <= 0) return false;
  return true;
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
