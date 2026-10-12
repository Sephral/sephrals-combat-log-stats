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
    assert.equal(service.pendingApplications.size, 0);
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
