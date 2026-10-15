import assert from "node:assert/strict";
import { test } from "node:test";
import { CONFIDENCE, EVENT_TYPES, RESOURCE_INTERPRETATIONS, SETTINGS, SHARE_MODES } from "../scripts/constants.js";

const settings = new Map([
  [`sephrals-combat-log-stats.${SETTINGS.DEFAULT_SHARE_MODE}`, SHARE_MODES.FULL_VISIBLE_RECAP],
  [`sephrals-combat-log-stats.${SETTINGS.DEFAULT_ANONYMIZE_ENEMIES}`, false],
  [`sephrals-combat-log-stats.${SETTINGS.TRACK_ACTIVE_EFFECTS}`, true],
  [`sephrals-combat-log-stats.${SETTINGS.RESOURCE_DELTA_WINDOW_MS}`, 3000],
  [`sephrals-combat-log-stats.${SETTINGS.INCLUDE_UNCLEAR_DELTAS_IN_STATS}`, false],
  [`sephrals-combat-log-stats.${SETTINGS.DEFAULT_DPR_METHOD}`, "appliedNet"]
]);

globalThis.game = {
  user: { id: "gm", isGM: true },
  system: { id: "generic" },
  world: { id: "test-world" },
  version: "13.351",
  settings: {
    get: (moduleId, key) => settings.get(`${moduleId}.${key}`),
    set: async (moduleId, key, value) => settings.set(`${moduleId}.${key}`, value)
  },
  modules: { get: () => ({ version: "0.1.0" }) },
  combats: { contents: [] }
};

const hookCalls = [];
globalThis.Hooks = { callAll: (...args) => hookCalls.push(args) };

const { CombatLogService } = await import("../scripts/services/combat-log-service.js");

test("new combat logs use configured sharing defaults without auto-sharing", async () => {
  const service = new CombatLogService();
  service.persistence.saveLog = async (log) => log;
  const combat = { id: "combat1", uuid: "Combat.combat1", round: 1, turn: 0, combatants: [], scene: { uuid: "Scene.test", name: "Test Scene" } };
  game.combats.contents = [combat];

  const log = await service.startCombat(combat);

  assert.equal(log.shareSettings.isShared, false);
  assert.equal(log.shareSettings.shareMode, SHARE_MODES.FULL_VISIBLE_RECAP);
  assert.equal(log.shareSettings.anonymizeEnemies, false);
});

test("prepared encounters get no log until the combat starts", async () => {
  const service = new CombatLogService();
  service.persistence.saveLog = async (log) => log;
  const combat = { id: "prepared", uuid: "Combat.prepared", round: 0, turn: null, started: false, combatants: [], scene: { uuid: "Scene.test", name: "Test Scene" } };
  game.combats.contents = [combat];

  assert.equal(await service.startCombat(combat), null);
  assert.equal(await service.ensureLogForCombat(combat), null);
  assert.equal(await service.combatantCreated({ id: "c1", combat, name: "Hero" }), null);
  assert.equal(await service.deleteCombat(combat), null);
  assert.equal(service.activeLogs.size, 0);

  // combatStart fires before round 1 is written, so it forces the log.
  const log = await service.startCombat(combat, { force: true });
  assert.equal(log.combatId, "prepared");
  assert.equal(service.activeLogs.get("prepared"), log);
});

function effectFixture() {
  const hero = { id: "hero-actor", uuid: "Actor.hero-actor", documentName: "Actor", system: { attributes: { hp: { value: 20 } } } };
  const foe = { id: "foe-actor", uuid: "Scene.test.Token.foe-token.Actor.foe-actor", documentName: "Actor", isToken: true, token: { uuid: "Scene.test.Token.foe-token" }, system: { attributes: { hp: { value: 12 } } } };
  const combat = { id: "combat1", uuid: "Combat.combat1", round: 2, turn: 0, combatant: { id: "hero" }, combatants: [], scene: { uuid: "Scene.test" } };
  const log = {
    id: "log1",
    combatId: combat.id,
    combatUuid: combat.uuid,
    sceneUuid: "Scene.test",
    participants: [
      { combatantId: "hero", actorId: hero.id, actorUuid: hero.uuid, actorLink: true, tokenUuid: "Scene.test.Token.hero-token", name: "Hero", side: "friendly" },
      { combatantId: "foe", actorId: "foe-actor", actorUuid: foe.uuid, actorLink: false, tokenUuid: "Scene.test.Token.foe-token", name: "Foe", side: "hostile" }
    ],
    sessionSegments: [],
    events: []
  };
  game.combats.contents = [combat];
  return { hero, foe, combat, log };
}

test("a condition put on an enemy during a hero's turn counts as the hero's control play", async () => {
  const service = new CombatLogService({ persistDelayMs: 0 });
  service.persistence.saveLog = async (log) => log;
  const { foe, combat, log } = effectFixture();
  service.activeLogs.set(combat.id, log);

  await service.activeEffectChanged(EVENT_TYPES.ACTIVE_EFFECT_CREATED, { id: "prone", uuid: `${foe.uuid}.ActiveEffect.prone`, parent: foe, name: "Prone", statuses: new Set(["prone"]), disabled: false }, {});

  assert.equal(log.events.length, 1);
  assert.equal(log.events[0].combatantId, "hero");
  assert.equal(log.events[0].data.sourceCombatantId, "hero");
  assert.equal(log.events[0].data.targetCombatantId, "foe");
  assert.equal(log.events[0].data.control, true);
  assert.equal(log.events[0].data.sourceGuessed, true);
  assert.equal(log.events[0].confidence, CONFIDENCE.PROBABLE);
});

