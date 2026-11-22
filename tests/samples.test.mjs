import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.game = { i18n: { lang: "en", localize: (key) => key }, settings: { get: () => undefined }, modules: new Map(), user: { id: "gm", isGM: true }, world: { id: "w" }, version: "13" };
globalThis.foundry = { applications: { api: { ApplicationV2: class { async close() {} } } } };
globalThis.Hooks = { on() {}, off() {} };

const { SAMPLE_PREFIX, sampleFights, sampleOffCombat, sampleService } = await import("../scripts/sample-windows.js");
const { CombatStatsService } = await import("../scripts/services/stats-service.js");
const { normalizeState } = await import("../scripts/services/offcombat-log.js");
const { EVENT_TYPES, LOG_STATUS } = await import("../scripts/constants.js");

const NOW = Date.parse("2026-11-22T20:00:00Z");

test("three ended sample fights, tonight two and one last week, all ids marked as samples", () => {
  const fights = sampleFights(NOW);
  assert.equal(fights.length, 3);
  for (const log of fights) {
    assert.ok(log.id.startsWith(SAMPLE_PREFIX));
    assert.equal(log.status, LOG_STATUS.ENDED);
    assert.ok(log.events.every((event) => event.id.startsWith(log.id)));
  }
  const days = fights.map((log) => new Date(log.startedAt).toISOString().slice(0, 10));
  assert.equal(days[0], days[1]);
  assert.notEqual(days[0], days[2]);
});

test("the fight at the mill fills every part of the window: crits, a fumble, a fall, a rescue, corrections", () => {
  const mill = sampleFights(NOW)[0];
  const stats = CombatStatsService.compute(mill, {});
  assert.equal(stats.summary.rounds, 4);
  assert.equal(stats.summary.criticalHits, 3);
  assert.equal(stats.summary.criticalFumbles, 1);
  assert.equal(stats.summary.partyDowned, 1);
  assert.ok(stats.summary.enemiesDefeated >= 4);
  assert.ok(stats.summary.netHealingApplied > 0);
  assert.ok(stats.summary.unclassifiedDeltas >= 1);
  assert.ok(mill.events.some((event) => event.ignored));
  assert.ok(mill.events.some((event) => event.type === EVENT_TYPES.DAMAGE_MANUAL_ADDED));
  assert.ok(mill.events.some((event) => event.type === EVENT_TYPES.ACTIVE_EFFECT_CREATED && event.data.control));
  assert.equal(mill.shareSettings.isShared, true);
});

test("hit point changes follow from the script and name the roll they came from", () => {
  const mill = sampleFights(NOW)[0];
  const changes = mill.events.filter((event) => event.type === EVENT_TYPES.RESOURCE_DELTA && event.data.attribution === "systemApplied");
  for (const change of changes) {
    assert.equal(change.data.newValue - change.data.oldValue, change.data.delta);
    assert.ok(change.data.newValue >= 0);
  }
  const rolled = changes.filter((change) => change.data.correlation);
  assert.ok(rolled.length > 10);
  for (const change of rolled) assert.ok(mill.events.some((event) => event.id === change.data.correlation.rollEventId && event.source.id === change.data.correlation.messageId));
});

test("the night outside the fights reads like a stored one", () => {
  const state = normalizeState(sampleOffCombat(NOW));
  assert.equal(state.nights.length, 1);
  assert.deepEqual([...new Set(state.nights[0].events.map((event) => event.k))].sort(), ["cond", "down", "hp", "rest"]);
});

test("the sample store reads the fights and refuses every write", async () => {
  const notices = [];
  globalThis.ui = { notifications: { info: (text) => notices.push(text) } };
  const service = sampleService(null, NOW);
  const entries = await service.persistence.loadHistoryEntries();
  assert.equal(entries.length, 3);
  const log = await service.getLog(`${SAMPLE_PREFIX}-mill`);
  assert.ok(log.computed.summary.rounds > 0);
  assert.equal(await service.persistence.saveLog(log), null);
  assert.equal(await service.persistence.deleteLog(log.id), false);
  assert.equal(await service.deleteLog(log.id), false);
  assert.equal(notices.length, 3);
  assert.equal((await service.persistence.loadHistoryEntries()).length, 3);
});
