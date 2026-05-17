import { getSystemAdapter } from "../adapters/adapter-registry.js";
import { CONFIDENCE, EVENT_TYPES, HOOKS, LOG_STATUS, RESOURCE_INTERPRETATIONS, SEGMENT_REASONS, SETTINGS, SOURCE_KINDS } from "../constants.js";
import { closeCurrentSegment, createCombatLog, createSessionSegment, snapshotParticipant } from "../models/combat-log.js";
import { getSetting } from "../settings.js";
import { cloneData, debugLog, getProperty, isoNow } from "../utils.js";
import { CombatEventLedger } from "./event-ledger.js";
import { CombatLogPersistenceService } from "./persistence-service.js";
import { CombatStatsService } from "./stats-service.js";
import { CorrelationService } from "./correlation-service.js";
import { PlayerReportService } from "./player-report-service.js";

export class CombatLogService {
  constructor() {
    this.persistence = new CombatLogPersistenceService();
    this.activeLogs = new Map();
    this.actorSnapshots = new Map();
    this.correlation = new CorrelationService({ windowMs: getSetting(SETTINGS.RESOURCE_DELTA_WINDOW_MS, 3000) });
    this.playerReports = new PlayerReportService();
  }

  get adapter() {
    return getSystemAdapter(game?.system?.id ?? "generic");
  }

  async ready() {
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
    this.captureActorSnapshots(combat);
    await this.detectOfflineDeltas(log, combat);
    return this.saveAndCompute(log);
  }

  findCombatForLog(log) {
    return game?.combats?.contents?.find((combat) => combat.id === log.combatId || combat.uuid === log.combatUuid) ?? null;
  }

  async startCombat(combat) {
    if (!combat || !getSetting(SETTINGS.ENABLE_AUTO_TRACKING, true)) return null;
    const existing = this.activeLogs.get(combat.id);
    if (existing) return existing;
    const log = createCombatLog(combat, this.adapter);
    new CombatEventLedger(log).combatStarted(combat);
    this.activeLogs.set(combat.id, log);
    this.captureActorSnapshots(combat);
    return this.saveAndCompute(log);
  }

  async endCombat(combat, reason = SEGMENT_REASONS.COMBAT_ENDED) {
    const log = this.activeLogs.get(combat?.id);
    if (!log) return null;
    const now = isoNow();
    closeCurrentSegment(log, reason, now);
    log.status = LOG_STATUS.ENDED;
    log.endedAt = now;
    new CombatEventLedger(log).combatEvent(EVENT_TYPES.COMBAT_ENDED, combat, { reason });
    this.updateFinalResources(log);
    this.activeLogs.delete(combat.id);
    await this.saveAndCompute(log);
    await this.runEndOfCombatReports(log);
    return this.saveAndCompute(log);
  }

  async runEndOfCombatReports(log) {
    if (!this.playerReports.canShare(log)) return;
    if (getSetting(SETTINGS.AUTO_POST_PLAYER_SUMMARY_ON_END, false)) await this.playerReports.postChatSummary(log);
    if (getSetting(SETTINGS.AUTO_EXPORT_JOURNAL_ON_END, false)) await this.playerReports.createJournalReport(log);
  }

  async deleteCombat(combat) {
    const log = this.activeLogs.get(combat?.id);
    if (!log) return null;
    log.status = LOG_STATUS.ORPHANED;
    log.lastSeenAt = isoNow();
    new CombatEventLedger(log).combatEvent(EVENT_TYPES.COMBAT_DELETED, combat, {});
    this.activeLogs.delete(combat.id);
    return this.saveAndCompute(log);
  }