test("automatic states and item effects are no control plays", async () => {
  const service = new CombatLogService({ persistDelayMs: 0 });
  service.persistence.saveLog = async (log) => log;
  const { hero, foe, combat, log } = effectFixture();
  service.activeLogs.set(combat.id, log);

  await service.activeEffectChanged(EVENT_TYPES.ACTIVE_EFFECT_CREATED, { id: "bloodied", parent: foe, name: "Bloodied", statuses: new Set(["bloodied"]) }, {});
  await service.activeEffectChanged(EVENT_TYPES.ACTIVE_EFFECT_CREATED, { id: "item-effect", parent: { documentName: "Item", actor: hero }, name: "Bless", statuses: new Set() }, {});
  await service.activeEffectChanged(EVENT_TYPES.ACTIVE_EFFECT_UPDATED, { id: "tick", parent: foe, name: "Prone", statuses: new Set(["prone"]) }, { duration: { rounds: 1 } });

  assert.equal(log.events.length, 1);
  assert.equal(log.events[0].data.name, "Bloodied");
  assert.equal(log.events[0].data.control, false);
});

test("saving an active log clone refreshes the active combat state", async () => {
  const service = new CombatLogService();
  service.persistence.saveLog = async (log) => log;
  const original = { id: "log1", combatId: "combat1", sceneUuid: "Scene.test", participants: [], sessionSegments: [], events: [], shareSettings: { isShared: false } };
  const edited = { ...original, shareSettings: { isShared: true, shareMode: SHARE_MODES.SUMMARY_ONLY } };
  service.activeLogs.set("combat1", original);

  await service.saveAndCompute(edited);

  assert.equal(service.activeLogs.get("combat1"), edited);
  assert.equal(service.activeLogs.get("combat1").shareSettings.isShared, true);
});

test("deleting a log removes matching active combat state", async () => {
  hookCalls.length = 0;
  const service = new CombatLogService();
  let deletedId = null;
  service.persistence.deleteLog = async (logId) => {
    deletedId = logId;
    return true;
  };
  service.activeLogs.set("combat1", { id: "log1", combatId: "combat1", events: [], participants: [] });

  assert.equal(await service.deleteLog("log1"), true);
  assert.equal(deletedId, "log1");
  assert.equal(service.activeLogs.has("combat1"), false);
  assert.equal(hookCalls.at(-1)[1].deleted, true);
});

test("auto end reports prepare sharing for unshared logs", async () => {
  settings.set(`sephrals-combat-log-stats.${SETTINGS.AUTO_POST_PLAYER_SUMMARY_ON_END}`, true);
  settings.set(`sephrals-combat-log-stats.${SETTINGS.DEFAULT_SHARE_MODE}`, SHARE_MODES.GM_ONLY);
  settings.set(`sephrals-combat-log-stats.${SETTINGS.DEFAULT_ANONYMIZE_ENEMIES}`, false);
  const service = new CombatLogService();
  let postedShareSettings = null;
  service.playerReports.postChatSummary = async (log) => {
    postedShareSettings = { ...log.shareSettings };
    return { id: "chat1" };
  };
  const log = { id: "log1", combatId: "combat1", sceneUuid: "Scene.test", participants: [], sessionSegments: [], events: [], shareSettings: { isShared: false, shareMode: SHARE_MODES.GM_ONLY } };

  await service.runEndOfCombatReports(log);

  assert.equal(postedShareSettings.isShared, true);
  assert.equal(postedShareSettings.shareMode, SHARE_MODES.SUMMARY_ONLY);
  assert.equal(postedShareSettings.allowPlayersToOpenReport, true);
  assert.equal(postedShareSettings.anonymizeEnemies, false);
  settings.delete(`sephrals-combat-log-stats.${SETTINGS.AUTO_POST_PLAYER_SUMMARY_ON_END}`);
  settings.set(`sephrals-combat-log-stats.${SETTINGS.DEFAULT_SHARE_MODE}`, SHARE_MODES.FULL_VISIBLE_RECAP);
});

test("deleting an active Foundry combat ends the log and runs auto reports", async () => {
  settings.set(`sephrals-combat-log-stats.${SETTINGS.AUTO_POST_PLAYER_SUMMARY_ON_END}`, true);
  const service = new CombatLogService();
  const savedStatuses = [];
  let posted = false;
  service.persistence.saveLog = async (log) => {
    savedStatuses.push(log.status);
    return log;
  };
  service.playerReports.postChatSummary = async () => {
    posted = true;
    return { id: "chat1" };
  };
  const combat = { id: "combat1", uuid: "Combat.combat1", round: 3, turn: 2, combatants: [], scene: { uuid: "Scene.test" } };
  const log = { id: "log1", combatId: combat.id, combatUuid: combat.uuid, sceneUuid: "Scene.test", participants: [], sessionSegments: [{ id: "segment1", startedAt: "2026-05-19T10:00:00.000Z", endedAt: null, reason: "combatStarted" }], events: [], shareSettings: { isShared: false } };
  service.activeLogs.set(combat.id, log);

  const ended = await service.deleteCombat(combat);

  assert.equal(ended.status, "ended");
  assert.ok(ended.endedAt);
  assert.equal(service.activeLogs.has(combat.id), false);
  assert.equal(posted, true);
  assert.deepEqual(savedStatuses, ["ended", "ended"]);
  settings.delete(`sephrals-combat-log-stats.${SETTINGS.AUTO_POST_PLAYER_SUMMARY_ON_END}`);
});

