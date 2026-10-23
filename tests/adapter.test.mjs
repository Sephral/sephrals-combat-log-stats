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

test("generic adapter keeps d20 rolls with advantage or disadvantage out of the damage rolls", () => {
  for (const formula of ["2d20kl + 5", "2d20kh1 + 3", "1d20 + 4"]) {
    assert.equal(adapter.classifyRoll({ formula, total: 1 }, { flavor: "" }).type, EVENT_TYPES.ROLL_OTHER, formula);
  }
  assert.equal(adapter.classifyRoll({ formula: "1d4", total: 1 }, { flavor: "" }).type, EVENT_TYPES.ROLL_DAMAGE);
});

test("generic adapter reads the token of an unlinked target named by its synthetic actor", () => {
  const targets = adapter.extractMessageTargets({ flags: { dnd5e: { targets: [{ name: "Ghost", uuid: "Scene.s1.Token.t1.Actor.a1" }, { name: "Hero", uuid: "Actor.hero" }] } } });
  assert.deepEqual(targets.tokenUuids, ["Scene.s1.Token.t1"]);
  assert.deepEqual(targets.actorUuids, ["Actor.hero"]);
});

test("dnd5e adapter classifies the rolls of a midi-qol item card by each roll's own type", () => {
  const dnd5e = new Dnd5eSystemAdapter();
  const message = { flags: { dnd5e: { messageType: "usage" }, "midi-qol": { sourceActorUuid: "Actor.hero" } } };
  const attack = { formula: "2d20kl + 5", total: 9, options: { rollType: "attack", "midi-qol": { rollType: "attack" } } };
  const damage = { formula: "1d8 + 3", total: 7, options: { rollType: "damage", type: "piercing", "midi-qol": { rollType: "defaultDamage" } } };
  const bonus = { formula: "1d6", total: 4, options: { "midi-qol": { rollType: "bonusDamage" } } };
  const healing = { formula: "1d8 + 3", total: 8, options: { rollType: "damage", type: "healing" } };
  assert.equal(dnd5e.classifyRoll(attack, message).type, EVENT_TYPES.ROLL_ATTACK);
  assert.equal(dnd5e.classifyRoll(damage, message).type, EVENT_TYPES.ROLL_DAMAGE);
  assert.equal(dnd5e.classifyRoll(bonus, message).type, EVENT_TYPES.ROLL_DAMAGE);
  assert.equal(dnd5e.classifyRoll(healing, message).type, EVENT_TYPES.ROLL_HEALING);
});