  async updateCombat(combat, changed = {}) {
    const log = await this.ensureLogForCombat(combat);
    if (!log) return null;
    const ledger = new CombatEventLedger(log);
    if ("round" in changed) ledger.combatEvent(EVENT_TYPES.ROUND_CHANGED, combat, { oldValue: changed.round, newValue: combat.round });
    if ("turn" in changed) ledger.combatEvent(EVENT_TYPES.TURN_CHANGED, combat, { oldValue: changed.turn, newValue: combat.turn });
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
    log.participants.push(snapshotParticipant(combatant, this.adapter));
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
    const log = await this.ensureLogForCombat(combat);
    if (!log) return null;
    const participant = log.participants.find((entry) => entry.combatantId === combatant.id);
    if (participant) Object.assign(participant, snapshotParticipant(combatant, this.adapter), { initialResources: participant.initialResources });
    new CombatEventLedger(log).append({
      type: EVENT_TYPES.COMBATANT_UPDATED,
      combatantId: combatant.id,
      actorUuid: combatant.actor?.uuid ?? "",
      tokenUuid: combatant.token?.uuid ?? "",
      round: combat?.round ?? null,
      turn: combat?.turn ?? null,
      source: { kind: SOURCE_KINDS.HOOK, id: combatant.id },
      confidence: CONFIDENCE.SAFE,
      data: { changed }
    });
    return this.saveAndCompute(log);
  }