test("ready resumes stored active logs only on GM clients", async () => {
  const orphan = { id: "log1", combatId: "gone", combatUuid: "Combat.gone", status: "active", participants: [], sessionSegments: [], events: [] };
  const createService = (saved) => {
    const service = new CombatLogService();
    service.persistence.loadActiveLogs = async () => [structuredClone(orphan)];
    service.persistence.saveLog = async (log) => {
      saved.push(log.status);
      return log;
    };
    return service;
  };
  game.combats.contents = [];

  const playerSaves = [];
  game.user.isGM = false;
  try {
    await createService(playerSaves).ready();
  } finally {
    game.user.isGM = true;
  }
  assert.deepEqual(playerSaves, []);

  const gmSaves = [];
  await createService(gmSaves).ready();
  assert.deepEqual(gmSaves, ["orphaned"]);
});
test("chat events record the message author without the deprecated user field", async () => {
  const service = new CombatLogService();
  service.saveAndCompute = async (log) => log;
  service.recordRolls = () => {};
  service.recordChatApplications = () => {};
  const log = { id: "log-chat", combatId: "combat-chat", participants: [], sessionSegments: [], events: [] };
  service.findLogForMessage = () => log;
  service.findCombatForLog = () => ({ id: "combat-chat", round: 1, turn: 0 });
  const deprecatedUser = () => {
    throw new Error("the deprecated user field should not be read");
  };

  await service.chatMessageCreated({ id: "m1", speaker: {}, author: { id: "player1" }, get user() { return deprecatedUser(); } });
  await service.chatMessageCreated({ id: "m2", speaker: {}, _source: { author: "player2", get user() { return deprecatedUser(); } } });

  assert.deepEqual(log.events.map((event) => event.userId), ["player1", "player2"]);
});

function hpActor({ id, uuid, hp, temp = 0, token = null }) {
  return {
    id,
    uuid,
    documentName: "Actor",
    isToken: Boolean(token),
    token,
    system: { attributes: { hp: { value: hp, temp, tempmax: 0, max: 30 } } },
    toObject() {
      return { system: structuredClone(this.system) };
    }
  };
}

function hpLog() {
  const combat = { id: "combat-hp", uuid: "Combat.combat-hp", round: 1, turn: 0, combatant: { id: "hero" }, combatants: [], scene: { uuid: "Scene.test" } };
  const log = {
    id: "log-hp",
    combatId: combat.id,
    combatUuid: combat.uuid,
    sceneUuid: "Scene.test",
    participants: [
      { combatantId: "hero", actorId: "hero-actor", actorUuid: "Actor.hero-actor", actorLink: true, tokenUuid: "Scene.test.Token.hero-token", name: "Hero", side: "friendly" },
      { combatantId: "goblin1", actorId: "goblin", actorUuid: "Scene.test.Token.g1.Actor.goblin", actorLink: false, tokenUuid: "Scene.test.Token.g1", name: "Goblin 1", side: "hostile" },
      { combatantId: "goblin2", actorId: "goblin", actorUuid: "Scene.test.Token.g2.Actor.goblin", actorLink: false, tokenUuid: "Scene.test.Token.g2", name: "Goblin 2", side: "hostile" }
    ],
    latestSnapshots: {},
    sessionSegments: [],
    events: []
  };
  game.combats.contents = [combat];
  return { combat, log };
}

async function applyHp(service, actor, changes) {
  service.actorSnapshots.set(actor.uuid, actor.toObject());
  Object.assign(actor.system.attributes.hp, changes);
  return service.actorUpdated(actor, {}, {}, "gm");
}

test("damage to an unlinked token is credited to that token, not to another token of the same actor", async () => {
  const service = new CombatLogService({ persistDelayMs: 0 });
  service.persistence.saveLog = async (log) => log;
  const { combat, log } = hpLog();
  service.activeLogs.set(combat.id, log);
  const goblin2 = hpActor({ id: "goblin", uuid: "Scene.test.Token.g2.Actor.goblin", hp: 7, token: { uuid: "Scene.test.Token.g2" } });

  await applyHp(service, goblin2, { value: 2 });

  const delta = log.events.find((event) => event.type === EVENT_TYPES.RESOURCE_DELTA);
  assert.equal(delta.combatantId, "goblin2");
  assert.equal(delta.data.targetCombatantId, "goblin2");
});