test("dnd5e adapter finds the attacker of a midi-qol application and tells an undo from an apply", async () => {
  const { __test__ } = await import("../scripts/adapters/dnd5e-adapter.js");
  const actor = { uuid: "Scene.s1.Token.t1.Actor.ghost" };
  const change = (from, to, temp = [0, 0]) => ({ value: [from, to], temp });
  const hit = (amount) => amount;
  assert.deepEqual(__test__.midiApplication(actor, change(39, 30), {}, hit(9)), { sourceActorUuid: "", reversal: false });
  assert.deepEqual(__test__.midiApplication(actor, change(39, 30), { midi: { sourceActorUuid: "Actor.hero" } }, hit(9)), { sourceActorUuid: "Actor.hero", reversal: false });
  // applyTokenDamage and overtime effects name the damaged actor: no attacker. Healing oneself stays.
  assert.deepEqual(__test__.midiApplication(actor, change(39, 30), { midi: { sourceActorUuid: actor.uuid } }, hit(9)), { sourceActorUuid: "", reversal: false });
  assert.deepEqual(__test__.midiApplication(actor, change(30, 39), { midi: { sourceActorUuid: actor.uuid } }, -9), { sourceActorUuid: actor.uuid, reversal: false });

  const older = { flags: { "midi-qol": { actorUuid: "Actor.mage", undoDamage: [{ actorUuid: actor.uuid, oldHP: 50, newHP: 45, oldTempHP: 0, newTempHP: 0 }] } } };
  const card = { flags: { "midi-qol": { actorUuid: "Actor.hero", undoDamage: [{ actorUuid: actor.uuid, oldHP: 45, newHP: 39, oldTempHP: 0, newTempHP: 0 }] } } };
  const shield = { flags: { "midi-qol": { actorUuid: "Actor.rogue", undoDamage: [{ actorUuid: actor.uuid, oldHP: 39, newHP: 39, oldTempHP: 5, newTempHP: 0 }] } } };
  globalThis.game = { ...(globalThis.game ?? {}), messages: { contents: [older, card] } };
  try {
    // The card's buttons may pass stored options without the attacker; the undo goes from 39 back to 45.
    assert.deepEqual(__test__.midiApplication(actor, change(39, 45), { midi: { itemType: "weapon" } }, -6), { sourceActorUuid: "Actor.hero", reversal: true });
    assert.deepEqual(__test__.midiApplication(actor, change(39, 45), { midi: { sourceActorUuid: "Actor.hero" } }, -6), { sourceActorUuid: "Actor.hero", reversal: true });
    // A new hit from 39 is no undo; applying the card again after an undo (45 back to 39) neither.
    assert.deepEqual(__test__.midiApplication(actor, change(39, 30), { midi: { sourceActorUuid: "Actor.hero" } }, 9), { sourceActorUuid: "Actor.hero", reversal: false });
    assert.deepEqual(__test__.midiApplication(actor, change(45, 39), { midi: { itemType: "weapon" } }, 6), { sourceActorUuid: "Actor.hero", reversal: false });
    // An older card can be undone too, and names its own attacker.
    assert.deepEqual(__test__.midiApplication(actor, change(45, 50), { midi: { itemType: "spell" } }, -5), { sourceActorUuid: "Actor.mage", reversal: true });
    // A hit that only took temporary hit points is undone by giving them back.
    game.messages.contents = [shield];
    assert.deepEqual(__test__.midiApplication(actor, change(39, 39, [0, 5]), { midi: { itemType: "weapon" } }, -5), { sourceActorUuid: "Actor.rogue", reversal: true });
  } finally {
    delete globalThis.game.messages;
  }
});

test("dnd5e adapter reads midi-qol's options on updates no hook announced, and skips GM copies of rolls", () => {
  const dnd5e = new Dnd5eSystemAdapter();
  const actor = { uuid: "Scene.s1.Token.t1.Actor.ghost" };
  const snapshot = (value, temp = 0) => ({ system: { attributes: { hp: { value, temp } } } });
  globalThis.game = { ...(globalThis.game ?? {}), messages: { contents: [] } };
  try {
    assert.equal(dnd5e.describeUpdateApplication(actor, snapshot(40), snapshot(31), {}), null);
    const application = dnd5e.describeUpdateApplication(actor, snapshot(40), snapshot(31), { midi: { sourceActorUuid: "Actor.hero" } });
    assert.equal(application.sourceActorUuid, "Actor.hero");
    assert.equal(application.amount, 9);
    assert.equal(application.reversal, false);
  } finally {
    delete globalThis.game.messages;
  }
  assert.equal(dnd5e.skipRolls({ flags: { "midi-qol": { gmHide: true } } }), true);
  assert.equal(dnd5e.skipRolls({ flags: { "midi-qol": {} } }), false);
  assert.equal(dnd5e.classifyRoll({ formula: "1d6", total: 3, options: { "midi-qol": { rollType: "utility" } } }, { flags: {} }).type, EVENT_TYPES.ROLL_OTHER);
});

