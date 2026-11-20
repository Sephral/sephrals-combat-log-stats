import { CONFIDENCE, EVENT_TYPES, RESOURCE_POOLS, SIDES } from "../constants.js";
import { format, localize } from "../utils.js";
import {
  downIncidents, eventActors, eventAmount, isCritical, isDamageDealt, isUndone, rescueIncidents, reversedCardMessageIds
} from "./event-insights.js";

// One short sentence per round, picked by simple scores from what the log recorded (no AI, no guessing): a hero going
// down, a takedown, a critical hit, the biggest hit, a rescue, a foe hitting several times. The sentences work on the
// events and participants of a log or of its player view, so what players may not see never gets in. The texts live in
// the language files as numbered variants (SCLS.Story.<Kind>.<n>), the variant is picked from the seed, so the same
// fight always reads the same.

// How many variants each text has in the language files.
export const STORY_VARIANTS = Object.freeze({
  PartyDown: 3, PartyDownBy: 2, Kill: 3, KillNoSrc: 2, KillCrit: 2, Crit: 3, CritPlain: 2, Hit: 3, Multi: 2,
  Rescue: 2, RescueNoSrc: 1, StrikeCrit: 2, StrikeKill: 2, StrikeHit: 2, Nobody: 2
});

const SCORES = Object.freeze({ partyDown: 100, kill: 80, crit: 60, rescue: 55, multi: 25, hit: 20 });
const MAX_CLAUSES = 2;

export function storyKeys() {
  return Object.entries(STORY_VARIANTS).flatMap(([kind, count]) => Array.from({ length: count }, (_, index) => `SCLS.Story.${kind}.${index + 1}`))
    .concat(["SCLS.Story.Round", "SCLS.Story.Times2", "SCLS.Story.Times3", "SCLS.Story.TimesMany"]);
}

function hash(text) {
  let value = 2166136261;
  for (const char of String(text)) value = Math.imul(value ^ char.charCodeAt(0), 16777619) >>> 0;
  return value;
}

function variant(kind, seed, round, salt = "") {
  const count = STORY_VARIANTS[kind] ?? 1;
  return `SCLS.Story.${kind}.${(hash(`${seed}|${round}|${kind}|${salt}`) % count) + 1}`;
}

const amountText = (amount) => String(Math.round(Number(amount) * 10) / 10);

/**
 * The notable facts of every round, best first per round: [{ round, clauses: [{ kind, score, index, ... }], anyDown }].
 * @param {object[]} events        Events of a log or its player view
 * @param {object[]} participants  Participants (combatantId, name, side)
 * @param {object} [options]
 * @param {boolean} [options.detail=true]        Single actions may be told (hits, critical hits, rescues, who did it)
 * @param {boolean} [options.enemyAmounts=true]  Damage numbers of enemy hits may be told
 */
