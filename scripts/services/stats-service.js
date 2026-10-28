import { ACTION_STATUS, CONFIDENCE, DPR_METHODS, EVENT_TYPES, RESOURCE_INTERPRETATIONS, SIDES } from "../constants.js";
import {
  ACTION_KINDS, actionKind, downTracker, eventAmount, isControl, isCritical, isDamageDealt, isFumble, isHealingGiven,
  isMoraleEvent, isOpenAction, isResourceDelta, isStatEvent, isUndone, reversedCardMessageIds, sourceCombatantId, targetCombatantId
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
    // Side rows only: damage and healing without a known source, credited to the side that must have done it.
    damageUnknownSource: 0,
    healingUnknownSource: 0,
    // Crucible: morale and madness, counted apart from damage and healing.
    moraleDamageDealt: 0,
    moraleDamageTaken: 0,
    moraleHealing: 0,
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

const SUM_KEYS = ["damageRolled", "damageAppliedGross", "damageCorrectionsUp", "damageCorrectionsDown", "damageAppliedNet", "damageTakenGross", "damageTakenNet", "healingRolled", "healingAppliedGross", "healingCorrectionsUp", "healingCorrectionsDown", "healingNet", "healingReceived", "moraleDamageDealt", "moraleDamageTaken", "moraleHealing", "martial", "ranged", "magic", "control", "downed", "takedowns", "crits", "fumbles", "unclearEvents", "manualEvents", "ignoredEvents"];

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
      moraleDamageApplied: 0,
      moraleHealingApplied: 0,
      openActions: 0,
      unclassifiedDeltas: 0,
      criticalHits: 0,
      criticalFumbles: 0,
      partyDowned: 0,
      enemiesDefeated: 0,
      activeDurationMs: activeDuration(log),
      sessionCount: log.sessionSegments?.length ?? 0
    };
    let manualStatEvents = 0;
    // Damage and healing per round and side, read from the same changes as the totals.
    const rounds = new Map();
    const roundRow = (number) => {
      if (!rounds.has(number)) rounds.set(number, { round: number, partyDamage: 0, enemyDamage: 0, partyHealing: 0, enemyHealing: 0 });
      return rounds.get(number);
    };
    // Undone action cards (Crucible) keep their numbers in balance through the reversal, but are no hit and no critical.
    const undoneCards = reversedCardMessageIds(log.events ?? []);
    // A combatant goes down once until it is back up (Crucible: broken, then dead, is one defeat).
    const freshDown = downTracker();
    // What each combatant added per round, so a reduction can be taken back where the damage was done.
    const sourceRounds = new Map();
    const reductions = [];
    // Damage to an enemy whose source is unknown was still dealt by the party, and the other way round.
    const unknownSource = { [SIDES.FRIENDLY]: { damage: 0, healing: 0 }, [SIDES.HOSTILE]: { damage: 0, healing: 0 } };
    let hitsWithoutSource = 0;

    for (const event of log.events ?? []) {
      const source = bucketFor(sourceCombatantId(event));
      const target = bucketFor(targetCombatantId(event));
      const own = bucketFor(event.combatantId);
      if (event.ignored) {
        if (own) own.ignoredEvents += 1;
        continue;
      }
      // The generic adapter files every attack roll as unclear. An attack roll only adds critical hits and fumbles,
      // no hit points, so it counts without the setting for unclear hit point changes.
      if (event.confidence === CONFIDENCE.UNCLEAR && !includeUnclear && event.type !== EVENT_TYPES.ROLL_ATTACK) {
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
      const unknown = unknownSourceShare(event, source, target, amount);
      if (unknown) {
        unknownSource[unknown.side][unknown.kind] += unknown.amount;
        if (unknown.kind === "damage" && unknown.amount > 0) hitsWithoutSource += 1;
        const roundNumber = Number(event.round) || 0;
        if (roundNumber > 0) roundRow(roundNumber)[`${unknown.side === SIDES.FRIENDLY ? "party" : "enemy"}${unknown.kind === "damage" ? "Damage" : "Healing"}`] += unknown.amount;
      }
      const damageBefore = source?.damageAppliedNet ?? 0;
      const healingBefore = source?.healingNet ?? 0;
      switch (event.type) {
        case EVENT_TYPES.ACTION_USED:
          // An action card counts as rolled damage, like a damage roll in other systems. Deleted cards never happened.
          if (event.data?.status === ACTION_STATUS.DELETED) break;
          if (isOpenAction(event)) summary.openActions += 1;
          summary.grossDamageRolled += Number(event.data?.plannedDamage) || 0;
          summary.grossHealingRolled += Number(event.data?.plannedHealing) || 0;
          if (source) {
            source.damageRolled += Number(event.data?.plannedDamage) || 0;
            source.healingRolled += Number(event.data?.plannedHealing) || 0;
          }
          break;
        case EVENT_TYPES.ROLL_ATTACK:
          if (isUndone(event, undoneCards)) break;
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

      const roundNumber = Number(event.round) || 0;
      if (source && roundNumber > 0 && (source.side === SIDES.FRIENDLY || source.side === SIDES.HOSTILE)) {
        const party = source.side === SIDES.FRIENDLY;
        for (const [kind, change] of [["Damage", source.damageAppliedNet - damageBefore], ["Healing", source.healingNet - healingBefore]]) {
          if (!change) continue;
          const key = `${party ? "party" : "enemy"}${kind}`;
          if (change < 0) {
            reductions.push({ id: source.id, key, round: roundNumber, amount: -change });
            continue;
          }
          roundRow(roundNumber)[key] += change;
          const own = sourceRounds.get(`${source.id}|${key}`) ?? new Map();
          own.set(roundNumber, (own.get(roundNumber) ?? 0) + change);
          sourceRounds.set(`${source.id}|${key}`, own);
        }
      }

      // The morale part of a hit that also cost health is the same hit.
      if (isDamageDealt(event) && source && !event.data?.secondary && !isUndone(event)) {
        const kind = actionKind(event);
        if (kind === ACTION_KINDS.MELEE) source.martial += 1;
        if (kind === ACTION_KINDS.RANGED) source.ranged += 1;
        if (kind === ACTION_KINDS.SPELL) source.magic += 1;
      }
      if (isControl(event) && source) source.control += 1;
      if (freshDown(event) && target) {
        target.downed += 1;
        if (target.side === SIDES.FRIENDLY) summary.partyDowned += 1;
        if (target.side === SIDES.HOSTILE) summary.enemiesDefeated += 1;
        if (source && source.id !== target.id) source.takedowns += 1;
      }
    }

    // A correction down or a manual reduction (added after the fight, filed under the last round) takes the
    // damage or healing back from the rounds in which that combatant did it, latest first. No round goes below 0
    // unless more is taken back than was ever counted.
    for (const reduction of reductions) {
      const own = sourceRounds.get(`${reduction.id}|${reduction.key}`) ?? new Map();
      let rest = reduction.amount;
      for (const number of Array.from(own.keys()).filter((round) => round <= reduction.round).sort((left, right) => right - left)) {
        const taken = Math.min(rest, own.get(number));
        own.set(number, own.get(number) - taken);
        roundRow(number)[reduction.key] -= taken;
        rest -= taken;
        if (rest <= 0) break;
      }
      if (rest > 0) roundRow(reduction.round)[reduction.key] -= rest;
    }

    for (const bucket of byCombatant.values()) {
      bucket.netDPR = round(dprValue(bucket, method) / (bucket.roundsActive || roundCount || 1));
      mergeBucket(bySide.get(bucket.side) ?? bySide.get(SIDES.UNKNOWN), bucket);
    }
    for (const [side, share] of Object.entries(unknownSource)) {
      const bucket = bySide.get(side);
      bucket.damageUnknownSource = share.damage;
      bucket.damageAppliedGross += share.damage;
      bucket.damageAppliedNet += share.damage;
      bucket.healingUnknownSource = share.healing;
      bucket.healingAppliedGross += share.healing;
      bucket.healingNet += share.healing;
    }
    for (const bucket of bySide.values()) bucket.netDPR = round(dprValue(bucket, method) / roundCount);

    // Counts only; the window words them in the language the GM uses when looking at them.
    const warningCounts = {};
    if (summary.unclassifiedDeltas) warningCounts.unclearExcluded = summary.unclassifiedDeltas;
    if (manualStatEvents) warningCounts.manualIncluded = manualStatEvents;
    if (summary.openActions) warningCounts.openActions = summary.openActions;
    // Many hits without an attacker point to an automation module the log does not know yet.
    if (hitsWithoutSource) warningCounts.unknownSource = hitsWithoutSource;
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
      byRound: Array.from({ length: roundCount }, (_, index) => {
        const row = rounds.get(index + 1) ?? { round: index + 1, partyDamage: 0, enemyDamage: 0, partyHealing: 0, enemyHealing: 0 };
        return { ...row, partyDamage: round(row.partyDamage), enemyDamage: round(row.enemyDamage), partyHealing: round(row.partyHealing), enemyHealing: round(row.enemyHealing) };
      }),
      warningCounts,
      warningCodes,
      confidenceSummary: confidenceSummary(log.events ?? [])
    };
  }
}

