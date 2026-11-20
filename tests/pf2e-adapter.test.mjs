import assert from "node:assert/strict";
import { test } from "node:test";
import { CONFIDENCE, EVENT_TYPES } from "../scripts/constants.js";
import { Pf2eSystemAdapter } from "../scripts/adapters/pf2e-adapter.js";

const adapter = new Pf2eSystemAdapter();

class CheckRoll {
  constructor(data = {}) {
    Object.assign(this, { formula: "1d20 + 11", total: 31, dice: [{ faces: 20, results: [{ result: 20 }] }] }, data);
  }
}
class DamageRoll {
  constructor(data = {}) {
    Object.assign(this, { formula: "1d8 acid", total: 5, dice: [{ faces: 8, results: [{ result: 5 }] }] }, data);
  }
}
const card = (context, extra = {}) => ({ flags: { pf2e: { context, ...extra } }, flavor: "", content: "" });

test("rolls are classified by the type of the system card, not by their class name", () => {
  assert.equal(adapter.classifyRoll(new CheckRoll(), card({ type: "attack-roll" })).type, EVENT_TYPES.ROLL_ATTACK);
  assert.equal(adapter.classifyRoll(new CheckRoll(), card({ type: "spell-attack-roll" })).type, EVENT_TYPES.ROLL_ATTACK);
  assert.equal(adapter.classifyRoll(new CheckRoll(), card({ type: "saving-throw" })).type, EVENT_TYPES.ROLL_SAVE);
  assert.equal(adapter.classifyRoll(new CheckRoll(), card({ type: "skill-check" })).type, EVENT_TYPES.ROLL_CHECK);
  assert.equal(adapter.classifyRoll(new DamageRoll(), card({ type: "damage-roll" })).type, EVENT_TYPES.ROLL_DAMAGE);
  assert.equal(adapter.classifyRoll(new DamageRoll({ options: { damage: { damage: { kind: "healing" } } } }), card({ type: "damage-roll" })).type, EVENT_TYPES.ROLL_HEALING);
  assert.equal(adapter.classifyRoll(new CheckRoll(), card({ type: "attack-roll" })).confidence, CONFIDENCE.SAFE);
  // Without a card type the generic reading stays.
  assert.equal(adapter.classifyRoll(new DamageRoll(), { flags: {}, flavor: "" }).type, EVENT_TYPES.ROLL_DAMAGE);
});

test("critical hits and fumbles are the degrees of success, a natural 1 or 20 alone is neither", () => {
  const attack = (outcome, natural, extra = {}) => adapter.extractRollData(new CheckRoll({ dice: [{ faces: 20, results: [{ result: natural }] }], ...extra }), card({ type: "attack-roll", outcome }), { type: EVENT_TYPES.ROLL_ATTACK });
  assert.deepEqual([attack("criticalSuccess", 20).isCritical, attack("criticalSuccess", 20).isFumble], [true, false]);
  assert.deepEqual([attack("success", 20).isCritical, attack("success", 20).isFumble], [false, false]);
  assert.deepEqual([attack("failure", 1).isCritical, attack("failure", 1).isFumble], [false, false]);
  assert.deepEqual([attack("criticalFailure", 5).isCritical, attack("criticalFailure", 5).isFumble], [false, true]);
  assert.equal(attack(undefined, 20, { degreeOfSuccess: 3 }).isCritical, true);
  // Saves and checks never count as critical hits.
  const save = adapter.extractRollData(new CheckRoll(), card({ type: "saving-throw", outcome: "criticalSuccess" }), { type: EVENT_TYPES.ROLL_SAVE });
  assert.deepEqual([save.isCritical, save.isFumble], [false, false]);
});

test("the action is named after the item, a spell is a spell, a strike melee or ranged, a save has no target", () => {
  const strike = card({ type: "attack-roll", title: "Melee Strike: Longsword", identifier: "abc.longsword.melee" }, { origin: { type: "weapon", uuid: "Actor.a.Item.b" } });
  assert.deepEqual([adapter.describeAction(strike).actionName, adapter.describeAction(strike).actionKind], ["Longsword", "melee"]);
  const bow = card({ type: "attack-roll", title: "Ranged Strike: Shortbow", identifier: "abc.shortbow.ranged" });
  assert.equal(adapter.describeAction(bow).actionKind, "ranged");
  const spell = card({ type: "damage-roll" }, { origin: { type: "spell", uuid: "Actor.a.Item.c" } });
  assert.equal(adapter.describeAction(spell).actionKind, "spell");
  const save = card({ type: "saving-throw", target: { actor: "Actor.x", token: "Scene.s.Token.t" } }, { origin: { type: "spell" } });
  assert.deepEqual(adapter.extractMessageTargets(save), { actorUuids: [], tokenUuids: [], names: [] });
  const attack = card({ type: "attack-roll", target: { actor: "Scene.s.Token.t.Actor.z", token: "Scene.s.Token.t" } });
  assert.deepEqual(adapter.extractMessageTargets(attack).tokenUuids, ["Scene.s.Token.t"]);
});

test("damage and healing cards are read from the applied damage flag, not from their translated text", () => {
  const damage = { flags: { pf2e: { appliedDamage: { uuid: "Actor.v", isHealing: false, updates: [{ path: "system.attributes.hp.value", value: 4 }] } } }, content: '<span class="target-name">Valeros</span> erleidet 4 Schaden.' };
  const [hit] = adapter.extractChatApplications(damage);
  assert.deepEqual([hit.type, hit.amount, hit.targetActorUuid, hit.targetName], [EVENT_TYPES.DAMAGE_APPLIED, 4, "Actor.v", "Valeros"]);
  const heal = { flags: { pf2e: { appliedDamage: { uuid: "Actor.v", isHealing: true, updates: [{ path: "system.attributes.hp.value", value: -3 }] } } }, content: "" };
  const [healed] = adapter.extractChatApplications(heal);
  assert.deepEqual([healed.type, healed.amount], [EVENT_TYPES.HEALING_APPLIED, 3]);
  assert.deepEqual(adapter.extractChatApplications({ flags: { pf2e: { appliedDamage: { uuid: "Actor.v", updates: [{ path: "system.attributes.hp.value", value: 0 }] } } } }), []);
  // Cards of other kinds keep the generic text reading.
  assert.equal(adapter.extractChatApplications({ flags: {}, content: "Goblin takes 6 damage." })[0].amount, 6);
});
