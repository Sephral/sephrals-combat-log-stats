import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { MODULE_ID, OFF_COMBAT_SCOPES, SETTINGS } from "../scripts/constants.js";

const english = JSON.parse(readFileSync(new URL("../lang/en.json", import.meta.url), "utf8"));
const german = JSON.parse(readFileSync(new URL("../lang/de.json", import.meta.url), "utf8"));
const settings = new Map();
let lang = "en";

globalThis.game = {
  user: { id: "gm", isGM: true },
  users: { activeGM: { id: "gm" } },
  system: { id: "dnd5e" },
  version: "14.370",
  i18n: { lang: "en", localize: (key) => (lang === "de" ? german : english)[key] ?? key },
  settings: {
    get: (moduleId, key) => settings.get(`${moduleId}.${key}`),
    set: async (moduleId, key, value) => { settings.set(`${moduleId}.${key}`, value); },
    register: () => {}
  }
};
globalThis.Hooks = { on: () => {}, off: () => {}, callAll: () => {} };
globalThis.foundry = { applications: { api: { ApplicationV2: class { async close() {} } } } };

const log = await import("../scripts/services/offcombat-log.js");
const { OffCombatService, conditionOf, inScope } = await import("../scripts/services/offcombat-service.js");
const { OffCombatStore } = await import("../scripts/services/offcombat-store.js");
const { sessionPanel } = await import("../scripts/apps/session-panel.js");

const HOUR = 3600 * 1000;
const T0 = new Date("2026-11-14T19:00:00.000Z").getTime();
const hp = (t, i, d, extra = {}) => ({ t, k: "hp", i, n: i, q: "hp", d, v: 20 + d, m: 30, ...extra });

test("changes of one actor in a row are one entry, other actors and directions are not", () => {
  const state = log.emptyState();
  log.appendEvent(state, hp(T0, "aria", -3));
  log.appendEvent(state, hp(T0 + 5000, "aria", -4));
  log.appendEvent(state, hp(T0 + 9000, "aria", 6));
  log.appendEvent(state, hp(T0 + 9500, "bram", -2));
  log.appendEvent(state, hp(T0 + 9 * 60 * 1000, "aria", 6));
  const events = state.nights[0].events;
  assert.equal(events.length, 4);
  assert.equal(events[0].d, -7);
  assert.equal(events[0].c, 2);
  assert.equal(events[0].v, 16, "the value after the last change");
  assert.equal(state.nights.length, 1);
});

test("a pause of more than six hours starts a new night, the night keeps at most 200 entries and 20 nights stay", () => {
  const state = log.emptyState();
  log.appendEvent(state, { t: T0, k: "death", i: "a", n: "A" });
  log.appendEvent(state, { t: T0 + 7 * HOUR, k: "death", i: "a", n: "A" });
  assert.equal(state.nights.length, 2);

  const busy = log.emptyState();
  for (let index = 0; index < 260; index++) log.appendEvent(busy, { t: T0 + index * 60 * 1000, k: "cond", i: "a", n: "A", c: `c${index}`, s: 1 });
  assert.equal(busy.nights[0].events.length, log.MAX_EVENTS);
  assert.equal(busy.nights[0].dropped, 60);
  assert.equal(busy.nights[0].events[0].c, "c60", "the oldest entries go");

  const long = log.emptyState();
  for (let index = 0; index < 30; index++) log.appendEvent(long, { t: T0 + index * 24 * HOUR, k: "death", i: "a", n: "A" });
  assert.equal(long.nights.length, log.MAX_NIGHTS);
  assert.equal(long.nights[0].from, T0 + 10 * 24 * HOUR);
});

test("the retention setting drops nights older than that many days", () => {
  const state = log.emptyState();
  log.appendEvent(state, { t: T0, k: "death", i: "a", n: "A" });
  log.appendEvent(state, { t: T0 + 40 * 24 * HOUR, k: "death", i: "a", n: "A" }, { retentionDays: 30 });
  assert.equal(state.nights.length, 1);
  assert.equal(state.nights[0].from, T0 + 40 * 24 * HOUR);
});

