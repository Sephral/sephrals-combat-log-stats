import { CONFIDENCE, DPR_METHODS, EVENT_TYPES, RESOURCE_INTERPRETATIONS, SIDES } from "../constants.js";

function emptyBucket(id = "") {
  return {
    id,
    name: "",
    side: SIDES.UNKNOWN,
    roundsActive: 0,
    damageRolled: 0,
    damageAppliedGross: 0,
    damageCorrectionsUp: 0,
    damageCorrectionsDown: 0,
    damageAppliedNet: 0,
    damageTakenGross: 0,
    damageTakenNet: 0,
    healingRolled: 0,
    healingAppliedGross: 0,
    healingCorrectionsUp: 0,
    healingCorrectionsDown: 0,
    healingNet: 0,
    crits: 0,
    fumbles: 0,
    unclearEvents: 0,
    manualEvents: 0,
    ignoredEvents: 0,
    netDPR: 0
  };
}

function addDamage(bucket, amount, { target = false } = {}) {
  if (target) {
    bucket.damageTakenGross += amount;
    bucket.damageTakenNet += amount;
    return;
  }
  bucket.damageAppliedGross += amount;
  bucket.damageAppliedNet += amount;
}

function round(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function eventAmount(event) {
  return Math.abs(Number(event?.data?.amount ?? event?.data?.delta ?? event?.data?.total ?? 0)) || 0;
}

export class CombatStatsService {
  static compute(log, options = {}) {
    const includeUnclear = Boolean(options.includeUnclearDeltasInStats);
    const method = options.defaultDprMethod ?? DPR_METHODS.APPLIED_NET;
    const eventRounds = (log.events ?? []).map((event) => Number(event.round) || 0);
    const roundCount = Math.max(1, Number(log?.rounds ?? 0) || 0, ...eventRounds);
    const byCombatant = new Map((log.participants ?? []).map((participant) => [participant.combatantId, { ...emptyBucket(participant.combatantId), name: participant.name, side: participant.side ?? SIDES.UNKNOWN, roundsActive: roundCount }]));
    const bySide = new Map(Object.values(SIDES).map((side) => [side, { ...emptyBucket(side), name: side, side, roundsActive: roundCount }]));
    const warnings = [];

    const summary = {
      rounds: roundCount,
      turns: (log.events ?? []).filter((event) => event.type === EVENT_TYPES.TURN_CHANGED).length,
      participants: log.participants?.length ?? 0,
      grossDamageRolled: 0,
      grossDamageApplied: 0,
      netDamageApplied: 0,
      damageCorrectionsUp: 0,
      damageCorrectionsDown: 0,
      grossHealingRolled: 0,
      grossHealingApplied: 0,
      netHealingApplied: 0,
      healingCorrectionsUp: 0,
      healingCorrectionsDown: 0,
      unclassifiedDeltas: 0,
      criticalHits: 0,
      criticalFumbles: 0,
      activeDurationMs: activeDuration(log),
      sessionCount: log.sessionSegments?.length ?? 0
    };

    for (const event of log.events ?? []) {
      const participant = findParticipant(log, event);
      const bucketId = participant?.combatantId ?? event.combatantId ?? "";
      const bucket = byCombatant.get(bucketId) ?? emptyBucket(bucketId);
      const targetBucket = targetBucketForEvent(log, byCombatant, event, bucketId);
      let shouldStoreBucket = Boolean(bucketId);
      if (participant) {
        bucket.name ||= participant.name;
        bucket.side = participant.side ?? bucket.side;
      }
      if (event.ignored) {
        if (shouldStoreBucket) bucket.ignoredEvents += 1;
        continue;
      }
      if (event.confidence === CONFIDENCE.UNCLEAR && !includeUnclear) {
        if (event.type === EVENT_TYPES.RESOURCE_DELTA || event.type === EVENT_TYPES.RESOURCE_DELTA_OFFLINE || event.type.startsWith("damage.")) summary.unclassifiedDeltas += 1;
        if (shouldStoreBucket) bucket.unclearEvents += 1;
        continue;
      }
      if (event.confidence === CONFIDENCE.MANUAL && shouldStoreBucket) bucket.manualEvents += 1;

      const amount = eventAmount(event);
      switch (event.type) {
        case EVENT_TYPES.ROLL_DAMAGE:
          summary.grossDamageRolled += amount;
          bucket.damageRolled += amount;
          break;
        case EVENT_TYPES.ROLL_HEALING:
          summary.grossHealingRolled += amount;
          bucket.healingRolled += amount;
          break;
        case EVENT_TYPES.DAMAGE_APPLIED:
        case EVENT_TYPES.DAMAGE_MANUAL_ADDED:
          summary.grossDamageApplied += amount;
          summary.netDamageApplied += amount;
          addDamage(bucket, amount);
          if (targetBucket && targetBucket.id !== bucket.id) addDamage(targetBucket, amount, { target: true });
          break;
        case EVENT_TYPES.DAMAGE_CORRECTED_UP:
          summary.damageCorrectionsUp += amount;
          summary.netDamageApplied += amount;
          bucket.damageCorrectionsUp += amount;
          bucket.damageAppliedNet += amount;
          break;
        case EVENT_TYPES.DAMAGE_CORRECTED_DOWN:
        case EVENT_TYPES.DAMAGE_MANUAL_REDUCED:
          summary.damageCorrectionsDown += amount;
          summary.netDamageApplied -= amount;
          bucket.damageCorrectionsDown += amount;
          bucket.damageAppliedNet -= amount;
          break;
        case EVENT_TYPES.HEALING_APPLIED:
        case EVENT_TYPES.HEALING_MANUAL_ADDED:
          summary.grossHealingApplied += amount;
          summary.netHealingApplied += amount;
          bucket.healingAppliedGross += amount;
          bucket.healingNet += amount;
          break;
        case EVENT_TYPES.HEALING_CORRECTED_UP:
          summary.healingCorrectionsUp += amount;
          summary.netHealingApplied += amount;
          bucket.healingCorrectionsUp += amount;
          bucket.healingNet += amount;
          break;
        case EVENT_TYPES.HEALING_CORRECTED_DOWN:
        case EVENT_TYPES.HEALING_MANUAL_REDUCED:
          summary.healingCorrectionsDown += amount;
          summary.netHealingApplied -= amount;
          bucket.healingCorrectionsDown += amount;
          bucket.healingNet -= amount;
          break;
        case EVENT_TYPES.RESOURCE_DELTA:
        case EVENT_TYPES.RESOURCE_DELTA_OFFLINE:
          applyResourceDelta(event, summary, bucket);
          if (targetBucket && targetBucket.id !== bucket.id && event.data?.interpretedAs === RESOURCE_INTERPRETATIONS.DAMAGE) addDamage(targetBucket, amount, { target: true });
          break;
        default:
          break;
      }
      if (shouldStoreBucket) byCombatant.set(bucket.id, bucket);
      if (targetBucket?.id) byCombatant.set(targetBucket.id, targetBucket);
    }

    for (const bucket of byCombatant.values()) {
      bucket.netDPR = round(bucket.damageAppliedNet / (bucket.roundsActive || roundCount || 1));
      const sideBucket = bySide.get(bucket.side) ?? bySide.get(SIDES.UNKNOWN);
      mergeBucket(sideBucket, bucket);
    }

    for (const bucket of bySide.values()) bucket.netDPR = round(bucket.damageAppliedNet / roundCount);
    if (summary.unclassifiedDeltas) warnings.push(`${summary.unclassifiedDeltas} unclear resource changes are excluded from default DPR.`);
    if ((log.events ?? []).some((event) => event.confidence === CONFIDENCE.MANUAL)) warnings.push("Manually classified events are included in net statistics.");

    return {
      summary,
      byCombatant: Array.from(byCombatant.values()),
      byActor: [],
      bySide: Array.from(bySide.values()),
      dpr: {
        roundCount,
        method,
        partyDPR: round((bySide.get(SIDES.FRIENDLY)?.damageAppliedNet ?? 0) / roundCount),
        enemyDPR: round((bySide.get(SIDES.HOSTILE)?.damageAppliedNet ?? 0) / roundCount),
        neutralDPR: round((bySide.get(SIDES.NEUTRAL)?.damageAppliedNet ?? 0) / roundCount),
        unknownDPR: round((bySide.get(SIDES.UNKNOWN)?.damageAppliedNet ?? 0) / roundCount),
        byCombatant: Array.from(byCombatant.values()),
        byActor: [],
        bySide: Array.from(bySide.values()),
        warnings
      },
      warnings,
      confidenceSummary: confidenceSummary(log.events ?? [])
    };
  }
}

function findParticipant(log, event) {
  return (log.participants ?? []).find((entry) => {
    if (entry.combatantId && event.combatantId && entry.combatantId === event.combatantId) return true;
    if (entry.actorUuid && event.actorUuid && entry.actorUuid === event.actorUuid) return true;
    return false;
  });
}

function targetBucketForEvent(log, byCombatant, event, sourceBucketId) {
  const targetParticipant = (log.participants ?? []).find((entry) => {
    if (entry.combatantId && event.data?.targetCombatantId && entry.combatantId === event.data.targetCombatantId) return true;
    if (entry.actorUuid && event.data?.targetActorUuid && entry.actorUuid === event.data.targetActorUuid) return true;
    if (entry.tokenUuid && event.data?.targetTokenUuid && entry.tokenUuid === event.data.targetTokenUuid) return true;
    return false;
  });
  const targetId = targetParticipant?.combatantId ?? event.data?.targetCombatantId ?? "";
  if (!targetId || targetId === sourceBucketId) return null;
  const bucket = byCombatant.get(targetId) ?? emptyBucket(targetId);
  if (targetParticipant) {
    bucket.name ||= targetParticipant.name;
    bucket.side = targetParticipant.side ?? bucket.side;
  }
  return bucket;
}

function applyResourceDelta(event, summary, bucket) {
  const amount = eventAmount(event);
  switch (event.data?.interpretedAs) {
    case RESOURCE_INTERPRETATIONS.DAMAGE:
      summary.grossDamageApplied += amount;
      summary.netDamageApplied += amount;
      addDamage(bucket, amount);
      break;
    case RESOURCE_INTERPRETATIONS.HEALING:
      summary.grossHealingApplied += amount;
      summary.netHealingApplied += amount;
      bucket.healingAppliedGross += amount;
      bucket.healingNet += amount;
      break;
    case RESOURCE_INTERPRETATIONS.CORRECTION_DAMAGE_UP:
      summary.damageCorrectionsUp += amount;
      summary.netDamageApplied += amount;
      bucket.damageCorrectionsUp += amount;
      bucket.damageAppliedNet += amount;
      break;
    case RESOURCE_INTERPRETATIONS.CORRECTION_DAMAGE_DOWN:
      summary.damageCorrectionsDown += amount;
      summary.netDamageApplied -= amount;
      bucket.damageCorrectionsDown += amount;
      bucket.damageAppliedNet -= amount;
      break;
    case RESOURCE_INTERPRETATIONS.CORRECTION_HEALING_UP:
      summary.healingCorrectionsUp += amount;
      summary.netHealingApplied += amount;
      bucket.healingCorrectionsUp += amount;
      bucket.healingNet += amount;
      break;
    case RESOURCE_INTERPRETATIONS.CORRECTION_HEALING_DOWN:
      summary.healingCorrectionsDown += amount;
      summary.netHealingApplied -= amount;
      bucket.healingCorrectionsDown += amount;
      bucket.healingNet -= amount;
      break;
    case RESOURCE_INTERPRETATIONS.IGNORED:
      break;
    default:
      summary.unclassifiedDeltas += 1;
      bucket.unclearEvents += 1;
      break;
  }
}

function mergeBucket(target, source) {
  for (const key of ["damageRolled", "damageAppliedGross", "damageCorrectionsUp", "damageCorrectionsDown", "damageAppliedNet", "damageTakenGross", "damageTakenNet", "healingRolled", "healingAppliedGross", "healingCorrectionsUp", "healingCorrectionsDown", "healingNet", "crits", "fumbles", "unclearEvents", "manualEvents", "ignoredEvents"]) {
    target[key] += source[key] ?? 0;
  }
}

function confidenceSummary(events) {
  const summary = { safe: 0, probable: 0, unclear: 0, manual: 0, unsupported: 0 };
  for (const event of events) {
    if (event.confidence in summary) summary[event.confidence] += 1;
  }
  return summary;
}

function activeDuration(log) {
  return (log.sessionSegments ?? []).reduce((total, segment) => {
    const start = new Date(segment.startedAt).getTime();
    const end = new Date(segment.endedAt ?? log.endedAt ?? Date.now()).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return total;
    return total + (end - start);
  }, 0);
}

export const __test__ = { applyResourceDelta, findParticipant };