test("a system damage application credits the speaker of its roll message, including temp HP and the killing blow", async () => {
  const service = new CombatLogService({ persistDelayMs: 0 });
  service.persistence.saveLog = async (log) => log;
  const { combat, log } = hpLog();
  service.activeLogs.set(combat.id, log);
  const goblin1 = hpActor({ id: "goblin", uuid: "Scene.test.Token.g1.Actor.goblin", hp: 5, temp: 3, token: { uuid: "Scene.test.Token.g1" } });
  const message = { id: "msg-hit", speaker: { scene: "test", token: "hero-token", actor: "hero-actor" }, flavor: "Longsword", flags: {} };

  service.noteSystemApplication(goblin1, { amount: 20, message });
  await applyHp(service, goblin1, { value: 0, temp: 0 });

  const deltas = log.events.filter((event) => event.type === EVENT_TYPES.RESOURCE_DELTA);
  assert.equal(deltas.length, 2);
  for (const delta of deltas) {
    assert.equal(delta.combatantId, "hero");
    assert.equal(delta.data.attribution, "systemApplied");
    assert.equal(delta.data.targetCombatantId, "goblin1");
    assert.equal(delta.data.interpretedAs, RESOURCE_INTERPRETATIONS.DAMAGE);
    assert.equal(delta.confidence, CONFIDENCE.SAFE);
  }
  assert.equal(deltas.find((delta) => delta.data.resourcePath.endsWith("hp.value")).data.targetDowned, true);
  assert.equal(deltas.find((delta) => delta.data.resourcePath.endsWith("hp.temp")).data.absorbedByTempHp, true);
  assert.equal(log.computed.summary.netDamageApplied, 8);
  assert.equal(log.computed.summary.enemiesDefeated, 1);
  assert.equal(log.computed.byCombatant.find((row) => row.id === "hero").takedowns, 1);
});

test("a midi-qol application without a message credits the attacker it names, also an unlinked token", async () => {
  const service = new CombatLogService({ persistDelayMs: 0 });
  service.persistence.saveLog = async (log) => log;
  const { combat, log } = hpLog();
  service.activeLogs.set(combat.id, log);
  const goblin1 = hpActor({ id: "goblin", uuid: "Scene.test.Token.g1.Actor.goblin", hp: 7, token: { uuid: "Scene.test.Token.g1" } });
  const hero = hpActor({ id: "hero-actor", uuid: "Actor.hero-actor", hp: 20 });

  service.noteSystemApplication(goblin1, { amount: 6, sourceActorUuid: "Actor.hero-actor" });
  await applyHp(service, goblin1, { value: 1 });
  service.noteSystemApplication(hero, { amount: 4, sourceActorUuid: "Scene.test.Token.g2.Actor.goblin" });
  await applyHp(service, hero, { value: 16 });

  const [hit, counter] = log.events.filter((event) => event.type === EVENT_TYPES.RESOURCE_DELTA);
  assert.equal(hit.combatantId, "hero");
  assert.equal(hit.data.targetCombatantId, "goblin1");
  assert.equal(counter.combatantId, "goblin2");
  assert.equal(counter.data.targetCombatantId, "hero");
  assert.equal(log.computed.byCombatant.find((row) => row.id === "hero").damageAppliedNet, 6);
});

test("an undo from midi-qol's damage card corrects the hit it takes back, credited to the same attacker", async () => {
  const service = new CombatLogService({ persistDelayMs: 0 });
  service.persistence.saveLog = async (log) => log;
  const { combat, log } = hpLog();
  service.activeLogs.set(combat.id, log);
  const goblin1 = hpActor({ id: "goblin", uuid: "Scene.test.Token.g1.Actor.goblin", hp: 7, token: { uuid: "Scene.test.Token.g1" } });

  service.noteSystemApplication(goblin1, { amount: 7, sourceActorUuid: "Actor.hero-actor" });
  await applyHp(service, goblin1, { value: 0 });
  service.noteSystemApplication(goblin1, { amount: -7, sourceActorUuid: "Actor.hero-actor", reversal: true });
  await applyHp(service, goblin1, { value: 7 });

  const [hit, undo] = log.events.filter((event) => event.type === EVENT_TYPES.RESOURCE_DELTA);
  assert.equal(hit.data.reversed, true);
  assert.equal(undo.data.interpretedAs, RESOURCE_INTERPRETATIONS.CORRECTION_DAMAGE_DOWN);
  assert.equal(undo.data.reversalOf, hit.id);
  assert.equal(undo.combatantId, "hero");
  assert.equal(log.computed.summary.netDamageApplied, 0);
  assert.equal(log.computed.summary.netHealingApplied, 0);
  assert.equal(log.computed.summary.enemiesDefeated, 0);
  assert.equal(log.computed.byCombatant.find((row) => row.id === "hero").damageAppliedNet, 0);
  assert.equal(log.computed.byCombatant.find((row) => row.id === "goblin1").damageTakenNet, 0);
});

test("rolls added to a card later (midi-qol) are recorded once each", async () => {
  const service = new CombatLogService({ persistDelayMs: 0 });
  service.persistence.saveLog = async (log) => log;
  const { combat, log } = hpLog();
  service.activeLogs.set(combat.id, log);
  class DamageRoll { constructor(total) { this.total = total; this.formula = "1d8 + 3"; this.dice = []; this.options = {}; } }
  const message = { id: "card", speaker: { scene: "test", token: "hero-token", actor: "hero-actor" }, flags: {}, rolls: [] };

  await service.chatMessageCreated(message);
  message.rolls = [new DamageRoll(7)];
  await service.chatMessageUpdated(message, { rolls: message.rolls });
  await service.chatMessageUpdated(message, { rolls: message.rolls, flags: {} });
  message.rolls = [...message.rolls, new DamageRoll(4)];
  await service.chatMessageUpdated(message, { rolls: message.rolls });

  const rolls = log.events.filter((event) => event.type === EVENT_TYPES.ROLL_DAMAGE);
  assert.deepEqual(rolls.map((event) => [event.combatantId, event.data.total]), [["hero", 7], ["hero", 4]]);
});

