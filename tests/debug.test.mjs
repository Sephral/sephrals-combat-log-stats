import assert from "node:assert/strict";
import test from "node:test";

import { MODULE_ID, SETTINGS } from "../scripts/constants.js";

const hooks = new Map();
const menus = new Map();
const index = {
  logs: [{ combatLogId: "log-1", combatId: "c1", title: "Goblins", status: "ended", rounds: 3, participantCount: 4, filePath: null, inlineLog: { id: "log-1", events: new Array(50).fill({}) } }]
};

globalThis.Hooks = { on: (name, fn) => hooks.set(name, fn), once: () => {}, callAll: () => {} };
globalThis.foundry = { applications: { api: { ApplicationV2: class {} } } };
globalThis.game = {
  user: { id: "gm", isGM: true },
  users: { activeGM: { id: "gm" } },
  i18n: { lang: "en", localize: (key) => key },
  settings: {
    get: (moduleId, key) => (key === SETTINGS.INDEX ? index : undefined),
    registerMenu: (moduleId, key, data) => menus.set(`${moduleId}.${key}`, data),
    settings: new Map()
  }
};

const { describeRecent, eventsForMessage, registerDebug } = await import("../scripts/debug.js");

const service = {
  pendingSaves: new Map(),
  listActiveLogs: () => [{
    id: "log-2",
    combatId: "c2",
    status: "active",
    participants: [{}, {}],
    events: [
      { id: "e1", type: "roll.attack", round: 1, combatantId: "a", source: { kind: "chat", id: "m1" }, confidence: "safe", data: { correlation: { status: "system" } } },
      { id: "e2", type: "resource.delta", round: 1, combatantId: "b", source: { kind: "hook", id: "" }, data: {} }
    ]
  }]
};

test("the debug menu and the provider are registered", () => {
  registerDebug(() => service);
  const menu = menus.get(`${MODULE_ID}.debugFile`);
  assert.equal(menu.restricted, true);
  assert.equal(menu.label, "SCLS.Debug.Save");
  const provider = globalThis.sephralsDebugFiles.providers.get(MODULE_ID);
  assert.equal(provider.label(), "SCLS.Debug.Entry");
  assert.deepEqual(provider.omitSettings, [SETTINGS.INDEX]);
  assert.equal(provider.applies({ id: "m1" }), true);
  assert.equal(provider.applies({ id: "other" }), false);
  assert.equal(typeof hooks.get("getChatMessageContextOptions"), "function");
});

test("the summary lists the logs without their events", () => {
  const { details } = describeRecent(service);
  assert.deepEqual(details.activeLogs, [{ id: "log-2", combatId: "c2", status: "active", events: 2, participants: 2, startedAt: null }]);
  assert.deepEqual(details.storedLogs, [{ combatLogId: "log-1", combatId: "c1", title: "Goblins", status: "ended", rounds: 3, participantCount: 4, inline: true, file: false }]);
  assert.equal(JSON.stringify(details).includes("events\":[{"), false);
  assert.match(details.combatDebugLog, /combat log window/);
});

test("a chat message leads to the log events that came from it", () => {
  assert.deepEqual(eventsForMessage(service, "m1"), [{ logId: "log-2", eventId: "e1", type: "roll.attack", round: 1, combatantId: "a", confidence: "safe", correlation: "system", attribution: null }]);
  assert.deepEqual(eventsForMessage(service, ""), []);
  assert.deepEqual(eventsForMessage(null, "m1"), []);
});
