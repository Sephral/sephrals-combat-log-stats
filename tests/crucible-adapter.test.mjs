import assert from "node:assert/strict";
import { test } from "node:test";
import { CONFIDENCE, EVENT_TYPES, RESOURCE_INTERPRETATIONS } from "../scripts/constants.js";
import { CrucibleSystemAdapter, poolDeltas, __test__ } from "../scripts/adapters/crucible-adapter.js";
import { getSystemAdapter } from "../scripts/adapters/adapter-registry.js";

const adapter = new CrucibleSystemAdapter();

// Snapshot as actor.toObject() returns it: values only, maxima are derived.
const snapshot = ({ type = "hero", health = 10, wounds = 0, morale = 10, madness = 0, important = false } = {}) => ({
  type,
  system: {
    advancement: { important },
    resources: { health: { value: health }, wounds: { value: wounds }, morale: { value: morale }, madness: { value: madness }, action: { value: 6 } }
  }
});
const liveActor = ({ reserves = true, woundsMax = 30, madnessMax = 30 } = {}) => ({
  system: { usesReserveResources: reserves, resources: { wounds: { max: woundsMax }, madness: { max: madnessMax } } }
});

// Message rolls are instances of Crucible's roll classes; the adapter reads the class names.
class StandardCheck {
  constructor(data = {}) {
    Object.assign(this, { formula: "3d8 + 4", total: 18, data: { dc: 15 }, dice: [{ faces: 8, results: [{ result: 4 }, { result: 5 }, { result: 5 }] }] }, data);
  }
}
class AttackRoll extends StandardCheck {}
class InitiativeCheck extends StandardCheck {}

test("the registry picks the Crucible adapter for Crucible worlds", () => {
  assert.equal(getSystemAdapter("crucible").id, "crucible");
  assert.equal(getSystemAdapter("dnd5e").id, "dnd5e");
  assert.equal(getSystemAdapter("pf2e").id, "generic");
});

test("health damage that overflows into wounds is one change of the health pool", () => {
  const deltas = adapter.detectResourceDeltas(snapshot({ health: 3 }), snapshot({ health: 0, wounds: 4 }), adapter.getResourcePaths(), liveActor());
  assert.equal(deltas.length, 1);
  const [delta] = deltas;
  assert.equal(delta.pool, "health");
  assert.equal(delta.delta, -7);
  assert.deepEqual(delta.parts, { health: -3, wounds: 4 });
  assert.equal(delta.oldValue, 3);
  assert.equal(delta.newValue, 0);
  assert.equal(delta.interpretedAs, RESOURCE_INTERPRETATIONS.DAMAGE);
  assert.equal(delta.confidence, CONFIDENCE.PROBABLE);
  assert.equal(delta.downState, "weakened");
  assert.equal(delta.targetDowned, true);
});

test("an ordinary adversary at 0 health is dead, a weakened hero dies when the wounds are full", () => {
  const adversary = adapter.detectResourceDeltas(snapshot({ type: "adversary", health: 4 }), snapshot({ type: "adversary", health: 0 }), adapter.getResourcePaths(), liveActor({ reserves: false }));
  assert.equal(adversary[0].downState, "dead");
  assert.equal(adversary[0].targetDowned, true);

  // Without the live actor the snapshot decides: adversaries use no reserves unless important.
  const fromSnapshot = adapter.detectResourceDeltas(snapshot({ type: "adversary", health: 4 }), snapshot({ type: "adversary", health: 0 }));
  assert.equal(fromSnapshot[0].downState, "dead");
  const important = adapter.detectResourceDeltas(snapshot({ type: "adversary", important: true, health: 4 }), snapshot({ type: "adversary", important: true, health: 0 }));
  assert.equal(important[0].downState, "weakened");

  // A weakened hero is already down: dying is a new state, not a second down.
  const dying = adapter.detectResourceDeltas(snapshot({ health: 0, wounds: 26 }), snapshot({ health: 0, wounds: 30 }), adapter.getResourcePaths(), liveActor());
  assert.equal(dying[0].delta, -4);
  assert.equal(dying[0].downState, "dead");
  assert.equal(dying[0].targetDowned, false);
});

test("morale damage is its own pool, breaks at 0 and counts as the same hit next to health damage", () => {
  const deltas = adapter.detectResourceDeltas(snapshot({ health: 10, morale: 3 }), snapshot({ health: 6, morale: 0 }), adapter.getResourcePaths(), liveActor());
  const health = deltas.find((delta) => delta.pool === "health");
  const morale = deltas.find((delta) => delta.pool === "morale");
  assert.equal(health.delta, -4);
  assert.equal(health.targetDowned, false);
  assert.equal(morale.delta, -3);
  assert.equal(morale.downState, "broken");
  assert.equal(morale.targetDowned, true);
  assert.equal(morale.secondary, true);
  assert.equal(health.secondary, undefined);
});