test("a replaced roll takes over its event, rolls the card lost are dropped, a re-created card adds nothing", async () => {
  const service = new CombatLogService({ persistDelayMs: 0 });
  service.persistence.saveLog = async (log) => log;
  const { combat, log } = hpLog();
  service.activeLogs.set(combat.id, log);
  class D20Roll { constructor(total) { this.total = total; this.formula = "1d20 + 5"; this.dice = [{ faces: 20, results: [{ result: total - 5 }] }]; this.options = {}; } }
  class DamageRoll { constructor(total) { this.total = total; this.formula = "1d8 + 3"; this.dice = [{ faces: 8, results: [{ result: total - 3 }] }]; this.options = {}; } }
  const message = { id: "card", timestamp: 1000, speaker: { scene: "test", token: "hero-token", actor: "hero-actor" }, flags: {}, rolls: [] };
  const types = () => log.events.filter((event) => event.source?.kind === "roll").map((event) => `${event.type}:${event.data.total}`);

  await service.chatMessageCreated(message);
  message.rolls = [new D20Roll(12), new DamageRoll(7)];
  await service.chatMessageUpdated(message, { rolls: message.rolls });
  const damageId = log.events.find((event) => event.type === EVENT_TYPES.ROLL_DAMAGE).id;
  // Damage rolled again: same place, new result.
  message.rolls = [new D20Roll(12), new DamageRoll(10)];
  await service.chatMessageUpdated(message, { rolls: message.rolls });
  assert.deepEqual(types(), ["roll.other:12", "roll.damage:10"]);
  assert.equal(log.events.find((event) => event.type === EVENT_TYPES.ROLL_DAMAGE).id, damageId);
  // Attack rolled again: the card starts over with the attack only.
  message.rolls = [new D20Roll(18)];
  await service.chatMessageUpdated(message, { rolls: message.rolls });
  assert.deepEqual(types(), ["roll.other:18"]);
  message.rolls = [new D20Roll(18), new DamageRoll(6)];
  await service.chatMessageUpdated(message, { rolls: message.rolls });

  // midi-qol re-creates the finished card with its old rolls and adds a new damage roll.
  service.adapter.findCopiedCard = (created) => (created.id === "copy" ? "card" : null);
  try {
    const copy = { ...message, id: "copy", rolls: [...message.rolls] };
    await service.chatMessageCreated(copy);
    assert.deepEqual(types(), ["roll.other:18", "roll.damage:6"]);
    copy.rolls = [...copy.rolls, new DamageRoll(4)];
    await service.chatMessageUpdated(copy, { rolls: copy.rolls });
    assert.deepEqual(types(), ["roll.other:18", "roll.damage:6", "roll.damage:4"]);
  } finally {
    delete service.adapter.findCopiedCard;
  }
});

test("an application that changed nothing is not credited to the next change of that actor", async () => {
  const service = new CombatLogService({ persistDelayMs: 0 });
  service.persistence.saveLog = async (log) => log;
  const { combat, log } = hpLog();
  service.activeLogs.set(combat.id, log);
  const goblin1 = hpActor({ id: "goblin", uuid: "Scene.test.Token.g1.Actor.goblin", hp: 7, token: { uuid: "Scene.test.Token.g1" } });

  // Immune: the hero's hit writes the same 7 hit points, no update follows.
  service.noteSystemApplication(goblin1, { amount: 0, sourceActorUuid: "Actor.hero-actor", expected: { value: 7, temp: 0 } });
  // A goblin's own ability costs it 2 hit points a moment later.
  await applyHp(service, goblin1, { value: 5 });
  const delta = log.events.find((event) => event.type === EVENT_TYPES.RESOURCE_DELTA);
  assert.notEqual(delta.data.attribution, "systemApplied");
  assert.equal(log.computed.byCombatant.find((row) => row.id === "hero").damageAppliedNet, 0);
});

test("dnd5e 5.2's tray passes no message: the change is matched to the targeted roll instead", async () => {
  const service = new CombatLogService({ persistDelayMs: 0 });
  service.persistence.saveLog = async (log) => log;
  const { combat, log } = hpLog();
  service.activeLogs.set(combat.id, log);
  class DamageRoll { constructor(total) { this.total = total; this.formula = "1d8 + 3"; this.dice = []; this.options = {}; } }
  const goblin1 = hpActor({ id: "goblin", uuid: "Scene.test.Token.g1.Actor.goblin", hp: 7, token: { uuid: "Scene.test.Token.g1" } });
  await service.chatMessageCreated({ id: "dmg", speaker: { scene: "test", token: "hero-token", actor: "hero-actor" }, flags: { dnd5e: { targets: [{ name: "Goblin 1", uuid: "Scene.test.Token.g1.Actor.goblin" }] } }, rolls: [new DamageRoll(6)] });

  service.noteSystemApplication(goblin1, { amount: 6, expected: { value: 1, temp: 0 } });
  await applyHp(service, goblin1, { value: 1 });

  const delta = log.events.find((event) => event.type === EVENT_TYPES.RESOURCE_DELTA);
  assert.equal(delta.combatantId, "hero");
  assert.equal(delta.data.attribution, "correlatedChatRoll");
});