// Applied damage or healing (hit points, not morale) whose source is unknown. Damage to a party member came from the
// enemies, damage to an enemy from the party; healing came from the target's own side.
function unknownSourceShare(event, source, target, amount) {
  if (!amount || !target || isMoraleEvent(event) || isUndone(event)) return null;
  const sideOf = (bucket) => [SIDES.FRIENDLY, SIDES.HOSTILE].includes(bucket?.side) ? bucket.side : null;
  const targetSide = sideOf(target);
  if (!targetSide) return null;
  const opposite = targetSide === SIDES.FRIENDLY ? SIDES.HOSTILE : SIDES.FRIENDLY;
  const damage = [EVENT_TYPES.DAMAGE_APPLIED, EVENT_TYPES.DAMAGE_MANUAL_ADDED].includes(event.type)
    || (isResourceDelta(event) && event.data?.interpretedAs === RESOURCE_INTERPRETATIONS.DAMAGE);
  if (damage && !isDamageDealt(event)) return { side: opposite, kind: "damage", amount };
  const healing = [EVENT_TYPES.HEALING_APPLIED, EVENT_TYPES.HEALING_MANUAL_ADDED].includes(event.type)
    || (isResourceDelta(event) && event.data?.interpretedAs === RESOURCE_INTERPRETATIONS.HEALING);
  if (healing && !isHealingGiven(event)) return { side: targetSide, kind: "healing", amount };
  // An undo without a known source takes the amount back from the side it was credited to.
  if (isResourceDelta(event) && event.data?.reversal && !source) {
    if (event.data.interpretedAs === RESOURCE_INTERPRETATIONS.CORRECTION_DAMAGE_DOWN) return { side: opposite, kind: "damage", amount: -amount };
    if (event.data.interpretedAs === RESOURCE_INTERPRETATIONS.CORRECTION_HEALING_DOWN) return { side: targetSide, kind: "healing", amount: -amount };
  }
  return null;
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
  if (isMoraleEvent(event)) {
    applyMoraleDelta(event, summary, source, target, amount);
    return;
  }
  // An undone action card (Crucible) also takes the damage or healing back from the target.
  const reversal = Boolean(event.data?.reversal);
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
      if (reversal && target && target !== source) target.damageTakenNet -= amount;
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
      if (reversal && target) target.healingReceived -= amount;
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

// Morale and madness (Crucible): the same reading as hit points, kept in their own numbers.
function applyMoraleDelta(event, summary, source, target, amount) {
  const reversal = Boolean(event.data?.reversal);
  switch (event.data?.interpretedAs) {
    case RESOURCE_INTERPRETATIONS.DAMAGE: {
      const dealer = isDamageDealt(event) ? source : null;
      summary.moraleDamageApplied += amount;
      if (dealer) dealer.moraleDamageDealt += amount;
      if (target && target !== dealer) target.moraleDamageTaken += amount;
      break;
    }
    case RESOURCE_INTERPRETATIONS.HEALING:
      summary.moraleHealingApplied += amount;
      if (source && isHealingGiven(event)) source.moraleHealing += amount;
      break;
    case RESOURCE_INTERPRETATIONS.CORRECTION_DAMAGE_UP:
    case RESOURCE_INTERPRETATIONS.CORRECTION_DAMAGE_DOWN: {
      const sign = event.data.interpretedAs === RESOURCE_INTERPRETATIONS.CORRECTION_DAMAGE_UP ? 1 : -1;
      summary.moraleDamageApplied += sign * amount;
      if (source) source.moraleDamageDealt += sign * amount;
      if (reversal && target && target !== source) target.moraleDamageTaken += sign * amount;
      break;
    }
    case RESOURCE_INTERPRETATIONS.CORRECTION_HEALING_UP:
    case RESOURCE_INTERPRETATIONS.CORRECTION_HEALING_DOWN: {
      const sign = event.data.interpretedAs === RESOURCE_INTERPRETATIONS.CORRECTION_HEALING_UP ? 1 : -1;
      summary.moraleHealingApplied += sign * amount;
      if (source) source.moraleHealing += sign * amount;
      break;
    }
    case RESOURCE_INTERPRETATIONS.IGNORED:
      break;
    default:
      summary.unclassifiedDeltas += 1;
      if (target) target.unclearEvents += 1;
      break;
  }
}

// The damage a combatant or side counts toward damage per round, by the chosen basis. Sessions add these up too.
export function dprValue(bucket, method) {
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