test("dnd5e adapter recognises a re-created midi-qol card by its timestamp and speaker", () => {
  const dnd5e = new Dnd5eSystemAdapter();
  const first = { id: "first", timestamp: 1000, speaker: { actor: "hero", token: "t1" }, flags: { "midi-qol": {} } };
  const other = { id: "other", timestamp: 1000, speaker: { actor: "mage", token: "t2" }, flags: { "midi-qol": {} } };
  const copy = { id: "copy", timestamp: 1000, speaker: { actor: "hero", token: "t1" }, flags: { "midi-qol": {} } };
  globalThis.game = { ...(globalThis.game ?? {}), messages: { contents: [first, other, copy] } };
  try {
    assert.equal(dnd5e.findCopiedCard(copy), "first");
    assert.equal(dnd5e.findCopiedCard({ ...copy, timestamp: 2000 }), null);
    assert.equal(dnd5e.findCopiedCard({ ...copy, flags: {} }), null);
  } finally {
    delete globalThis.game.messages;
  }
});

// A button inside a chat card, as the click listener sees it.
function cardButton(messageId) {
  const card = { dataset: { messageId } };
  const button = { closest: (selector) => (selector.includes("data-message-id") ? card : button) };
  return button;
}

test("dnd5e adapter reads the rolls Ready Set Roll keeps in its flags", () => {
  const dnd5e = new Dnd5eSystemAdapter();
  const stored = [
    { class: "D20Roll", formula: "1d20 + 5", total: 17, options: { rollType: "attack" } },
    { class: "DamageRoll", formula: "2d6 + 2", total: 9, options: { rollType: "damage", type: "fire" } }
  ];
  const message = { rolls: [], flags: { rsr5e: { processed: true, rolls: stored } } };
  const previousRoll = globalThis.Roll;
  globalThis.Roll = class Roll { static fromData(data) { return Object.assign(new this(), data, { restored: true }); } };
  try {
    assert.deepEqual(dnd5e.messageRolls(message).map((roll) => [roll.restored, roll.total]), [[true, 17], [true, 9]]);
  } finally {
    if (previousRoll) globalThis.Roll = previousRoll;
    else delete globalThis.Roll;
  }
  // Without Foundry's Roll class the stored data is read as it is.
  assert.deepEqual(dnd5e.messageRolls(message).map((roll) => dnd5e.classifyRoll(roll, message).type), [EVENT_TYPES.ROLL_ATTACK, EVENT_TYPES.ROLL_DAMAGE]);
  assert.deepEqual(dnd5e.messageRolls({ rolls: [{ total: 3 }], flags: {} }).map((roll) => roll.total), [3]);
  assert.equal(dnd5e.rollsChanged({ flags: { rsr5e: { rolls: stored } } }), true);
  assert.equal(dnd5e.rollsChanged({ flags: { rsr5e: { processed: true } } }), false);
  assert.equal(adapter.rollsChanged({ flags: { rsr5e: { rolls: stored } } }), false);
});