test("a stored state is cleaned: bad entries go, nights are sorted, ids and bounds are rebuilt", () => {
  const state = log.normalizeState({ nights: [{ events: [{ t: T0 + 10, k: "death" }, { t: "x", k: "hp" }, null] }, { events: [{ t: T0, k: "death" }] }, { events: [] }, "x"] });
  assert.equal(state.nights.length, 2);
  assert.ok(state.nights[0].from < state.nights[1].from);
  assert.equal(state.nights[1].to, T0 + 10);
  assert.deepEqual(log.normalizeState(null), { v: 1, nights: [] });
});

test("poolChanges reads only the value paths and says which pool changed", () => {
  const paths = ["system.attributes.hp.value", "system.attributes.hp.temp", "system.attributes.hp.max"];
  const changes = log.poolChanges({ [paths[0]]: 20, [paths[1]]: 0 }, { [paths[0]]: 12, [paths[1]]: 5 }, paths);
  assert.deepEqual(changes.map((change) => [change.pool, change.delta]), [["hp", -8]]);
  assert.equal(log.poolOf("system.resources.health.value"), "health");
});

test("events fall into the nearest session or stay loose as nights without a fight", () => {
  const sessions = [{ id: "s1", startedAt: new Date(T0).toISOString(), endedAt: new Date(T0 + 2 * HOUR).toISOString() }];
  const inside = { t: T0 + HOUR, k: "death", i: "a" };
  const before = { t: T0 - 2 * HOUR, k: "death", i: "a" };
  const after = { t: T0 + 4 * HOUR, k: "death", i: "a" };
  const farther = { t: T0 + 3 * 24 * HOUR, k: "death", i: "a" };
  const farther2 = { t: T0 + 3 * 24 * HOUR + HOUR, k: "death", i: "a" };
  const { bySession, loose } = log.assignToSessions(sessions, [before, inside, after, farther, farther2]);
  assert.equal(bySession.get("s1").length, 3);
  const nights = log.looseNights(loose);
  assert.equal(nights.length, 1);
  assert.equal(nights[0].events.length, 2);
  assert.ok(nights[0].id.startsWith(log.NIGHT_PREFIX));
});

test("totals count hit points, downs, conditions, deaths and rests per actor", () => {
  const events = [
    hp(T0, "aria", -9), hp(T0 + 1, "bram", 4),
    { t: T0 + 2, k: "down", i: "aria", n: "aria", q: "hp" },
    { t: T0 + 3, k: "cond", i: "aria", n: "aria", c: "Poisoned", s: 1 },
    { t: T0 + 4, k: "cond", i: "aria", n: "aria", c: "Poisoned", s: -1 },
    { t: T0 + 5, k: "death", i: "bram", n: "bram" },
    { t: T0 + 6, k: "rest", i: "aria", n: "aria", r: "long", d: 12 },
    { t: T0 + 7, k: "hp", i: "bram", n: "bram", q: "wounds", d: 2, v: 2 }
  ];
  const { totals, actors } = log.nightTotals(events);
  assert.deepEqual(totals, { events: 8, lost: 9, regained: 4, downs: 1, conditions: 1, deaths: 1, rests: 1 });
  assert.equal(actors[0].name, "aria", "most damage first");
  assert.equal(actors.find((actor) => actor.id === "bram").deaths, 1);
});