test("rising madness is mental damage, a full madness pool is insane", () => {
  const [delta] = adapter.detectResourceDeltas(snapshot({ morale: 0, madness: 28 }), snapshot({ morale: 0, madness: 30 }), adapter.getResourcePaths(), liveActor());
  assert.equal(delta.pool, "morale");
  assert.equal(delta.delta, -2);
  assert.equal(delta.interpretedAs, RESOURCE_INTERPRETATIONS.DAMAGE);
  assert.equal(delta.downState, "insane");
});

test("restored health and healed wounds are healing, action points are not tracked", () => {
  const [heal] = adapter.detectResourceDeltas(snapshot({ health: 0, wounds: 4 }), snapshot({ health: 5, wounds: 4 }), adapter.getResourcePaths(), liveActor());
  assert.equal(heal.delta, 5);
  assert.equal(heal.interpretedAs, RESOURCE_INTERPRETATIONS.HEALING);
  assert.equal(heal.oldValue, 0);
  assert.equal(heal.downState, "");
  const [rest] = adapter.detectResourceDeltas(snapshot({ health: 10, wounds: 6 }), snapshot({ health: 10, wounds: 2 }));
  assert.equal(rest.delta, 4);
  assert.equal(rest.interpretedAs, RESOURCE_INTERPRETATIONS.HEALING);

  const before = snapshot();
  const after = snapshot();
  after.system.resources.action.value = 2;
  assert.deepEqual(adapter.detectResourceDeltas(before, after), []);
});

test("Crucible rolls are classified from their class and card flags", () => {
  assert.deepEqual(adapter.classifyRoll(new AttackRoll(), { flags: { crucible: { action: {} } } }), { type: EVENT_TYPES.ROLL_ATTACK, confidence: CONFIDENCE.SAFE });
  assert.equal(adapter.classifyRoll(new StandardCheck(), { flags: { crucible: { skill: "athletics" } } }).type, EVENT_TYPES.ROLL_CHECK);
  assert.equal(adapter.classifyRoll(new InitiativeCheck(), { flags: {} }).type, EVENT_TYPES.ROLL_OTHER);
  assert.equal(adapter.classifyRoll({ formula: "3d8", total: 12 }, { flags: { crucible: { isInitiativeReport: true } } }).type, EVENT_TYPES.ROLL_OTHER);
  // Serialized rolls name their class.
  assert.equal(adapter.classifyRoll({ class: "AttackRoll", formula: "3d8", total: 12 }, {}).type, EVENT_TYPES.ROLL_ATTACK);
  assert.equal(adapter.skipRolls({ flags: { crucible: { isInitiativeReport: true } } }), true);
  assert.equal(adapter.skipRolls({ flags: { crucible: { isTurnChangeSummary: true } } }), true);
  assert.equal(adapter.skipRolls({ flags: { crucible: { action: {} } } }), false);
});

test("critical results come from the margin over the defense, not from a natural die", () => {
  const message = { flags: { crucible: { action: { name: "Strike", range: { category: "melee" } } } } };
  const crit = adapter.extractRollData(new AttackRoll({ isCriticalSuccess: true, isCriticalFailure: false, data: { dc: 12, damage: { type: "slashing" } } }), message);
  assert.equal(crit.isCritical, true);
  assert.equal(crit.isFumble, false);
  assert.deepEqual(crit.damageTypes, ["slashing"]);
  assert.equal(crit.actionName, "Strike");
  assert.equal(crit.actionKind, "melee");
  const fumble = adapter.extractRollData(new AttackRoll({ isCriticalSuccess: false, isCriticalFailure: true }), message);
  assert.equal(fumble.isFumble, true);
  // An initiative roll never counts as a critical hit.
  assert.equal(adapter.extractRollData(new InitiativeCheck({ isCriticalSuccess: true }), {}).isCritical, false);
});

test("action names and kinds come from the serialized action", () => {
  const describe = (action, extra = {}) => adapter.describeAction({ flags: { crucible: { action, ...extra } } });
  assert.deepEqual(describe({ id: "spell.flame.arrow.none", name: "Flame Arrow", tags: ["spell", "composed"] }, { item: "Actor.a.Item.b" }), { actionName: "Flame Arrow", actionKind: "spell", actionId: "spell.flame.arrow.none", itemUuid: "Actor.a.Item.b" });
  assert.equal(describe({ id: "strike", name: "Strike", tags: ["strike"], range: { category: "ranged" } }).actionKind, "ranged");
  assert.equal(describe({ id: "strike", name: "Strike", tags: ["melee"] }).actionKind, "melee");
  assert.equal(describe({ id: "recover", name: "Recover", tags: [] }).actionKind, "other");
  assert.equal(adapter.describeAction({ flavor: "Athletics", flags: { crucible: { skill: "athletics" } } }).actionName, "Athletics");
});

