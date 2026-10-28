import { activeLocale, format, localize } from "../utils.js";
import { isCritical, isFumble, isUndone, naturalRollShare, rescueIncidents, reversedCardMessageIds } from "./event-insights.js";

// Awards go to party members only, so a report never names an enemy, hidden or not.
// Every award needs a value above 0. Equal values share the award, unless the tie breaker separates them.
export const AWARDS = Object.freeze([
  { key: "mvp", icon: "fa-solid fa-crown" },
  { key: "healer", icon: "fa-solid fa-heart-pulse" },
  { key: "sponge", icon: "fa-solid fa-shield-halved" },
  { key: "control", icon: "fa-solid fa-hand-sparkles" },
  { key: "takedowns", icon: "fa-solid fa-crosshairs" },
  { key: "clutch", icon: "fa-solid fa-hand-holding-medical" },
  { key: "lucky", icon: "fa-solid fa-clover" },
  { key: "unlucky", icon: "fa-solid fa-cloud-rain" }
]);

// Without any fumble, the unlucky award needs this many tests and an average result in the lower half.
const MIN_ROLLS_FOR_LOW_AVERAGE = 3;

/**
 * @param {object} input
 * @param {{id: string, name: string}[]} input.members   Party members that may win
 * @param {object[]} input.rows      Statistics rows per combatant (computed.byCombatant)
 * @param {object[]} input.events    Events that may be told (rolls for luck, healing for clutch saves)
 * @param {{rolls: Map, rescues: Map}} [input.tallies]  Rolls and rescues already counted per member (a session adds
 *   up the tallies of its fights, whose events know other combatant ids); replaces events
 * @returns {{key: string, icon: string, winners: {id: string, name: string}[], value: number, details: object}[]}
 */
export function computeAwards({ members = [], rows = [], events = [], tallies = null } = {}) {
  const party = members.filter((member) => member?.id);
  if (!party.length) return [];
  const ids = new Set(party.map((member) => member.id));
  const row = (id) => rows.find((entry) => String(entry?.id) === id) ?? {};
  const number = (value) => Math.max(0, Number(value) || 0);
  const { rolls, rescues } = tallies ?? awardTallies(events, ids);

  const awards = [];
  const add = (key, scoreOf, { details = () => ({}), tieBreak = null, eligible = () => true } = {}) => {
    const scored = party.filter(eligible).map((member) => ({ member, score: scoreOf(member) })).filter((entry) => entry.score > 0);
    if (!scored.length) return;
    const top = Math.max(...scored.map((entry) => entry.score));
    let winners = scored.filter((entry) => entry.score === top);
    if (tieBreak && winners.length > 1) {
      const keyed = winners.map((entry) => ({ ...entry, tie: tieBreak(entry.member) })).filter((entry) => entry.tie !== null);
      if (keyed.length) {
        const best = Math.max(...keyed.map((entry) => entry.tie));
        winners = keyed.filter((entry) => entry.tie === best);
      }
    }
    // Shared awards list their winners by name, so the order does not depend on the turn order.
    winners.sort((a, b) => String(a.member.name ?? "").localeCompare(String(b.member.name ?? "")));
    const definition = AWARDS.find((award) => award.key === key);
    awards.push({
      key,
      icon: definition?.icon ?? "fa-solid fa-award",
      winners: winners.map(({ member }) => ({ id: member.id, name: member.name })),
      value: top,
      details: details(winners[0].member)
    });
  };

  // MVP: damage dealt plus healing done plus morale damage (Crucible), every point counts once.
  add("mvp", (member) => number(row(member.id).damageAppliedNet) + number(row(member.id).healingNet) + number(row(member.id).moraleDamageDealt), {
    tieBreak: (member) => number(row(member.id).takedowns)
  });
  add("healer", (member) => number(row(member.id).healingNet) + number(row(member.id).moraleHealing));
  add("sponge", (member) => number(row(member.id).damageTakenNet), { eligible: (member) => !(Number(row(member.id).downed) > 0) });
  add("control", (member) => number(row(member.id).control));
  add("takedowns", (member) => number(row(member.id).takedowns));
  add("clutch", (member) => rescues.get(member.id) ?? 0);
  // Lucky: most critical hits, the better dice break a tie.
  add("lucky", (member) => rolls.get(member.id)?.crits ?? 0, { tieBreak: (member) => rolls.get(member.id)?.average ?? null });
  // Unlucky: most fumbles, the worse dice break a tie. Without any fumble, the lowest dice of the fight.
  const anyFumble = party.some((member) => (rolls.get(member.id)?.fumbles ?? 0) > 0);
  if (anyFumble) {
    add("unlucky", (member) => rolls.get(member.id)?.fumbles ?? 0, { tieBreak: (member) => negate(rolls.get(member.id)?.average) });
  } else {
    add("unlucky", (member) => {
      const entry = rolls.get(member.id);
      if (!entry || entry.count < MIN_ROLLS_FOR_LOW_AVERAGE || entry.average >= 0.5) return 0;
      // Lower average, higher score. Kept as a share so ties stay exact.
      return Math.round((1 - entry.average) * 1000) / 1000;
    }, { details: () => ({ lowRolls: true }) });
  }
  return awards;
}