test("an entry reads as a short sentence, in English and German", () => {
  assert.equal(log.describeEvent(hp(T0, "Aria", -8, { n: "Aria", v: 12 })), "Aria lost 8 HP (12/30)");
  assert.equal(log.describeEvent(hp(T0, "Aria", 5, { n: "Aria", v: 17 })), "Aria regained 5 HP (17/30)");
  assert.equal(log.describeEvent({ t: T0, k: "hp", n: "Bram", q: "wounds", d: 2, v: 3 }), "Bram: wounds +2 (now 3)");
  assert.equal(log.describeEvent({ t: T0, k: "cond", n: "Bram", c: "Poisoned", s: 1 }), "Bram is now Poisoned");
  assert.equal(log.describeEvent({ t: T0, k: "rest", n: "Bram", r: "long", d: 10 }), "Bram took a long rest (10 HP regained)");
  assert.equal(log.describeEvent({ t: T0, k: "death", n: "Bram" }), "Bram died");
  lang = "de";
  try {
    assert.equal(log.describeEvent(hp(T0, "Aria", -8, { n: "Aria", v: 12 })), "Aria verlor 8 TP (12/30)");
    assert.equal(log.describeEvent({ t: T0, k: "rest", n: "Bram", r: "short", d: 0 }), "Bram hat eine kurze Rast gemacht");
  } finally {
    lang = "en";
  }
});

test("only conditions are logged: no effect without status, no automatic ones, a dead status is a death", () => {
  assert.equal(conditionOf({ name: "Bless", statuses: new Set() }), null);
  assert.equal(conditionOf({ name: "Bloodied", statuses: new Set(["bloodied"]) }), null);
  assert.deepEqual(conditionOf({ name: "Poisoned", statuses: new Set(["poisoned"]) }), { death: false, name: "Poisoned" });
  assert.equal(conditionOf({ name: "Dead", statuses: new Set(["dead"]) }).death, true);
  assert.equal(inScope({ hasPlayerOwner: true }, OFF_COMBAT_SCOPES.PARTY), true);
  assert.equal(inScope({ hasPlayerOwner: false }, OFF_COMBAT_SCOPES.PARTY), false);
  assert.equal(inScope({ hasPlayerOwner: false }, OFF_COMBAT_SCOPES.ALL), true);
});

// A recording GM with a fake store file system: the files helper only needs these members.
function files() {
  return { storageBasePath: () => "worlds/test/data/mod", storageSource: () => "data", ensureDirectories: async () => {}, tryLoadFromFile: async () => null };
}

function service({ inFight = () => false } = {}) {
  settings.clear();
  const combatLogs = { persistence: files(), findLogsForActor: (actor) => (inFight(actor) ? [{}] : []) };
  const offCombat = new OffCombatService(combatLogs);
  offCombat.store.delayMs = 1e9;
  return offCombat;
}

const hero = (hpValue, extra = {}) => ({ id: "hero", uuid: "Actor.hero", name: "Hero", hasPlayerOwner: true, system: { attributes: { hp: { value: hpValue, max: 30, temp: 0 } } }, ...extra });

test("a hit point change of a player character is logged with the value before taken from the snapshot", async () => {
  const off = service();
  off.snapshot(hero(30));
  const events = await off.actorUpdated(hero(22), {}, {}, T0);
  assert.equal(events.length, 1);
  assert.deepEqual({ k: events[0].k, d: events[0].d, v: events[0].v, m: events[0].m, p: events[0].p }, { k: "hp", d: -8, v: 22, m: 30, p: 1 });
  const dropped = await off.actorUpdated(hero(0), {}, {}, T0 + 60000);
  assert.deepEqual(dropped.map((event) => event.k), ["hp", "down"]);
  assert.equal((await off.nights())[0].events.length, 3);
});

test("nothing is logged while off, for NPCs in the party scope, for actors in a fight or without a snapshot", async () => {
  let off = service();
  assert.equal(await off.actorUpdated(hero(25), {}, {}, T0), null, "no snapshot yet: the first value is only remembered");
  assert.ok(await off.actorUpdated(hero(20), {}, {}, T0 + 1), "now there is one");

  settings.set(`${MODULE_ID}.${SETTINGS.OFF_COMBAT_LOG}`, false);
  off.snapshot(hero(30));
  assert.equal(await off.actorUpdated(hero(10), {}, {}, T0 + 2), null);

  off = service();
  const npc = (value) => hero(value, { id: "npc", uuid: "Actor.npc", hasPlayerOwner: false });
  off.snapshot(npc(10));
  assert.equal(await off.actorUpdated(npc(4), {}, {}, T0), null);
  settings.set(`${MODULE_ID}.${SETTINGS.OFF_COMBAT_SCOPE}`, OFF_COMBAT_SCOPES.ALL);
  off.snapshot(npc(10));
  assert.equal((await off.actorUpdated(npc(4), {}, {}, T0))?.length, 1);

  let fighting = true;
  off = service({ inFight: () => fighting });
  off.snapshot(hero(30));
  assert.equal(await off.actorUpdated(hero(20), {}, {}, T0), null, "the fight's own log has it");
  fighting = false;
  assert.equal((await off.actorUpdated(hero(15), {}, {}, T0 + 1))?.length, 1, "after the fight it counts again, from the last value seen");
  assert.equal((await off.nights())[0].events[0].d, -5);
});

