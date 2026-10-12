import assert from "node:assert/strict";
import { test } from "node:test";
import { EVENT_TYPES, RESOURCE_INTERPRETATIONS } from "../scripts/constants.js";
import { GenericSystemAdapter } from "../scripts/adapters/generic-adapter.js";
import { Dnd5eSystemAdapter } from "../scripts/adapters/dnd5e-adapter.js";
import { CombatStatsService } from "../scripts/services/stats-service.js";

const adapter = new GenericSystemAdapter();

// A rolled d20 term as Foundry stores it: dropped and rerolled dice are inactive.
const d20 = (...results) => ({ faces: 20, results: results.map((entry) => (typeof entry === "number" ? { result: entry, active: true } : entry)) });
const dropped = (result) => ({ result, active: false, discarded: true });
const crit = (roll, flavor = "Longsword attack") => {
  const { isCritical, isFumble } = adapter.extractRollData(roll, { flavor });
  return { isCritical, isFumble };
};

test("generic adapter detects hp damage deltas", () => {
  const deltas = adapter.detectResourceDeltas({ system: { attributes: { hp: { value: 30 } } } }, { system: { attributes: { hp: { value: 18 } } } }, ["system.attributes.hp.value"]);
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0].delta, -12);
  assert.equal(deltas[0].interpretedAs, RESOURCE_INTERPRETATIONS.DAMAGE);
});

test("generic adapter classifies obvious healing flavor", () => {
  const classification = adapter.classifyRoll({ formula: "2d8", total: 9 }, { flavor: "Healing" });
  assert.equal(classification.type, EVENT_TYPES.ROLL_HEALING);
});

test("generic adapter extracts chat damage applications", () => {
  const applications = adapter.extractChatApplications({ content: "Ironbound Brute takes 17 damage." });
  assert.equal(applications.length, 1);
  assert.equal(applications[0].type, EVENT_TYPES.DAMAGE_APPLIED);
  assert.equal(applications[0].amount, 17);
  assert.equal(applications[0].targetName, "Ironbound Brute");
});

test("generic adapter deduplicates matching text and structured damage applications", () => {
  const applications = adapter.extractChatApplications({
    content: "Ironbound Brute takes 17 damage.",
    flags: {
      dnd5e: {
        damageDetail: [
          {
            amount: 17,
            targetActorUuid: "Actor.defender",
            targetTokenUuid: "Scene.scene.Token.token",
            targetName: "Ironbound Brute"
          }
        ]
      }
    }
  });

  assert.equal(applications.length, 1);
  assert.equal(applications[0].type, EVENT_TYPES.DAMAGE_APPLIED);
  assert.equal(applications[0].amount, 17);
  assert.equal(applications[0].targetName, "Ironbound Brute");
});

test("generic adapter extracts targeted actor uuids from chat flags", () => {
  const targets = adapter.extractMessageTargets({ flags: { dnd5e: { roll: { targets: [{ actorUuid: "Actor.defender", name: "Defender" }] } } } });
  assert.deepEqual(targets.actorUuids, ["Actor.defender"]);
  assert.deepEqual(targets.names, ["Defender"]);
});

test("generic adapter keeps test rolls without a d20 out of the damage rolls", () => {
  class StandardCheck { constructor() { this.formula = "3d8 + 4"; this.total = 17; this.data = { dc: 15 }; } }
  class AttackRoll extends StandardCheck {}
  class InitiativeCheck extends StandardCheck {}
  class DamageRoll { constructor() { this.formula = "2d6 + 3"; this.total = 10; } }

  assert.equal(adapter.classifyRoll(new StandardCheck(), { flavor: "" }).type, EVENT_TYPES.ROLL_OTHER);
  assert.equal(adapter.classifyRoll(new AttackRoll(), { flavor: "" }).type, EVENT_TYPES.ROLL_ATTACK);
  assert.equal(adapter.classifyRoll(new InitiativeCheck(), { flavor: "" }).type, EVENT_TYPES.ROLL_OTHER);
  assert.equal(adapter.classifyRoll(new DamageRoll(), { flavor: "" }).type, EVENT_TYPES.ROLL_DAMAGE);
  // A plain roll with a difficulty is a test, a plain roll without any hint may still be damage.
  assert.equal(adapter.classifyRoll({ formula: "3d8", total: 12, options: { target: 14 } }, { flavor: "" }).type, EVENT_TYPES.ROLL_OTHER);
  assert.equal(adapter.classifyRoll({ formula: "3d8", total: 12, options: { target: null } }, { flavor: "" }).type, EVENT_TYPES.ROLL_DAMAGE);
  assert.equal(adapter.classifyRoll({ formula: "3d8", total: 12 }, { flavor: "" }).type, EVENT_TYPES.ROLL_DAMAGE);
});