// Rolls (critical hits, fumbles, average result) and allies brought back of every party member, by combatant id.
export function awardTallies(events = [], ids = new Set()) {
  const rescues = new Map();
  for (const rescue of rescueIncidents(events)) {
    if (!ids.has(rescue.sourceId) || !ids.has(rescue.targetId) || rescue.sourceId === rescue.targetId) continue;
    rescues.set(rescue.sourceId, (rescues.get(rescue.sourceId) ?? 0) + 1);
  }
  return { rolls: rollSummary(events, ids), rescues };
}

// Critical hits, fumbles and the average natural result (0 to 1) of every party member's tests.
function rollSummary(events, ids) {
  const summary = new Map();
  const undoneCards = reversedCardMessageIds(events);
  for (const event of events) {
    if (!event || event.ignored || !String(event.type ?? "").startsWith("roll.") || isUndone(event, undoneCards)) continue;
    const id = String(event.combatantId ?? "");
    if (!ids.has(id)) continue;
    const entry = summary.get(id) ?? { crits: 0, fumbles: 0, total: 0, count: 0, average: null };
    if (isCritical(event)) entry.crits += 1;
    if (isFumble(event)) entry.fumbles += 1;
    const share = naturalRollShare(event);
    if (share !== null) {
      entry.total += share;
      entry.count += 1;
      entry.average = entry.total / entry.count;
    }
    summary.set(id, entry);
  }
  return summary;
}

function negate(value) {
  return value === null || value === undefined ? null : -value;
}

// "MVP: Aria, 42 damage and healing." Names may carry the Discord markers of the report.
export function awardLine(award) {
  return format("SCLS.Award.Line", { award: awardLabel(award.key), names: joinNames(award.winners.map((winner) => winner.name)), detail: awardDetail(award) });
}

export function awardLabel(key) {
  return localize(`SCLS.Award.Label.${key}`);
}

export function awardDetail(award) {
  const value = Number(award?.value) || 0;
  const count = formatAwardNumber(value);
  switch (award?.key) {
    case "mvp": return format("SCLS.Award.Detail.mvp", { amount: count });
    case "healer": return format("SCLS.Award.Detail.healer", { amount: count });
    case "sponge": return format("SCLS.Award.Detail.sponge", { amount: count });
    case "unlucky":
      if (award.details?.lowRolls) return localize(award.details.lowRollsKey ?? "SCLS.Award.Detail.unluckyLow");
      return format(value === 1 ? "SCLS.Award.Detail.unluckyOne" : "SCLS.Award.Detail.unluckyOther", { count });
    case "control":
    case "takedowns":
    case "clutch":
    case "lucky":
      return format(value === 1 ? `SCLS.Award.Detail.${award.key}One` : `SCLS.Award.Detail.${award.key}Other`, { count });
    default: return count;
  }
}

function joinNames(names) {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} ${localize("SCLS.Report.ListAnd")} ${names.at(-1)}`;
}

function formatAwardNumber(value) {
  try {
    return new Intl.NumberFormat(activeLocale(), { maximumFractionDigits: 2 }).format(Number(value) || 0);
  } catch {
    return String(Math.round((Number(value) || 0) * 100) / 100);
  }
}

export const __test__ = { rollSummary };