test("a rest is one entry however many updates it made, and the rest hook names it", async () => {
  const off = service();
  off.snapshot(hero(10));
  await off.actorUpdated(hero(30), {}, { isRest: true }, T0);
  await off.actorUpdated(hero(30), {}, { isRest: true }, T0 + 500);
  let events = (await off.nights())[0].events;
  assert.equal(events.length, 1);
  assert.deepEqual({ k: events[0].k, r: events[0].r, d: events[0].d }, { k: "rest", r: "rest", d: 20 });
  await off.restCompleted(hero(30), { longRest: true, type: "long" }, T0 + 800);
  events = (await off.nights())[0].events;
  assert.equal(events[0].r, "long");
  assert.equal(events.length, 1);
});

test("a short rest that changed nothing with the rest flag still gets its entry from the rest hook", async () => {
  const off = service();
  off.snapshot(hero(10));
  const event = await off.restCompleted(hero(10), { type: "short" }, T0);
  assert.deepEqual({ k: event.k, r: event.r, d: event.d }, { k: "rest", r: "short", d: 0 });
  assert.equal((await off.nights())[0].events.length, 1);
});

test("conditions and deaths of a player character are logged, effects of others are not", async () => {
  const off = service();
  const actor = hero(30);
  const effect = (name, status, parent = actor) => ({ name, statuses: new Set([status]), parent: { documentName: "Actor", ...parent } });
  assert.equal((await off.effectChanged(effect("Poisoned", "poisoned"), true, T0)).c, "Poisoned");
  assert.equal((await off.effectChanged(effect("Poisoned", "poisoned"), false, T0 + 1)).s, -1);
  assert.equal((await off.effectChanged(effect("Dead", "dead"), true, T0 + 2)).k, "death");
  assert.equal(await off.effectChanged(effect("Dead", "dead"), false, T0 + 3), null, "a revival is told by the hit points");
  assert.equal(await off.effectChanged(effect("Bloodied", "bloodied"), true, T0 + 4), null);
  assert.equal(await off.effectChanged({ name: "Item effect", statuses: new Set(["poisoned"]), parent: { documentName: "Item" } }, true, T0 + 5), null);
});

test("only the recording GM writes entries", async () => {
  const off = service();
  off.snapshot(hero(30));
  globalThis.game.users.activeGM = { id: "other" };
  try {
    await off.actorUpdated(hero(10), {}, {}, T0);
    assert.equal((await off.nights()).length, 0);
  } finally {
    globalThis.game.users.activeGM = { id: "gm" };
  }
});