test("generic adapter marks a natural 20 as critical and a natural 1 as fumble on attacks and tests", () => {
  assert.deepEqual(crit({ formula: "1d20 + 5", total: 25, dice: [d20(20)] }), { isCritical: true, isFumble: false });
  assert.deepEqual(crit({ formula: "1d20 + 5", total: 6, dice: [d20(1)] }), { isCritical: false, isFumble: true });
  assert.deepEqual(crit({ formula: "1d20 + 5", total: 17, dice: [d20(12)] }), { isCritical: false, isFumble: false });
  // Other dice next to the d20 (Bless) do not matter. Saves and checks get the flags as well.
  assert.deepEqual(crit({ formula: "1d20 + 1d4", total: 23, dice: [d20(20), { faces: 4, results: [{ result: 3, active: true }] }] }), { isCritical: true, isFumble: false });
  assert.deepEqual(crit({ formula: "1d20", total: 1, dice: [d20(1)] }, "Dexterity saving throw"), { isCritical: false, isFumble: true });
});

test("generic adapter reads the kept die of advantage and disadvantage and skips unclear d20 rolls", () => {
  assert.deepEqual(crit({ formula: "2d20kh + 5", total: 25, dice: [d20(dropped(4), 20)] }), { isCritical: true, isFumble: false });
  assert.deepEqual(crit({ formula: "2d20kh + 5", total: 12, dice: [d20(dropped(20), 7)] }), { isCritical: false, isFumble: false });
  assert.deepEqual(crit({ formula: "2d20kl + 5", total: 6, dice: [d20(1, dropped(15))] }), { isCritical: false, isFumble: true });
  // Two kept d20 or two d20 terms have no single natural result.
  assert.deepEqual(crit({ formula: "2d20 + 5", total: 45, dice: [d20(20, 20)] }), { isCritical: false, isFumble: false });
  assert.deepEqual(crit({ formula: "1d20 + 1d20", total: 40, dice: [d20(20), d20(20)] }), { isCritical: false, isFumble: false });
  assert.deepEqual(crit({ formula: "3d8", total: 24, data: { dc: 15 }, dice: [{ faces: 8, results: [8, 8, 8].map((result) => ({ result, active: true })) }] }), { isCritical: false, isFumble: false });
});

test("generic adapter never marks damage or healing rolls and keeps a system's own critical result", () => {
  assert.deepEqual(crit({ formula: "1d20", total: 20, dice: [d20(20)] }, "Fire damage"), { isCritical: false, isFumble: false });
  assert.deepEqual(crit({ formula: "1d20", total: 1, dice: [d20(1)] }, "Healing"), { isCritical: false, isFumble: false });
  // A wider critical range, decided by the system's roll class.
  assert.deepEqual(crit({ formula: "1d20 + 5", total: 24, isCritical: true, isFumble: false, dice: [d20(19)] }), { isCritical: true, isFumble: false });
  // The classification passed by the combat log service is used instead of classifying again.
  assert.equal(adapter.extractRollData({ formula: "1d20", total: 20, dice: [d20(20)] }, { flavor: "" }, { type: EVENT_TYPES.ROLL_DAMAGE }).isCritical, false);
});

test("generic critical hits and fumbles count in the statistics like dnd5e ones", () => {
  const roll = (id, value) => ({ id, type: EVENT_TYPES.ROLL_ATTACK, round: 1, combatantId: "hero", confidence: "unclear", data: adapter.extractRollData({ formula: "1d20 + 5", total: value + 5, dice: [d20(value)] }, { flavor: "Attack" }) });
  const stats = CombatStatsService.compute({
    participants: [{ combatantId: "hero", name: "Hero", side: "friendly" }],
    events: [roll("a", 20), roll("b", 1), roll("c", 11), { id: "d", type: EVENT_TYPES.ROLL_DAMAGE, round: 1, combatantId: "hero", confidence: "unclear", data: { total: 7 } }]
  }, { includeUnclearDeltasInStats: false });
  assert.equal(stats.summary.criticalHits, 1);
  assert.equal(stats.summary.criticalFumbles, 1);
  assert.equal(stats.byCombatant[0].crits, 1);
  assert.equal(stats.byCombatant[0].fumbles, 1);
  // Other unclear events still stay out of the numbers.
  assert.equal(stats.summary.grossDamageRolled, 0);
});

test("dnd5e adapter keeps the system's critical result instead of the natural die", () => {
  const dnd5e = new Dnd5eSystemAdapter();
  const message = { flags: { dnd5e: { roll: { type: "attack" } } } };
  assert.equal(dnd5e.extractRollData({ formula: "1d20 + 5", total: 25, dice: [d20(20)] }, message).isCritical, false);
  assert.equal(dnd5e.extractRollData({ formula: "1d20 + 5", total: 24, isCritical: true, dice: [d20(19)] }, message).isCritical, true);
});