  async combatantRemoved(combatant) {
    const combat = combatant?.combat ?? game?.combat;
    const log = await this.ensureLogForCombat(combat);
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

  async chatMessageCreated(message) {
    if (!getSetting(SETTINGS.TRACK_CHAT_MESSAGES, true)) return null;
    const log = this.findLogForMessage(message);
    if (!log) return null;
    const combat = this.findCombatForLog(log);
    const ledger = new CombatEventLedger(log);
    ledger.append({
      type: EVENT_TYPES.CHAT_MESSAGE_CREATED,
      round: combat?.round ?? null,
      turn: combat?.turn ?? null,
      actorUuid: message?.speaker?.actor ? `Actor.${message.speaker.actor}` : "",
      tokenUuid: message?.speaker?.token ? `Scene.${message.speaker.scene}.Token.${message.speaker.token}` : "",
      userId: message?.user?.id ?? message?._source?.user ?? "",
      visibility: message?.whisper?.length ? "gm" : "public",
      source: { kind: SOURCE_KINDS.CHAT_MESSAGE, id: message.id },
      confidence: CONFIDENCE.SAFE,
      data: { content: message.content, flavor: message.flavor, speaker: message.speaker }
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
        actorUuid: message?.speaker?.actor ? `Actor.${message.speaker.actor}` : "",
        tokenUuid: message?.speaker?.token ? `Scene.${message.speaker.scene}.Token.${message.speaker.token}` : "",
        userId: message?.user?.id ?? message?._source?.user ?? "",
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
      events.push(ledger.append({
        type: application.type,
        round: combat?.round ?? null,
        turn: combat?.turn ?? null,
        combatantId: sourceParticipant?.combatantId ?? target?.combatantId ?? "",
        actorUuid: sourceParticipant?.actorUuid ?? "",
        tokenUuid: sourceParticipant?.tokenUuid ?? "",
        userId: message?.user?.id ?? message?._source?.user ?? "",
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

  async actorUpdated(actor, changed = {}, options = {}, userId = game?.user?.id) {
    if (!getSetting(SETTINGS.TRACK_RESOURCE_DELTAS, true)) return null;
    const matchingLogs = this.findLogsForActor(actor);
    if (!matchingLogs.length) return null;
    const before = this.actorSnapshots.get(actor.uuid) ?? actorDataSnapshot(actor);
    const after = actorDataSnapshot(actor);
    const resourcePaths = getSetting(SETTINGS.RESOURCE_PATHS, {})?.[game?.system?.id] ?? this.adapter.getResourcePaths();
    const deltas = this.adapter.detectResourceDeltas(before, after, resourcePaths);
    this.actorSnapshots.set(actor.uuid, after);
    if (!deltas.length) return null;

    for (const log of matchingLogs) {
      const combat = this.findCombatForLog(log);
      const participant = log.participants.find((entry) => entry.actorUuid === actor.uuid || entry.actorId === actor.id);
      for (const delta of deltas) {
        const event = new CombatEventLedger(log).append({
          type: EVENT_TYPES.RESOURCE_DELTA,
          round: combat?.round ?? null,
          turn: combat?.turn ?? null,
          combatantId: participant?.combatantId ?? "",
          actorUuid: actor.uuid,
          userId,
          source: { kind: SOURCE_KINDS.ACTOR_UPDATE, id: actor.id },
          confidence: delta.confidence,
          data: { ...delta, initiatorUserId: userId, correlation: null }
        });
        event.data.correlation = this.correlation.correlateResourceDelta(log, event);
        this.applyCorrelatedSourceAttribution(log, event, participant);
        const duplicate = this.findDuplicateAppliedEvent(log, event);
        if (duplicate) {
          event.confidence = CONFIDENCE.SAFE;
          event.data.interpretedAs = RESOURCE_INTERPRETATIONS.IGNORED;
          event.data.duplicateOfEventId = duplicate.id;
          event.data.notes = "Confirmed by actor HP change; already counted from chat application.";
        }
      }
      await this.saveAndCompute(log);
    }
    return matchingLogs;
  }

  async detectOfflineDeltas(log, combat) {
    for (const combatant of combat?.combatants ?? []) {
      const actor = combatant.actor;
      if (!actor) continue;
      const participant = log.participants.find((entry) => entry.combatantId === combatant.id || entry.actorUuid === actor.uuid);
      if (!participant) continue;
      const resourcePaths = this.adapter.getResourcePaths();
      const previous = log.latestSnapshots?.[participant.combatantId] ?? {};
      const current = this.adapter.snapshotResources(actor, resourcePaths);
      for (const path of resourcePaths) {
        const oldValue = getProperty(previous, path) ?? previous[path];
        const newValue = current[path];
        if (oldValue === newValue) continue;
        new CombatEventLedger(log).append({
          type: EVENT_TYPES.RESOURCE_DELTA_OFFLINE,
          round: combat.round ?? null,
          turn: combat.turn ?? null,
          combatantId: participant.combatantId,
          actorUuid: actor.uuid,
          source: { kind: SOURCE_KINDS.RESUME, id: combat.id },
          confidence: CONFIDENCE.UNCLEAR,
          data: { resourcePath: path, oldValue, newValue, delta: Number(newValue) - Number(oldValue), interpretedAs: RESOURCE_INTERPRETATIONS.UNKNOWN, notes: "Detected while resuming an active combat log." }
        });
      }
      log.latestSnapshots[participant.combatantId] = current;
    }
  }

  captureActorSnapshots(combat) {
    for (const combatant of combat?.combatants ?? []) {
      if (combatant.actor?.uuid) this.actorSnapshots.set(combatant.actor.uuid, actorDataSnapshot(combatant.actor));
    }
  }

  updateFinalResources(log) {
    for (const participant of log.participants ?? []) {
      const actor = participant.actorUuid && typeof fromUuidSync === "function" ? fromUuidSync(participant.actorUuid) : null;
      participant.finalResources = actor ? this.adapter.snapshotResources(actor) : log.latestSnapshots?.[participant.combatantId] ?? null;
    }
  }

  findLogForMessage(message) {
    const bySpeaker = Array.from(this.activeLogs.values()).find((log) => this.findParticipantForSpeaker(log, message?.speaker));
    if (bySpeaker) return bySpeaker;
    const speakerActorUuid = message?.speaker?.actor ? `Actor.${message.speaker.actor}` : "";
    if (speakerActorUuid) {
      const speakerActorId = message?.speaker?.actor ?? "";
      const byActor = Array.from(this.activeLogs.values()).find((log) => log.participants.some((participant) => participant.actorUuid === speakerActorUuid || participant.actorId === speakerActorId));
      if (byActor) return byActor;
    }
    return this.activeLogs.get(game?.combat?.id) ?? Array.from(this.activeLogs.values())[0] ?? null;
  }

  findParticipantForSpeaker(log, speaker = {}) {
    const actorUuid = speaker?.actor ? `Actor.${speaker.actor}` : "";
    const tokenUuid = speaker?.token ? `Scene.${speaker.scene}.Token.${speaker.token}` : "";
    const actorId = speaker?.actor ?? "";
    const tokenId = speaker?.token ?? "";
    return (log.participants ?? []).find((participant) => {
      if (actorUuid && participant.actorUuid === actorUuid) return true;
      if (tokenUuid && participant.tokenUuid === tokenUuid) return true;
      if (actorId && participant.actorId === actorId) return true;
      if (tokenId && participant.tokenId === tokenId) return true;
      return false;
    }) ?? null;
  }

  resolveMessageTargets(log, targets = {}) {
    const names = new Set((targets.names ?? []).map(normalizeName).filter(Boolean));
    return (log.participants ?? []).filter((participant) => {
      if ((targets.actorUuids ?? []).includes(participant.actorUuid)) return true;
      if ((targets.tokenUuids ?? []).includes(participant.tokenUuid)) return true;
      if (names.has(normalizeName(participant.name))) return true;
      return false;
    });
  }

  findParticipantForChatApplication(log, application) {
    if (application.targetActorUuid) {
      const byActor = (log.participants ?? []).find((participant) => participant.actorUuid === application.targetActorUuid);
      if (byActor) return byActor;
    }
    if (application.targetTokenUuid) {
      const byToken = (log.participants ?? []).find((participant) => participant.tokenUuid === application.targetTokenUuid);
      if (byToken) return byToken;
    }
    const targetName = normalizeName(application.targetName);
    if (targetName) return (log.participants ?? []).find((participant) => normalizeName(participant.name) === targetName) ?? null;
    return null;
  }

  applyCorrelatedSourceAttribution(log, event, targetParticipant) {
    if (event.data?.correlation?.status !== "correlated") return;
    if (![RESOURCE_INTERPRETATIONS.DAMAGE, RESOURCE_INTERPRETATIONS.HEALING].includes(event.data?.interpretedAs)) return;
    const rollEvent = (log.events ?? []).find((entry) => entry.id === event.data.correlation.rollEventId);
    if (!rollEvent?.combatantId) return;
    event.data.targetCombatantId = targetParticipant?.combatantId ?? event.combatantId ?? "";
    event.data.targetActorUuid = targetParticipant?.actorUuid ?? event.actorUuid ?? "";
    event.data.targetTokenUuid = targetParticipant?.tokenUuid ?? event.tokenUuid ?? "";
    event.data.attribution = "correlatedChatRoll";
    event.combatantId = rollEvent.combatantId;
    event.actorUuid = rollEvent.actorUuid ?? "";
    event.tokenUuid = rollEvent.tokenUuid ?? "";
  }

  findDuplicateAppliedEvent(log, deltaEvent) {
    if (![RESOURCE_INTERPRETATIONS.DAMAGE, RESOURCE_INTERPRETATIONS.HEALING].includes(deltaEvent.data?.interpretedAs)) return null;
    const appliedType = deltaEvent.data.interpretedAs === RESOURCE_INTERPRETATIONS.HEALING ? EVENT_TYPES.HEALING_APPLIED : EVENT_TYPES.DAMAGE_APPLIED;
    const amount = Math.abs(Number(deltaEvent.data?.delta ?? 0)) || 0;
    const targetCombatantId = deltaEvent.data?.targetCombatantId || deltaEvent.combatantId || "";
    const sourceCombatantId = deltaEvent.data?.attribution === "correlatedChatRoll" ? deltaEvent.combatantId || "" : "";
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
    return Array.from(this.activeLogs.values()).filter((log) => log.participants.some((participant) => participant.actorUuid === actor.uuid || participant.actorId === actor.id));
  }

  async saveAndCompute(log) {
    log.computed = CombatStatsService.compute(log, {
      includeUnclearDeltasInStats: getSetting(SETTINGS.INCLUDE_UNCLEAR_DELTAS_IN_STATS, false),
      defaultDprMethod: getSetting(SETTINGS.DEFAULT_DPR_METHOD, "appliedNet")
    });
    await this.persistence.saveLog(log);
    globalThis.Hooks?.callAll?.(HOOKS.LOG_UPDATED, log);
    debugLog("Saved combat log", log.id, log.status, log.events.length);
    return log;
  }

  listActiveLogs() {
    return Array.from(this.activeLogs.values());
  }
}

function actorDataSnapshot(actor) {
  return cloneData(actor?.toObject?.() ?? actor?._source ?? actor ?? {});
}

function normalizeName(value) {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}
