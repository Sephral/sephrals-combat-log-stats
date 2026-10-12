import assert from "node:assert/strict";
import { test } from "node:test";
import { EVENT_TYPES, RESOURCE_INTERPRETATIONS } from "../scripts/constants.js";
import { GenericSystemAdapter } from "../scripts/adapters/generic-adapter.js";

const adapter = new GenericSystemAdapter();

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
