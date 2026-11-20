import { SIDES } from "../constants.js";
import { getSystemAdapter } from "../adapters/adapter-registry.js";
import { format, localize } from "../utils.js";
import { termKey } from "./system-terms.js";

// The danger bar for the GM: how close it is for the party, from the numbers the combat tracker already knows.
// The score runs from 0 (calm) to 1 (the party is losing). Cheap enough to run on every actor update.

export const DANGER_LEVELS = Object.freeze({ SAFE: "safe", TENSE: "tense", CRITICAL: "critical" });
const TENSE_FROM = 0.4;
const CRITICAL_FROM = 0.65;

const clamp = (value, low = 0, high = 1) => Math.min(high, Math.max(low, value));

function fraction(entries) {
  const known = entries.filter((entry) => Number(entry.max) > 0);
  const max = known.reduce((total, entry) => total + Number(entry.max), 0);
  if (!(max > 0)) return null;
  return clamp(known.reduce((total, entry) => total + Math.max(0, Number(entry.hp) || 0), 0) / max);
}

/**
 * How dangerous the fight is for the party.
 * @param {object} input
 * @param {{hp: number, max: number, down?: boolean}[]} input.heroes  The party (player characters in the fight)
 * @param {{hp: number, max: number}[]|null} [input.foes]            The opponents; without known hit points pass null or []
 * @param {number} [input.round]
 * @returns {{score: number, level: string, party: number, foes: number|null, down: number, heroes: number, round: number}|null}
 *   null without heroes or without any known hit points
 */
export function dangerState({ heroes = [], foes = null, round = 1 } = {}) {
  const party = fraction(heroes);
  if (!heroes.length || party === null) return null;
  const down = heroes.filter((hero) => hero.down || Number(hero.hp) <= 0).length;
  const enemy = foes?.length ? fraction(foes) : null;
  // Weight: the party's health is half of it, heroes on the floor a third, what is left of the opponents a fifth.
  // Opponents that are nearly done pull it down, a fresh opposing side adds to it. Without them: a neutral half.
  let score = 0.5 * (1 - party) + 0.3 * (down / heroes.length) + 0.2 * (enemy ?? 0.5);
  // Long fights wear a party down: a little more from round 6 on, only while anybody is hurt.
  if (party < 1) score += clamp((Number(round) - 5) * 0.02, 0, 0.1);
  if (down === heroes.length) score = 1;
  // Every opponent beaten: no danger left.
  if (enemy === 0) score = Math.min(score, 0.25);
  score = Math.round(clamp(score) * 1000) / 1000;
  const level = score >= CRITICAL_FROM ? DANGER_LEVELS.CRITICAL : score >= TENSE_FROM ? DANGER_LEVELS.TENSE : DANGER_LEVELS.SAFE;
  return { score, level, party, foes: enemy, down, heroes: heroes.length, round: Math.max(1, Number(round) || 1) };
}

const percent = (value) => Math.round(value * 100);

/** The tooltip: "Party at 38 % HP, 1 hero down, enemies at 70 %". */
export function dangerTooltip(state, systemId = "") {
  if (!state) return "";
  const parts = [format(termKey(systemId, "SCLS.Danger.Party"), { party: percent(state.party) })];
  parts.push(state.down === 0 ? localize("SCLS.Danger.DownNone") : state.down === 1 ? localize("SCLS.Danger.DownOne") : format("SCLS.Danger.DownOther", { count: state.down }));
  if (state.foes !== null) parts.push(format("SCLS.Danger.Foes", { foes: percent(state.foes) }));
  parts.push(format("SCLS.Danger.RoundInfo", { round: state.round }));
  return parts.join(", ");
}

export function dangerLabel(state) {
  return state ? format("SCLS.Danger.Label", { level: localize(`SCLS.Danger.Level.${state.level}`) }) : "";
}

/**
 * Reads the combatants of a combat. Heroes are the player owned characters, opponents the hostile tokens; a
 * defeated opponent counts with 0 hit points. Vitals come from the system adapter (hit points, Crucible health).
 */
export function dangerInput(combat, systemId = globalThis.game?.system?.id ?? "generic") {
  const adapter = getSystemAdapter(systemId);
  const heroes = [];
  const foes = [];
  for (const combatant of combat?.combatants ?? []) {
    const actor = combatant.actor;
    if (!actor) continue;
    const vitals = adapter.readVitals?.(actor) ?? null;
    if (!vitals) continue;
    if (combatant.isDefeated) vitals.hp = 0;
    const hostile = (combatant.token?.disposition ?? combatant.disposition ?? 0) === (globalThis.CONST?.TOKEN_DISPOSITIONS?.HOSTILE ?? -1);
    if (actor.hasPlayerOwner && !hostile) heroes.push({ ...vitals, down: vitals.down || Boolean(combatant.isDefeated) });
    else if (hostile) foes.push(vitals);
  }
  return { heroes, foes: foes.length ? foes : null, round: combat?.round ?? 1 };
}

export const __test__ = { fraction, TENSE_FROM, CRITICAL_FROM, SIDES };
