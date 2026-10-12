import { CONFIDENCE, DPR_METHODS, EVENT_TYPES, RESOURCE_INTERPRETATIONS, SIDES } from "../constants.js";
import {
  ACTION_KINDS, actionKind, eventAmount, isControl, isCritical, isDamageDealt, isDowned, isFumble, isHealingGiven,
  isResourceDelta, isStatEvent, sourceCombatantId, targetCombatantId
} from "./event-insights.js";

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
    healingReceived: 0,
    martial: 0,
    ranged: 0,
    magic: 0,
    control: 0,
    downed: 0,
    takedowns: 0,
    crits: 0,
    fumbles: 0,
    unclearEvents: 0,
    manualEvents: 0,
    ignoredEvents: 0,
    netDPR: 0
  };
}

const SUM_KEYS = ["damageRolled", "damageAppliedGross", "damageCorrectionsUp", "damageCorrectionsDown", "damageAppliedNet", "damageTakenGross", "damageTakenNet", "healingRolled", "healingAppliedGross", "healingCorrectionsUp", "healingCorrectionsDown", "healingNet", "healingReceived", "martial", "ranged", "magic", "control", "downed", "takedowns", "crits", "fumbles", "unclearEvents", "manualEvents", "ignoredEvents"];

function round(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

export class CombatStatsService {
  static compute(log, options = {}) {
    const includeUnclear = Boolean(options.includeUnclearDeltasInStats);
    const method = Object.values(DPR_METHODS).includes(options.defaultDprMethod) ? options.defaultDprMethod : DPR_METHODS.APPLIED_NET;
    const eventRounds = (log.events ?? []).map((event) => Number(event.round) || 0);
    const roundCount = Math.max(1, Number(log?.rounds ?? 0) || 0, ...eventRounds);
    const byCombatant = new Map((log.participants ?? []).map((participant) => [participant.combatantId, { ...emptyBucket(participant.combatantId), name: participant.name, side: participant.side ?? SIDES.UNKNOWN, roundsActive: roundCount }]));
    const bySide = new Map(Object.values(SIDES).map((side) => [side, { ...emptyBucket(side), name: side, side, roundsActive: roundCount }]));
    const bucketFor = (id) => {
      if (!id) return null;
      if (!byCombatant.has(id)) byCombatant.set(id, { ...emptyBucket(id), roundsActive: roundCount });
      return byCombatant.get(id);
    };

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
      partyDowned: 0,
      enemiesDefeated: 0,
      activeDurationMs: activeDuration(log),
      sessionCount: log.sessionSegments?.length ?? 0
    };
    let manualStatEvents = 0;

    for (const event of log.events ?? []) {
      const source = bucketFor(sourceCombatantId(event));
      const target = bucketFor(targetCombatantId(event));
      const own = bucketFor(event.combatantId);
      if (event.ignored) {
        if (own) own.ignoredEvents += 1;
        continue;
      }
      if (event.confidence === CONFIDENCE.UNCLEAR && !includeUnclear) {
        if (isResourceDelta(event) || String(event.type).startsWith("damage.") || String(event.type).startsWith("healing.")) {
          summary.unclassifiedDeltas += 1;
          if (target ?? own) (target ?? own).unclearEvents += 1;
        }
        continue;
      }
      if (event.confidence === CONFIDENCE.MANUAL && isStatEvent(event)) {
        manualStatEvents += 1;
        if (own) own.manualEvents += 1;
      }

      const amount = eventAmount(event);
      switch (event.type) {
        case EVENT_TYPES.ROLL_ATTACK:
          if (isCritical(event)) {
            summary.criticalHits += 1;
            if (source) source.crits += 1;
          }
          if (isFumble(event)) {
            summary.criticalFumbles += 1;
            if (source) source.fumbles += 1;
          }
          break;
        case EVENT_TYPES.ROLL_DAMAGE:
          summary.grossDamageRolled += amount;
          if (source) source.damageRolled += amount;
          break;
        case EVENT_TYPES.ROLL_HEALING:
          summary.grossHealingRolled += amount;
          if (source) source.healingRolled += amount;
          break;
        case EVENT_TYPES.DAMAGE_APPLIED:
        case EVENT_TYPES.DAMAGE_MANUAL_ADDED:
          summary.grossDamageApplied += amount;
          summary.netDamageApplied += amount;
          addDamage(source, target, amount);
          break;
        case EVENT_TYPES.DAMAGE_CORRECTED_UP:
          summary.damageCorrectionsUp += amount;
          summary.netDamageApplied += amount;
          if (source) {
            source.damageCorrectionsUp += amount;
            source.damageAppliedNet += amount;
          }
          break;
        case EVENT_TYPES.DAMAGE_CORRECTED_DOWN:
        case EVENT_TYPES.DAMAGE_MANUAL_REDUCED:
          summary.damageCorrectionsDown += amount;
          summary.netDamageApplied -= amount;
          if (source) {
            source.damageCorrectionsDown += amount;
            source.damageAppliedNet -= amount;
          }
          if (target) target.damageTakenNet -= amount;
          break;
        case EVENT_TYPES.HEALING_APPLIED:
        case EVENT_TYPES.HEALING_MANUAL_ADDED:
          summary.grossHealingApplied += amount;
          summary.netHealingApplied += amount;
          addHealing(source, target, amount);
          break;
        case EVENT_TYPES.HEALING_CORRECTED_UP:
          summary.healingCorrectionsUp += amount;
          summary.netHealingApplied += amount;
          if (source) {
            source.healingCorrectionsUp += amount;
            source.healingNet += amount;
          }
          break;
        case EVENT_TYPES.HEALING_CORRECTED_DOWN:
        case EVENT_TYPES.HEALING_MANUAL_REDUCED:
          summary.healingCorrectionsDown += amount;
          summary.netHealingApplied -= amount;
          if (source) {
            source.healingCorrectionsDown += amount;
            source.healingNet -= amount;
          }
          if (target) target.healingReceived -= amount;
          break;
        case EVENT_TYPES.RESOURCE_DELTA:
        case EVENT_TYPES.RESOURCE_DELTA_OFFLINE:
          applyResourceDelta(event, summary, source, target, amount);
          break;
        default:
          break;
      }

      if (isDamageDealt(event) && source) {
        const kind = actionKind(event);
        if (kind === ACTION_KINDS.MELEE) source.martial += 1;
        if (kind === ACTION_KINDS.RANGED) source.ranged += 1;
        if (kind === ACTION_KINDS.SPELL) source.magic += 1;
      }
      if (isControl(event) && source) source.control += 1;
      if (isDowned(event) && target) {
        target.downed += 1;
        if (target.side === SIDES.FRIENDLY) summary.partyDowned += 1;
        if (target.side === SIDES.HOSTILE) summary.enemiesDefeated += 1;
        if (source && source.id !== target.id) source.takedowns += 1;
      }
    }

    for (const bucket of byCombatant.values()) {
      bucket.netDPR = round(dprValue(bucket, method) / (bucket.roundsActive || roundCount || 1));
      mergeBucket(bySide.get(bucket.side) ?? bySide.get(SIDES.UNKNOWN), bucket);
    }
    for (const bucket of bySide.values()) bucket.netDPR = round(dprValue(bucket, method) / roundCount);

    // Counts only; the window words them in the language the GM uses when looking at them.
    const warningCounts = {};
    if (summary.unclassifiedDeltas) warningCounts.unclearExcluded = summary.unclassifiedDeltas;
    if (manualStatEvents) warningCounts.manualIncluded = manualStatEvents;
    const warningCodes = Object.keys(warningCounts);

    const combatantRows = Array.from(byCombatant.values()).filter((bucket) => bucket.name || (log.participants ?? []).some((participant) => participant.combatantId === bucket.id));
    return {
      summary,
      byCombatant: combatantRows,
      bySide: Array.from(bySide.values()),
      dpr: {
        roundCount,
        method,
        partyDPR: bySide.get(SIDES.FRIENDLY)?.netDPR ?? 0,
        enemyDPR: bySide.get(SIDES.HOSTILE)?.netDPR ?? 0,
        neutralDPR: bySide.get(SIDES.NEUTRAL)?.netDPR ?? 0,
        unknownDPR: bySide.get(SIDES.UNKNOWN)?.netDPR ?? 0,
        byCombatant: combatantRows,
        bySide: Array.from(bySide.values())
      },
      warningCounts,
      warningCodes,
      confidenceSummary: confidenceSummary(log.events ?? [])
    };
  }
}