test("planned outcomes are grouped per target from the card's event stream", () => {
  const message = {
    rolls: [new AttackRoll({ isCriticalSuccess: true })],
    flags: {
      crucible: {
        actor: "Actor.hero",
        token: "Scene.s.Token.hero",
        action: { id: "strike", name: "Strike", tags: ["melee"], range: { category: "melee" } },
        confirmed: false,
        targets: [{ actor: "Scene.s.Token.orc.Actor.orcBase", token: "Scene.s.Token.orc" }],
        events: [
          { type: "activation", target: "Actor.hero", resources: [{ resource: "action", delta: -2 }], effects: [] },
          { type: "strike", target: "Scene.s.Token.orc.Actor.orcBase", rollIndex: 0, resources: [{ resource: "health", delta: -5, damageType: "slashing" }], effects: [{ statuses: ["bleeding"] }], isCriticalSuccess: true },
          { type: "strike", target: "Scene.s.Token.orc.Actor.orcBase", resources: [{ resource: "health", delta: -2 }, { resource: "wounds", delta: 3 }], effects: [{ _action: "delete", statuses: ["guarded"] }] },
          { type: "strike", target: "Scene.s.Token.orc.Actor.orcBase", negated: true, resources: [{ resource: "health", delta: -50 }], effects: [] },
          { type: "effect", target: "Actor.ally", resources: [{ resource: "morale", delta: 2 }], effects: [{ statuses: ["inspired"] }] }
        ]
      }
    }
  };
  const planned = adapter.extractPlannedAction(message);
  assert.equal(planned.actionName, "Strike");
  assert.equal(planned.actorUuid, "Actor.hero");
  assert.equal(planned.confirmed, false);
  assert.equal(planned.outcomes.length, 3);
  const self = planned.outcomes.find((outcome) => outcome.targetActorUuid === "Actor.hero");
  assert.deepEqual(self.pools, {});
  const orc = planned.outcomes.find((outcome) => outcome.targetTokenUuid === "Scene.s.Token.orc");
  assert.deepEqual(orc.resources, { health: -7, wounds: 3 });
  assert.deepEqual(orc.pools, { health: -10 });
  assert.deepEqual(orc.statuses, ["bleeding"]);
  assert.deepEqual(orc.damageTypes, ["slashing"]);
  assert.equal(orc.isCritical, true);
  const ally = planned.outcomes.find((outcome) => outcome.targetActorUuid === "Actor.ally");
  assert.deepEqual(ally.pools, { morale: 2 });
  assert.equal(adapter.extractPlannedAction({ flags: { crucible: { skill: "athletics" } } }), null);
});

test("targets, confirmation flags and chat text follow the Crucible card", () => {
  assert.deepEqual(adapter.extractMessageTargets({ flags: { crucible: { targets: [{ actor: "Scene.s.Token.t.Actor.a", token: null }, { actor: "Actor.b", token: "Scene.s.Token.b" }] } } }), {
    actorUuids: ["Scene.s.Token.t.Actor.a", "Actor.b"],
    tokenUuids: ["Scene.s.Token.t", "Scene.s.Token.b"],
    names: []
  });
  assert.equal(adapter.readConfirmation({}, { flags: { crucible: { confirmed: true } } }), true);
  assert.equal(adapter.readConfirmation({}, { flags: { crucible: { confirmed: false } } }), false);
  assert.equal(adapter.readConfirmation({}, { content: "x" }), null);
  assert.deepEqual(adapter.extractChatApplications({ content: "Orc takes 7 damage." }), []);
});

test("Crucible statuses: weakened, broken and insane are automatic, staggered is control, buffs are neither", () => {
  for (const status of ["weakened", "broken", "insane", "dead"]) assert.ok(adapter.automaticStatuses().includes(status), status);
  for (const status of ["staggered", "stunned", "frightened", "prone"]) assert.ok(adapter.controlStatuses().includes(status), status);
  for (const status of ["hastened", "resolute", "bleeding", "weakened"]) assert.ok(!adapter.controlStatuses().includes(status), status);
});

test("pool helpers", () => {
  assert.deepEqual(poolDeltas({ health: -3, wounds: 4, morale: 0, madness: 0, action: -2 }), { health: -7 });
  assert.deepEqual(poolDeltas({ morale: 5 }), { morale: 5 });
  assert.equal(__test__.tokenUuidFromActorUuid("Scene.a.Token.b.Actor.c"), "Scene.a.Token.b");
  assert.equal(__test__.tokenUuidFromActorUuid("Actor.c"), "");
  assert.equal(__test__.poolState("health", 0, 30, 30, true), "dead");
  assert.equal(__test__.poolState("morale", 5, 0, 30, true), "");
});
