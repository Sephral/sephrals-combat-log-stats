import assert from "node:assert/strict";
import { test } from "node:test";
import { CONFIDENCE, EVENT_TYPES, SETTINGS, SHARE_MODES } from "../scripts/constants.js";

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

test("active effect changes are tracked as participant ledger events", async () => {
  const service = new CombatLogService();
  service.persistence.saveLog = async (log) => log;
  const actor = { id: "actor1", uuid: "Actor.actor1", documentName: "Actor" };
  const combat = { id: "combat1", uuid: "Combat.combat1", round: 2, turn: 1, combatants: [], scene: { uuid: "Scene.test" } };
  const log = {
    id: "log1",
    combatId: combat.id,
    combatUuid: combat.uuid,
    sceneUuid: "Scene.test",
    participants: [{ combatantId: "combatant1", actorId: actor.id, actorUuid: actor.uuid, tokenUuid: "Scene.test.Token.token1", name: "Hero", side: "friendly" }],
    sessionSegments: [],
    events: []
  };
  game.combats.contents = [combat];
  service.activeLogs.set(combat.id, log);

  await service.activeEffectChanged(EVENT_TYPES.ACTIVE_EFFECT_CREATED, { id: "effect1", uuid: "Actor.actor1.Item.item1.ActiveEffect.effect1", parent: { documentName: "Item", actor }, name: "Bless", disabled: false }, {});

  assert.equal(log.events.length, 1);
  assert.equal(log.events[0].type, EVENT_TYPES.ACTIVE_EFFECT_CREATED);
  assert.equal(log.events[0].combatantId, "combatant1");
  assert.equal(log.events[0].actorUuid, actor.uuid);
  assert.equal(log.events[0].confidence, CONFIDENCE.PROBABLE);
  assert.equal(log.events[0].data.name, "Bless");
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