test("midi-qol damage applied on another client is credited through the update options", async () => {
  const service = new CombatLogService({ persistDelayMs: 0 });
  service.persistence.saveLog = async (log) => log;
  const { combat, log } = hpLog();
  service.activeLogs.set(combat.id, log);
  const goblin1 = hpActor({ id: "goblin", uuid: "Scene.test.Token.g1.Actor.goblin", hp: 7, token: { uuid: "Scene.test.Token.g1" } });
  const system = game.system.id;
  game.system.id = "dnd5e";
  game.messages = { contents: [] };
  try {
    service.actorSnapshots.set(goblin1.uuid, goblin1.toObject());
    goblin1.system.attributes.hp.value = 2;
    await service.actorUpdated(goblin1, {}, { midi: { sourceActorUuid: "Actor.hero-actor" } }, "other-gm");
  } finally {
    game.system.id = system;
    delete game.messages;
  }
  const delta = log.events.find((event) => event.type === EVENT_TYPES.RESOURCE_DELTA);
  assert.equal(delta.combatantId, "hero");
  assert.equal(delta.data.attribution, "systemApplied");
});

test("hit point changes without a snapshot of the old state are skipped instead of guessed", async () => {
  const service = new CombatLogService({ persistDelayMs: 0 });
  service.persistence.saveLog = async (log) => log;
  const { combat, log } = hpLog();
  service.activeLogs.set(combat.id, log);
  const hero = hpActor({ id: "hero-actor", uuid: "Actor.hero-actor", hp: 20 });

  hero.system.attributes.hp.value = 15;
  await service.actorUpdated(hero, {}, {}, "gm");

  assert.equal(log.events.length, 0);
  assert.equal(service.actorSnapshots.has(hero.uuid), true);
});

test("resuming a log only reports hit point changes made while nobody tracked the combat", async () => {
  const service = new CombatLogService({ persistDelayMs: 0 });
  service.persistence.saveLog = async (log) => log;
  const { log } = hpLog();
  const hero = hpActor({ id: "hero-actor", uuid: "Actor.hero-actor", hp: 12 });
  const goblin1 = hpActor({ id: "goblin", uuid: "Scene.test.Token.g1.Actor.goblin", hp: 7, token: { uuid: "Scene.test.Token.g1" } });
  log.latestSnapshots = {
    hero: { "system.attributes.hp.value": 12, "system.attributes.hp.temp": 0, "system.attributes.hp.tempmax": 0, "system.attributes.hp.max": 30 },
    goblin1: { "system.attributes.hp.value": 9, "system.attributes.hp.temp": 0, "system.attributes.hp.tempmax": 0, "system.attributes.hp.max": 30 }
  };
  const combat = { id: log.combatId, round: 2, turn: 0, combatants: [{ id: "hero", actor: hero }, { id: "goblin1", actor: goblin1 }, { id: "goblin2", actor: null }] };

  await service.detectOfflineDeltas(log, combat);

  const offline = log.events.filter((event) => event.type === EVENT_TYPES.RESOURCE_DELTA_OFFLINE);
  assert.equal(offline.length, 1);
  assert.equal(offline[0].combatantId, "goblin1");
  assert.equal(offline[0].data.delta, -2);
});

test("event bursts are written once after the delay, lifecycle changes right away", async () => {
  const service = new CombatLogService({ persistDelayMs: 30 });
  const writes = [];
  service.persistence.saveLog = async (log) => {
    writes.push(log.events.length);
    return log;
  };
  const log = { id: "log-burst", combatId: "combat-burst", participants: [], sessionSegments: [], events: [] };

  log.events.push({ id: "e1", type: EVENT_TYPES.CHAT_MESSAGE_CREATED, data: {} });
  await service.saveAndCompute(log);
  log.events.push({ id: "e2", type: EVENT_TYPES.CHAT_MESSAGE_CREATED, data: {} });
  await service.saveAndCompute(log);
  assert.deepEqual(writes, []);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(writes, [2]);

  log.events.push({ id: "e3", type: EVENT_TYPES.CHAT_MESSAGE_CREATED, data: {} });
  await service.saveAndCompute(log, { immediate: true });
  assert.deepEqual(writes, [2, 3]);
});

test("a second GM client does not record anything", async () => {
  game.users = { activeGM: { id: "other-gm" } };
  const previousId = game.user.id;
  game.user.id = "gm";
  try {
    const service = new CombatLogService({ persistDelayMs: 0 });
    service.noteSystemApplication({ uuid: "Actor.x" }, { amount: 5 });
  } finally {
    delete game.users;
    game.user.id = previousId;
  }
});

test("manual adjustments and source corrections are stored as GM events", () => {
  const service = new CombatLogService({ persistDelayMs: 0 });
  const { log } = hpLog();
  log.events.push({ id: "unknown-hit", type: EVENT_TYPES.RESOURCE_DELTA, combatantId: "goblin1", confidence: CONFIDENCE.PROBABLE, data: { delta: -4, interpretedAs: RESOURCE_INTERPRETATIONS.DAMAGE, targetCombatantId: "goblin1" } });

  service.setEventSource(log, "unknown-hit", "hero");
  const added = service.addManualAdjustment(log, { type: EVENT_TYPES.HEALING_MANUAL_ADDED, amount: 6, sourceCombatantId: "hero", targetCombatantId: "hero", note: "potion" });
  const rejected = service.addManualAdjustment(log, { type: "nonsense", amount: 3 });

  assert.equal(log.events[0].combatantId, "hero");
  assert.equal(log.events[0].data.attribution, "manualSource");
  assert.equal(log.events[0].data.targetCombatantId, "goblin1");
  assert.equal(added.type, EVENT_TYPES.HEALING_MANUAL_ADDED);
  assert.equal(added.data.amount, 6);
  assert.equal(rejected, null);
});