function addDamage(source, target, amount) {
  if (source) {
    source.damageAppliedGross += amount;
    source.damageAppliedNet += amount;
  }
  if (target && target !== source) {
    target.damageTakenGross += amount;
    target.damageTakenNet += amount;
  }
}

function addHealing(source, target, amount) {
  if (source) {
    source.healingAppliedGross += amount;
    source.healingNet += amount;
  }
  if (target) target.healingReceived += amount;
}

function applyResourceDelta(event, summary, source, target, amount) {
  switch (event.data?.interpretedAs) {
    case RESOURCE_INTERPRETATIONS.DAMAGE:
      summary.grossDamageApplied += amount;
      summary.netDamageApplied += amount;
      addDamage(isDamageDealt(event) ? source : null, target, amount);
      break;
    case RESOURCE_INTERPRETATIONS.HEALING:
      summary.grossHealingApplied += amount;
      summary.netHealingApplied += amount;
      // Healing without a known healer only counts as received.
      addHealing(isHealingGiven(event) ? source : null, target, amount);
      break;
    case RESOURCE_INTERPRETATIONS.CORRECTION_DAMAGE_UP:
      summary.damageCorrectionsUp += amount;
      summary.netDamageApplied += amount;
      if (source) {
        source.damageCorrectionsUp += amount;
        source.damageAppliedNet += amount;
      }
      break;
    case RESOURCE_INTERPRETATIONS.CORRECTION_DAMAGE_DOWN:
      summary.damageCorrectionsDown += amount;
      summary.netDamageApplied -= amount;
      if (source) {
        source.damageCorrectionsDown += amount;
        source.damageAppliedNet -= amount;
      }
      break;
    case RESOURCE_INTERPRETATIONS.CORRECTION_HEALING_UP:
      summary.healingCorrectionsUp += amount;
      summary.netHealingApplied += amount;
      if (source) {
        source.healingCorrectionsUp += amount;
        source.healingNet += amount;
      }
      break;
    case RESOURCE_INTERPRETATIONS.CORRECTION_HEALING_DOWN:
      summary.healingCorrectionsDown += amount;
      summary.netHealingApplied -= amount;
      if (source) {
        source.healingCorrectionsDown += amount;
        source.healingNet -= amount;
      }
      break;
    case RESOURCE_INTERPRETATIONS.IGNORED:
    case RESOURCE_INTERPRETATIONS.TEMP_HP_GAIN:
    case RESOURCE_INTERPRETATIONS.TEMP_HP_LOSS:
    case RESOURCE_INTERPRETATIONS.MAX_HP_CHANGE:
      break;
    default:
      summary.unclassifiedDeltas += 1;
      if (target) target.unclearEvents += 1;
      break;
  }
}

function dprValue(bucket, method) {
  if (method === DPR_METHODS.ROLLED) return bucket.damageRolled;
  if (method === DPR_METHODS.APPLIED_GROSS) return bucket.damageAppliedGross;
  return bucket.damageAppliedNet;
}

function mergeBucket(target, source) {
  for (const key of SUM_KEYS) target[key] += source[key] ?? 0;
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

export const __test__ = { applyResourceDelta, dprValue };
