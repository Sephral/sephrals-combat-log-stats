import assert from "node:assert/strict";
import { test } from "node:test";
import { CONFIDENCE, EVENT_TYPES } from "../scripts/constants.js";
import { CombatStatsService } from "../scripts/services/stats-service.js";

const participants = [
  { combatantId: "hero", name: "Hero", side: "friendly" },
  { combatantId: "orc", name: "Orc", side: "hostile" }
];
const applied = (id, round, source, target, amount, type = EVENT_TYPES.DAMAGE_APPLIED) => ({ id, type, round, combatantId: source, confidence: CONFIDENCE.SAFE, data: { amount, targetCombatantId: target } });

test("damage and healing per round are split into party and enemies", () => {
  const stats = CombatStatsService.compute({
    rounds: 3,
    participants,
    events: [
      applied("a", 1, "hero", "orc", 7),
      applied("b", 1, "orc", "hero", 3),
      applied("c", 3, "hero", "orc", 5),
      applied("d", 3, "hero", "orc", 2, EVENT_TYPES.DAMAGE_MANUAL_REDUCED),
      applied("e", 3, "hero", "hero", 4, EVENT_TYPES.HEALING_APPLIED),
      // Damage to a party member without a known source came from the enemies: their side and round, nobody's own row.
      { id: "f", type: EVENT_TYPES.RESOURCE_DELTA, round: 2, combatantId: "hero", confidence: CONFIDENCE.PROBABLE, data: { interpretedAs: "damage", delta: -6, targetCombatantId: "hero" } }
    ]
  });
  assert.deepEqual(stats.byRound, [
    { round: 1, partyDamage: 7, enemyDamage: 3, partyHealing: 0, enemyHealing: 0 },
    { round: 2, partyDamage: 0, enemyDamage: 6, partyHealing: 0, enemyHealing: 0 },
    { round: 3, partyDamage: 3, enemyDamage: 0, partyHealing: 4, enemyHealing: 0 }
  ]);
  const party = stats.byRound.reduce((total, row) => total + row.partyDamage, 0);
  const enemies = stats.byRound.reduce((total, row) => total + row.enemyDamage, 0);
  assert.equal(party, stats.byCombatant.find((row) => row.id === "hero").damageAppliedNet);
  assert.equal(stats.byCombatant.find((row) => row.id === "orc").damageAppliedNet, 3);
  const hostile = stats.bySide.find((row) => row.id === "hostile");
  assert.equal(enemies, hostile.damageAppliedNet);
  assert.equal(hostile.damageUnknownSource, 6);
});

test("damage and healing without a known source count for the side that must have done it", () => {
  const delta = (id, target, value, extra = {}) => ({ id, type: EVENT_TYPES.RESOURCE_DELTA, round: 1, combatantId: target, confidence: CONFIDENCE.PROBABLE, data: { interpretedAs: value < 0 ? "damage" : "healing", delta: value, resourcePath: "system.attributes.hp.value", targetCombatantId: target, ...extra } });
  const stats = CombatStatsService.compute({
    rounds: 1,
    participants,
    events: [
      delta("a", "orc", -6), delta("b", "orc", -8), delta("c", "hero", -17), delta("d", "hero", 5),
      // An undo of the 8 (midi-qol's damage card) takes it back from the party.
      delta("e", "orc", 8, { interpretedAs: "correctionDamageDown", reversal: true, reversalOf: "b" })
    ]
  });
  const side = (id) => stats.bySide.find((row) => row.id === id);
  assert.equal(side("friendly").damageAppliedNet, 6);
  assert.equal(side("hostile").damageAppliedNet, 17);
  assert.equal(side("friendly").healingNet, 5);
  assert.equal(side("friendly").damageAppliedNet + side("hostile").damageAppliedNet, stats.summary.netDamageApplied);
  assert.equal(side("friendly").damageTakenNet, 17);
  assert.equal(stats.byCombatant.find((row) => row.id === "hero").damageAppliedNet, 0);
  assert.deepEqual(stats.byRound, [{ round: 1, partyDamage: 6, enemyDamage: 17, partyHealing: 5, enemyHealing: 0 }]);
  assert.equal(stats.warningCounts.unknownSource, 3);
});

test("a morale hit next to a health hit counts as one melee hit", () => {
  const delta = (id, pool, amount, secondary) => ({
    id, type: EVENT_TYPES.RESOURCE_DELTA, round: 1, combatantId: "hero", confidence: CONFIDENCE.SAFE,
    data: { pool, interpretedAs: "damage", delta: -amount, attribution: "systemApplied", sourceCombatantId: "hero", targetCombatantId: "orc", actionKind: "melee", ...(secondary ? { secondary: true } : {}) }
  });
  const stats = CombatStatsService.compute({ participants, events: [delta("h", "health", 5), delta("m", "morale", 3, true)] });
  const hero = stats.byCombatant.find((row) => row.id === "hero");
  assert.equal(hero.martial, 1);
  assert.equal(hero.damageAppliedNet, 5);
  assert.equal(hero.moraleDamageDealt, 3);
});

test("dnd5e numbers keep their shape: no morale and no open actions", () => {
  const stats = CombatStatsService.compute({ participants, events: [applied("a", 1, "hero", "orc", 7)] });
  assert.equal(stats.summary.moraleDamageApplied, 0);
  assert.equal(stats.summary.openActions, 0);
  assert.equal(stats.warningCounts.openActions, undefined);
  assert.deepEqual(stats.warningCodes, []);
});