test("a GM that hands over recording writes pending changes and lets go of the running logs", async () => {
  const service = new CombatLogService({ persistDelayMs: 10000 });
  const writes = [];
  service.persistence.saveLog = async (log) => {
    writes.push(log.id);
    return log;
  };
  const log = { id: "log-handover", combatId: "combat-handover", participants: [], sessionSegments: [], events: [] };
  service.activeLogs.set(log.combatId, log);
  service.actorSnapshots.set("Actor.x", {});
  log.events.push({ id: "e1", type: EVENT_TYPES.CHAT_MESSAGE_CREATED, data: {} });
  await service.saveAndCompute(log);
  assert.deepEqual(writes, []);

  await service.releaseLogs();

  assert.deepEqual(writes, ["log-handover"]);
  assert.equal(service.activeLogs.size, 0);
  assert.equal(service.actorSnapshots.size, 0);
});

test("auto end reports leave the combat private while player reports are turned off", async () => {
  settings.set(`sephrals-combat-log-stats.${SETTINGS.AUTO_POST_PLAYER_SUMMARY_ON_END}`, true);
  settings.set(`sephrals-combat-log-stats.${SETTINGS.ENABLE_PLAYER_SHARING}`, false);
  try {
    const service = new CombatLogService();
    let posted = false;
    service.playerReports.postChatSummary = async () => {
      posted = true;
      return { id: "chat1" };
    };
    const log = { id: "log1", combatId: "combat1", participants: [], sessionSegments: [], events: [], shareSettings: { isShared: false, shareMode: SHARE_MODES.GM_ONLY } };

    await service.runEndOfCombatReports(log);

    assert.equal(posted, false);
    assert.equal(log.shareSettings.isShared, false);
  } finally {
    settings.delete(`sephrals-combat-log-stats.${SETTINGS.AUTO_POST_PLAYER_SUMMARY_ON_END}`);
    settings.delete(`sephrals-combat-log-stats.${SETTINGS.ENABLE_PLAYER_SHARING}`);
  }
});

test("a message goes to the log whose combat holds the speaker's token, not to an older combat of the same actor", () => {
  const service = new CombatLogService();
  const participant = (combatantId, tokenId) => ({ combatantId, actorId: "hero", actorUuid: "Actor.hero", actorLink: true, tokenId, tokenUuid: `Scene.s1.Token.${tokenId}` });
  const stale = { id: "stale", combatId: "old", participants: [participant("c-old", "oldToken")] };
  const current = { id: "current", combatId: "new", participants: [participant("c-new", "newToken")] };
  service.activeLogs.set("old", stale);
  service.activeLogs.set("new", current);

  assert.equal(service.findLogForMessage({ speaker: { scene: "s1", token: "newToken", actor: "hero" } }), current);
  assert.equal(service.findLogForMessage({ speaker: { scene: "s1", token: "oldToken", actor: "hero" } }), stale);
  // Without a token the newest log wins over the older one.
  assert.equal(service.findLogForMessage({ speaker: { actor: "hero" } }), current);
});

test("logs still waiting for their write at unload are stashed and written on the next start", async () => {
  const storage = new Map();
  globalThis.localStorage = { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k) };
  try {
    const service = new CombatLogService({ persistDelayMs: 750 });
    const stored = new Map();
    service.persistence.loadLog = async (id) => stored.get(id) ?? null;
    service.persistence.saveLog = async (log) => { stored.set(log.id, structuredClone(log)); return log; };
    const event = (id) => ({ id, type: EVENT_TYPES.RESOURCE_DELTA, data: {} });
    stored.set("log1", { id: "log1", events: [event("a")] });
    stored.set("log2", { id: "log2", events: [event("x"), event("y"), event("z")] });
    service.pendingSaves.set("log1", { id: "log1", events: [event("a"), event("b")] });
    // Another GM continued log2 after this client's copy: the stash is older and must not win.
    service.pendingSaves.set("log2", { id: "log2", events: [event("x"), event("y")] });
    service.pendingSaves.set("log3", { id: "log3", events: [event("n")] });
    assert.equal(service.stashPendingSaves(), true);

    const next = new CombatLogService();
    next.persistence = service.persistence;
    const restored = await next.restoreStashedLogs();
    assert.deepEqual(restored.sort(), ["log1", "log3"]);
    assert.equal(stored.get("log1").events.length, 2);
    assert.equal(stored.get("log2").events.length, 3);
    assert.equal(storage.size, 0);
    assert.deepEqual(await next.restoreStashedLogs(), []);
  } finally {
    delete globalThis.localStorage;
  }
});

test("nothing to stash without pending writes", () => {
  const service = new CombatLogService();
  assert.equal(service.stashPendingSaves(), false);
});