export function roundFacts(events = [], participants = [], { detail = true, enemyAmounts = true } = {}) {
  const sideOf = new Map((participants ?? []).filter(Boolean).map((entry) => [String(entry.combatantId ?? ""), entry.side]));
  const nameOf = new Map((participants ?? []).filter(Boolean).map((entry) => [String(entry.combatantId ?? ""), String(entry.name ?? "")]));
  const known = (id) => Boolean(id) && nameOf.has(id) && Boolean(nameOf.get(id));
  const live = (events ?? []).filter((event) => event && !event.ignored && !event.data?.reversed);
  const undone = reversedCardMessageIds(live);
  const rounds = new Map();
  const roundOf = (number) => {
    if (!rounds.has(number)) rounds.set(number, { round: number, clauses: [], anyDown: false, hits: [], crits: new Map() });
    return rounds.get(number);
  };

  live.forEach((event, index) => {
    const number = Number(event.round) || 0;
    if (number < 1 || isUndone(event, undone)) return;
    if (event.type === EVENT_TYPES.ROLL_ATTACK && isCritical(event)) {
      const source = String(event.combatantId ?? "");
      if (known(source)) roundOf(number).crits.set(source, index);
    }
    if (!isDamageDealt(event) || event.data?.secondary || event.data?.duplicateOfEventId || event.data?.pool === RESOURCE_POOLS.MORALE) return;
    if (event.confidence === CONFIDENCE.UNCLEAR) return;
    const amount = eventAmount(event);
    const { sourceId, targetId } = eventActors(event);
    if (amount > 0 && known(sourceId)) roundOf(number).hits.push({ event, index, source: sourceId, target: known(targetId) ? targetId : "", amount });
  });

  const downs = downIncidents(live).filter((incident) => !isUndone(incident.event, undone));
  const killingHits = new Set();
  for (const incident of downs) {
    const number = Number(incident.round) || 0;
    if (number < 1 || !known(incident.targetId)) continue;
    const row = roundOf(number);
    row.anyDown = true;
    const party = sideOf.get(incident.targetId) !== SIDES.HOSTILE;
    const source = known(incident.sourceId) && detail ? incident.sourceId : "";
    const crit = Boolean(source) && row.crits.has(source) && incident.events.some((event) => row.hits.some((hit) => hit.event === event && hit.source === source));
    for (const event of incident.events) killingHits.add(event);
    row.clauses.push({ kind: party ? "partyDown" : "kill", score: SCORES[party ? "partyDown" : "kill"] + (source ? 5 : 0), index: incident.index, target: incident.targetId, source, crit });
  }

  for (const row of rounds.values()) {
    if (!detail) continue;
    const used = new Set();
    // A critical hit: the best hit of its roller that round, unless that hit is already a takedown clause.
    for (const [source, rollIndex] of row.crits) {
      const mine = row.hits.filter((hit) => hit.source === source).sort((left, right) => right.amount - left.amount);
      const best = mine[0] ?? null;
      if (best && killingHits.has(best.event) && row.clauses.some((clause) => clause.kind === "kill" && clause.crit && clause.source === source)) continue;
      const shown = best && (sideOf.get(source) !== SIDES.HOSTILE || enemyAmounts) ? best.amount : null;
      if (best) used.add(best);
      row.clauses.push({ kind: "crit", score: SCORES.crit + (shown ? Math.min(20, shown / 3) : 0), index: best?.index ?? rollIndex, source, target: best?.target ?? "", amount: shown });
    }
    for (const incident of rescueIncidents(live)) {
      if (Number(incident.round) !== row.round || !known(incident.targetId) || sideOf.get(incident.targetId) === SIDES.HOSTILE) continue;
      row.clauses.push({ kind: "rescue", score: SCORES.rescue, index: incident.index, target: incident.targetId, source: known(incident.sourceId) ? incident.sourceId : "" });
    }
    // A source that hit several times.
    const counts = new Map();
    for (const hit of row.hits) counts.set(hit.source, (counts.get(hit.source) ?? 0) + 1);
    for (const [source, count] of counts) {
      if (count >= 2) row.clauses.push({ kind: "multi", score: SCORES.multi + count * 3, index: row.hits.find((hit) => hit.source === source).index, source, count });
    }
    // The biggest remaining hit of the round.
    // (not for someone who hit several times: that clause already says it)
    const rest = row.hits.filter((hit) => !used.has(hit) && (counts.get(hit.source) ?? 0) < 2 && !killingHits.has(hit.event) && (sideOf.get(hit.source) !== SIDES.HOSTILE || enemyAmounts)).sort((left, right) => right.amount - left.amount);
    if (rest[0]) row.clauses.push({ kind: "hit", score: SCORES.hit + Math.min(15, rest[0].amount / 4), index: rest[0].index, source: rest[0].source, target: rest[0].target, amount: rest[0].amount });
  }

  return Array.from(rounds.values()).filter((row) => row.clauses.length).sort((left, right) => left.round - right.round)
    .map((row) => ({ round: row.round, anyDown: row.anyDown, clauses: row.clauses.sort((left, right) => right.score - left.score) }));
}