test("without file support (Foundry 13) the nights live in the setting itself, with a file the setting only points to it", async () => {
  settings.clear();
  globalThis.game.version = "13.351";
  globalThis.game.release = { generation: 13 };
  const inline = new OffCombatStore(files(), { delayMs: 1e9 });
  await inline.add(hp(T0, "aria", -3));
  await inline.flush();
  const saved = settings.get(`${MODULE_ID}.${SETTINGS.OFF_COMBAT_DATA}`);
  assert.equal(saved.file, null);
  assert.equal(saved.state.nights[0].events.length, 1);
  const reloaded = new OffCombatStore(files(), { delayMs: 1e9 });
  assert.equal((await reloaded.load()).nights[0].events[0].d, -3);

  settings.clear();
  globalThis.game.version = "14.370";
  globalThis.game.release = { generation: 14 };
  const uploads = [];
  const FakeFile = class { constructor(parts, name) { this.parts = parts; this.name = name; } };
  globalThis.File = FakeFile;
  globalThis.FilePicker = { upload: async (source, path, file) => { uploads.push({ source, path, text: file.parts[0] }); return { path: `${path}/${file.name}` }; } };
  try {
    const stored = new Map();
    const store = new OffCombatStore({ ...files(), tryLoadFromFile: async (path) => (stored.has(path) ? JSON.parse(stored.get(path)) : null) }, { delayMs: 1e9 });
    await store.add(hp(T0, "aria", -3));
    await store.flush();
    const pointer = settings.get(`${MODULE_ID}.${SETTINGS.OFF_COMBAT_DATA}`);
    assert.equal(uploads.length, 1);
    assert.equal(pointer.file.path, "worlds/test/data/mod/off-combat.json");
    assert.equal(pointer.state, undefined, "the nights are in the file, not in the world setting");
    stored.set(pointer.file.path, uploads[0].text);
    const other = new OffCombatStore({ ...files(), tryLoadFromFile: async (path) => (stored.has(path) ? JSON.parse(stored.get(path)) : null) }, { delayMs: 1e9 });
    assert.equal((await other.load()).nights[0].events[0].d, -3);
  } finally {
    delete globalThis.FilePicker;
    delete globalThis.File;
  }
});

test("the Sessions tab shows what happened between the fights of a session and lists nights without a fight", () => {
  const fightLog = (id, startMs) => ({
    id, title: id, status: "ended", systemId: "dnd5e", startedAt: new Date(startMs).toISOString(), endedAt: new Date(startMs + 600000).toISOString(),
    participants: [], events: [], computed: { summary: { rounds: 2 }, bySide: [], byCombatant: [], dpr: {} }
  });
  const logs = [fightLog("a", T0)];
  const events = [hp(T0 + HOUR, "aria", -5, { n: "Aria" }), { t: T0 + 2 * HOUR, k: "rest", i: "aria", n: "Aria", r: "long", d: 5 }, hp(T0 + 5 * 24 * HOUR, "bram", -3, { n: "Bram" })];

  const panel = sessionPanel(logs, { offEvents: events });
  assert.equal(panel.between.count, 2);
  assert.equal(panel.between.cards[0].value, "5");
  assert.equal(panel.between.lines.length, 2);
  assert.match(panel.between.lines[0].text, /^Aria lost 5 HP/);
  const nightOption = panel.options.find((option) => option.value.startsWith("night-"));
  assert.ok(nightOption, "the night without a fight is selectable");

  const night = sessionPanel(logs, { offEvents: events, selectedId: nightOption.value });
  assert.equal(night.offOnly, true);
  assert.equal(night.between.count, 1);
  assert.equal(night.options.filter((option) => option.selected).length, 1);

  const all = sessionPanel(logs, { offEvents: events, selectedId: "all" });
  assert.equal(all.sessionRows[0].outside, "2");
  assert.equal(all.nightRows.length, 1);

  const onlyNights = sessionPanel([], { offEvents: events });
  assert.equal(onlyNights.hasFights, true);
  assert.equal(onlyNights.offOnly, true);
  assert.equal(sessionPanel([], { offEvents: [] }).hasFights, false);
  assert.equal(sessionPanel(logs).between, null, "players and a window without the log get no block");
});

test("an entry with an older time joins the night it belongs to, not the latest one", () => {
  const state = log.emptyState();
  log.appendEvent(state, { t: T0, k: "death", i: "a", n: "A" });
  log.appendEvent(state, { t: T0 + 30 * 24 * HOUR, k: "death", i: "a", n: "A" });
  log.appendEvent(state, { t: T0 + 60000, k: "cond", i: "a", n: "A", c: "Prone", s: 1 });
  assert.equal(state.nights.length, 2);
  assert.equal(state.nights[0].events.length, 2);
});