test("a stored log is read with the current damage per round basis", async () => {
  const service = new CombatLogService();
  const log = {
    id: "stored", status: "ended", rounds: 2,
    participants: [{ combatantId: "hero", name: "Hero", side: "friendly" }, { combatantId: "orc", name: "Orc", side: "hostile" }],
    events: [
      { id: "r", type: EVENT_TYPES.ROLL_DAMAGE, round: 1, combatantId: "hero", confidence: CONFIDENCE.SAFE, data: { total: 10 } },
      { id: "a", type: EVENT_TYPES.DAMAGE_APPLIED, round: 1, combatantId: "hero", confidence: CONFIDENCE.SAFE, data: { amount: 6, targetCombatantId: "orc" } }
    ],
    computed: { dpr: { method: "appliedNet" }, summary: {} }
  };
  service.persistence.loadLog = async () => structuredClone(log);
  settings.set(`sephrals-combat-log-stats.${SETTINGS.DEFAULT_DPR_METHOD}`, "rolled");
  try {
    const read = await service.getLog("stored");
    assert.equal(read.computed.dpr.method, "rolled");
    assert.equal(read.computed.byCombatant.find((row) => row.id === "hero").netDPR, 5);
    assert.equal(read.computed.byRound.length, 2);
  } finally {
    settings.set(`sephrals-combat-log-stats.${SETTINGS.DEFAULT_DPR_METHOD}`, "appliedNet");
  }
});

test("hit point changes while nobody recorded are found per changed value (dnd5e and generic)", async () => {
  const service = new CombatLogService();
  const actor = { uuid: "Actor.hero", system: { attributes: { hp: { value: 7, temp: 0, tempmax: 0, max: 20 } } } };
  const log = { id: "log", participants: [{ combatantId: "c1", actorUuid: "Actor.hero" }], events: [], latestSnapshots: { c1: { "system.attributes.hp.value": 10, "system.attributes.hp.temp": 2, "system.attributes.hp.tempmax": 0, "system.attributes.hp.max": 20 } } };
  await service.detectOfflineDeltas(log, { id: "combat", round: 1, turn: 0, combatants: [{ id: "c1", actor }] });
  const offline = log.events.map((event) => [event.type, event.data.resourcePath, event.data.delta, event.data.interpretedAs, event.confidence]);
  assert.deepEqual(offline, [
    [EVENT_TYPES.RESOURCE_DELTA_OFFLINE, "system.attributes.hp.value", -3, RESOURCE_INTERPRETATIONS.UNKNOWN, CONFIDENCE.UNCLEAR],
    [EVENT_TYPES.RESOURCE_DELTA_OFFLINE, "system.attributes.hp.temp", -2, RESOURCE_INTERPRETATIONS.UNKNOWN, CONFIDENCE.UNCLEAR]
  ]);
  assert.equal(log.latestSnapshots.c1["system.attributes.hp.value"], 7);
});

test("initiative written inside a combat update reaches the participants (Crucible rolls every round that way)", async () => {
  const service = new CombatLogService();
  service.persistence.saveLog = async (log) => log;
  const hero = { id: "hero", name: "Hero", initiative: null, token: { disposition: 1 } };
  const foe = { id: "foe", name: "Foe", initiative: null, token: { disposition: -1 } };
  const combatants = Object.assign([hero, foe], { get: (id) => [hero, foe].find((entry) => entry.id === id) });
  const combat = { id: "crucible-combat", uuid: "Combat.crucible-combat", round: 0, turn: null, started: false, combatants, scene: { uuid: "Scene.test", name: "Test Scene" } };
  game.combats.contents = [combat];

  // combatStart fires before CrucibleCombat#_preUpdate rolls initiative into the round 1 update.
  const log = await service.startCombat(combat, { force: true });
  assert.deepEqual(log.participants.map((entry) => entry.initiative), [null, null]);

  Object.assign(combat, { round: 1, turn: 0, started: true });
  hero.initiative = 19;
  foe.initiative = 16;
  await service.updateCombat(combat, { round: 1, turn: 0, combatants: [{ _id: "hero", initiative: 19 }, { _id: "foe", initiative: 16 }] });
  assert.deepEqual(log.participants.map((entry) => entry.initiative), [19, 16]);
  assert.equal(log.events.filter((event) => event.type === EVENT_TYPES.ROUND_CHANGED).length, 1);

  // A delay changes one combatant's initiative together with the turn. Without a round or turn change no event is written.
  const events = log.events.length;
  foe.initiative = 4;
  await service.updateCombat(combat, { combatants: [{ _id: "foe", initiative: 4 }, { _id: "unknown", initiative: 30 }, { _id: "hero", hidden: true }] });
  assert.deepEqual(log.participants.map((entry) => entry.initiative), [19, 4]);
  assert.equal(log.events.length, events);

  // The value comes from the change when the combatant is not in the collection, a reset clears it.
  await service.updateCombat({ ...combat, combatants: { get: () => undefined } }, { combatants: [{ _id: "hero", initiative: null }] });
  assert.equal(log.participants[0].initiative, null);
  assert.equal(await service.updateCombat(combat, { active: true }), null);
});

test("an updateCombatant initiative roll (dnd5e, core) still updates the participant", async () => {
  const service = new CombatLogService();
  service.persistence.saveLog = async (log) => log;
  const hero = { id: "hero", name: "Hero", initiative: null, token: { disposition: 1 } };
  const combat = { id: "dnd-combat", uuid: "Combat.dnd-combat", round: 1, turn: 0, started: true, combatants: [hero], scene: { uuid: "Scene.test", name: "Test Scene" } };
  hero.combat = combat;
  game.combats.contents = [combat];
  const log = await service.startCombat(combat);
  hero.initiative = 14;
  await service.combatantUpdated(hero, { initiative: 14 });
  assert.equal(log.participants[0].initiative, 14);
});