function clauseText(clause, names, seed, round) {
  const name = (id) => names.get(id) ?? "";
  const data = { src: name(clause.source), target: name(clause.target), amount: clause.amount === null || clause.amount === undefined ? "" : amountText(clause.amount) };
  switch (clause.kind) {
    case "partyDown":
      return format(clause.source ? variant("PartyDownBy", seed, round) : variant("PartyDown", seed, round), data);
    case "kill":
      if (!clause.source) return format(variant("KillNoSrc", seed, round), data);
      return format(clause.crit ? variant("KillCrit", seed, round) : variant("Kill", seed, round), data);
    case "crit":
      return format(clause.amount === null ? variant("CritPlain", seed, round) : variant("Crit", seed, round), data);
    case "hit":
      return format(variant("Hit", seed, round), data);
    case "rescue":
      return format(clause.source ? variant("Rescue", seed, round) : variant("RescueNoSrc", seed, round), data);
    case "multi": {
      const times = clause.count === 2 ? localize("SCLS.Story.Times2") : clause.count === 3 ? localize("SCLS.Story.Times3") : format("SCLS.Story.TimesMany", { count: clause.count });
      return format(variant("Multi", seed, round), { ...data, times });
    }
    default:
      return "";
  }
}

// A hero goes down and a hero strikes back in the same round: one connected sentence.
function strikeBack(first, second, names, seed, round) {
  if (first.kind !== "partyDown" || !second.source || second.source === first.target) return null;
  const data = { src: names.get(second.source) ?? "", target: names.get(second.target) ?? "", amount: second.amount === null || second.amount === undefined ? "" : amountText(second.amount) };
  const key = second.kind === "crit" && second.amount !== null ? "StrikeCrit" : second.kind === "kill" && !second.crit ? "StrikeKill" : second.kind === "hit" ? "StrikeHit" : "";
  if (!key || second.index < first.index) return null;
  return `${clauseText(first, names, seed, round)}, ${format(variant(key, seed, round), data)}`;
}

/**
 * The sentences of a log: [{ round, text, score }] in round order.
 * @param {object[]} events
 * @param {object[]} participants
 * @param {object} [options]  detail and enemyAmounts as in roundFacts; seed varies the wording (use the log id)
 */
export function roundStories(events, participants, { detail = true, enemyAmounts = true, seed = "" } = {}) {
  const names = new Map((participants ?? []).filter(Boolean).map((entry) => [String(entry.combatantId ?? ""), String(entry.name ?? "")]));
  const stories = [];
  for (const row of roundFacts(events, participants, { detail, enemyAmounts })) {
    const picked = row.clauses.slice(0, MAX_CLAUSES).sort((left, right) => left.index - right.index);
    let text = "";
    if (picked.length === 2) text = strikeBack(picked[0], picked[1], names, seed, row.round) ?? "";
    if (!text) {
      const parts = picked.map((clause) => clauseText(clause, names, seed, row.round)).filter(Boolean);
      text = parts.join(", ");
    }
    // Hits and critical hits alone: say that nobody went down.
    if (detail && !row.anyDown && picked.every((clause) => ["multi", "hit", "crit"].includes(clause.kind))) text += `, ${localize(variant("Nobody", seed, row.round))}`;
    if (!text) continue;
    stories.push({ round: row.round, text: format("SCLS.Story.Round", { round: row.round, text }), score: picked.reduce((total, clause) => total + clause.score, 0) });
  }
  return stories;
}

/** The lines for the end card: the most notable rounds (at most `limit`), in round order. */
export function storyHighlights(stories = [], limit = 4) {
  return [...stories].sort((left, right) => (right.score - left.score) || (left.round - right.round)).slice(0, limit).sort((left, right) => left.round - right.round);
}

export const __test__ = { hash, variant, SCORES };