test("dnd5e adapter reads the typed roll messages of dnd5e 6 (type, item, activity and targets in system data)", () => {
  const dnd5e = new Dnd5eSystemAdapter();
  const classify = (message, options = {}) => dnd5e.classifyRoll({ formula: "1d20 + 3", total: 14, options }, message).type;
  assert.equal(classify({ type: "check", system: { ability: "dex", skill: "ste" } }, { rollType: "check" }), EVENT_TYPES.ROLL_CHECK);
  assert.equal(classify({ type: "save", system: { type: "death" } }, { rollType: "save" }), EVENT_TYPES.ROLL_SAVE);
  assert.equal(classify({ type: "check", system: { ability: "dex", type: "initiative" } }), EVENT_TYPES.ROLL_OTHER);
  assert.equal(classify({ type: "attack", system: {} }), EVENT_TYPES.ROLL_ATTACK);
  assert.equal(dnd5e.classifyRoll({ formula: "2d4 + 2", total: 7, options: { type: "healing" } }, { type: "damage", system: {} }).type, EVENT_TYPES.ROLL_HEALING);

  const previous = globalThis.fromUuidSync;
  const bolt = { name: "Fire Bolt", type: "spell", uuid: "Actor.w.Item.bolt", system: { activities: { get: () => ({ type: "attack", attack: { type: { value: "ranged", classification: "spell" } } }) } } };
  globalThis.fromUuidSync = (uuid) => (uuid === bolt.uuid ? bolt : null);
  try {
    const message = { type: "damage", flavor: "Fire Bolt - Damage Roll", system: { item: { id: "bolt", type: "spell", uuid: bolt.uuid }, activity: { id: "act", type: "attack" } } };
    assert.deepEqual(dnd5e.describeAction(message), { actionName: "Fire Bolt", actionKind: "spell", itemUuid: bolt.uuid, itemType: "spell", activityType: "attack" });
  } finally {
    if (previous) globalThis.fromUuidSync = previous;
    else delete globalThis.fromUuidSync;
  }
  // A deleted item still names the action through the snapshot in system.deltas.deleted.
  const gone = { type: "attack", system: { item: { id: "axe", type: "weapon" }, deltas: { deleted: [{ _id: "axe", name: "Old Axe", type: "weapon", system: { type: { value: "martialM" } } }] } } };
  assert.equal(dnd5e.describeAction(gone).actionName, "Old Axe");

  const targets = dnd5e.extractMessageTargets({ type: "damage", system: { targets: [
    { actor: "Scene.s1.Token.t1.Actor.a1", token: "Scene.s1.Token.t1", name: "Orc", ac: 13 },
    { actor: "Actor.hero", token: "Scene.s1.Token.t2", name: "Hero", ac: 16 },
    { actor: "Actor.far", token: null, name: "Far Away" }
  ] } });
  assert.deepEqual(targets.tokenUuids, ["Scene.s1.Token.t1", "Scene.s1.Token.t2"]);
  assert.deepEqual(targets.actorUuids, ["Actor.hero", "Actor.far"]);
  assert.deepEqual(targets.names, ["Orc", "Hero", "Far Away"]);
});

test("dnd5e adapter takes the card whose button was just clicked, not for the token HUD, a check or an old click", async () => {
  const { __test__ } = await import("../scripts/adapters/dnd5e-adapter.js");
  const dnd5e = new Dnd5eSystemAdapter();
  const damageCard = { id: "dmg", flags: { rsr5e: { rolls: [{ formula: "1d8 + 3", total: 7, options: { rollType: "damage" } }] } } };
  const checkCard = { id: "check", flags: { dnd5e: { roll: { type: "skill" } } }, rolls: [{ formula: "1d20 + 2", total: 12, options: {} }] };
  globalThis.game = { ...(globalThis.game ?? {}), messages: { get: (id) => ({ dmg: damageCard, check: checkCard })[id] ?? null } };
  try {
    __test__.noteCardClick(cardButton("dmg"), 1000);
    assert.equal(dnd5e.clickedDamageCard({ multiplier: 1 }, 1500), damageCard);
    // dnd5e 5.2's tray passes isDelta with a multiplier, the token HUD isDelta alone.
    assert.equal(dnd5e.clickedDamageCard({ multiplier: 1, isDelta: true }, 1500), damageCard);
    assert.equal(dnd5e.clickedDamageCard({ isDelta: true }, 1500), null);
    assert.equal(dnd5e.clickedDamageCard({ multiplier: 1 }, 4500), null);
    __test__.noteCardClick(cardButton("check"), 5000);
    assert.equal(dnd5e.clickedDamageCard({}, 5100), null);
    // A click outside any card (the token HUD) forgets the card.
    __test__.noteCardClick(cardButton("dmg"), 6000);
    __test__.noteCardClick({ closest: () => null }, 6100);
    assert.equal(dnd5e.clickedDamageCard({}, 6200), null);
  } finally {
    delete globalThis.game.messages;
  }
});