test("a reduction filed under the last round takes the damage back from the rounds it was dealt in", () => {
  const stats = CombatStatsService.compute({
    rounds: 4,
    participants,
    events: [
      applied("a", 1, "hero", "orc", 7),
      applied("b", 2, "hero", "orc", 3),
      // Added by the GM after the fight: lands in round 4, where the hero did nothing.
      applied("c", 4, "hero", "orc", 5, EVENT_TYPES.DAMAGE_MANUAL_REDUCED),
      applied("d", 2, "orc", "hero", 4),
      applied("e", 4, "orc", "hero", 6, EVENT_TYPES.DAMAGE_MANUAL_REDUCED),
      applied("f", 1, "hero", "hero", 5, EVENT_TYPES.HEALING_APPLIED),
      applied("g", 4, "hero", "hero", 2, EVENT_TYPES.HEALING_MANUAL_REDUCED)
    ]
  });
  assert.deepEqual(stats.byRound.map((row) => [row.round, row.partyDamage, row.enemyDamage, row.partyHealing]), [[1, 5, 0, 3], [2, 0, 0, 0], [3, 0, 0, 0], [4, 0, -2, 0]]);
  const party = stats.byRound.reduce((total, row) => total + row.partyDamage, 0);
  const enemies = stats.byRound.reduce((total, row) => total + row.enemyDamage, 0);
  assert.equal(party, stats.byCombatant.find((row) => row.id === "hero").damageAppliedNet);
  assert.equal(enemies, stats.byCombatant.find((row) => row.id === "orc").damageAppliedNet);
});

const crucibleDelta = (id, round, source, target, pool, delta, oldValue, extra = {}) => ({
  id, type: EVENT_TYPES.RESOURCE_DELTA, round, combatantId: source || target, confidence: CONFIDENCE.SAFE,
  data: { pool, interpretedAs: delta < 0 ? "damage" : "healing", delta, oldValue, newValue: oldValue + delta, resourcePath: `system.resources.${pool}.value`, targetCombatantId: target, ...(source ? { attribution: "systemApplied", sourceCombatantId: source } : {}), ...extra }
});
const trio = [...participants, { combatantId: "mage", name: "Mage", side: "friendly" }];

test("an undone hit is no hit and its card's critical does not count; confirmed again it counts", () => {
  const card = { id: "card", type: EVENT_TYPES.ACTION_USED, round: 1, combatantId: "hero", confidence: CONFIDENCE.SAFE, data: { messageId: "m1", status: "reversed", plannedDamage: 6 } };
  const roll = { id: "roll", type: EVENT_TYPES.ROLL_ATTACK, round: 1, combatantId: "hero", confidence: CONFIDENCE.SAFE, source: { id: "m1" }, data: { isCritical: true } };
  const hit = crucibleDelta("hit", 1, "hero", "orc", "health", -6, 10, { actionKind: "ranged", reversed: true });
  const undo = crucibleDelta("undo", 1, "hero", "orc", "health", 6, 4, { interpretedAs: "correctionDamageDown", reversal: true, reversalOf: "hit" });
  let hero = CombatStatsService.compute({ participants, events: [card, roll, hit, undo] }).byCombatant.find((row) => row.id === "hero");
  assert.equal(hero.ranged, 0);
  assert.equal(hero.crits, 0);
  assert.equal(hero.damageAppliedNet, 0);

  const confirmed = { ...card, data: { ...card.data, status: "confirmed" } };
  hero = CombatStatsService.compute({ participants, events: [confirmed, roll, crucibleDelta("hit", 1, "hero", "orc", "health", -6, 10, { actionKind: "ranged" })] }).byCombatant.find((row) => row.id === "hero");
  assert.equal(hero.ranged, 1);
  assert.equal(hero.crits, 1);
});

test("an enemy that breaks and then dies is defeated once; the takedown goes to whoever dropped it first", () => {
  const stats = CombatStatsService.compute({
    participants: trio,
    events: [
      crucibleDelta("break", 1, "mage", "orc", "morale", -5, 5, { downState: "broken", targetDowned: true }),
      crucibleDelta("kill", 2, "hero", "orc", "health", -8, 8, { downState: "dead", targetDowned: true })
    ]
  });
  assert.equal(stats.summary.enemiesDefeated, 1);
  assert.equal(stats.byCombatant.find((row) => row.id === "orc").downed, 1);
  assert.equal(stats.byCombatant.find((row) => row.id === "mage").takedowns, 1);
  assert.equal(stats.byCombatant.find((row) => row.id === "hero").takedowns, 0);
});

test("down, healed back up and down again counts twice, like before", () => {
  const hp = (id, round, source, target, delta, oldValue, downed) => ({
    id, type: EVENT_TYPES.RESOURCE_DELTA, round, combatantId: source || target, confidence: CONFIDENCE.SAFE,
    data: { interpretedAs: delta < 0 ? "damage" : "healing", delta, oldValue, newValue: oldValue + delta, resourcePath: "system.attributes.hp.value", targetCombatantId: target, targetDowned: downed, ...(source ? { attribution: "systemApplied", sourceCombatantId: source } : {}) }
  });
  const stats = CombatStatsService.compute({
    participants: trio,
    events: [hp("a", 1, "orc", "hero", -10, 10, true), hp("b", 1, "mage", "hero", 4, 0, false), hp("c", 2, "orc", "hero", -4, 4, true)]
  });
  assert.equal(stats.summary.partyDowned, 2);
  assert.equal(stats.byCombatant.find((row) => row.id === "hero").downed, 2);
  assert.equal(stats.byCombatant.find((row) => row.id === "orc").takedowns, 2);
});
