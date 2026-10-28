import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CONFIDENCE, EVENT_TYPES, HOOKS, MODULE_ID, RESOURCE_INTERPRETATIONS, SETTINGS, SHARE_MODES, SIDES, SOURCE_KINDS, VISIBILITY } from "../scripts/constants.js";

const english = JSON.parse(readFileSync(new URL("../lang/en.json", import.meta.url), "utf8"));
const settings = new Map();
const warnings = [];
const hookCalls = [];

globalThis.game = {
  user: { id: "player", isGM: false },
  i18n: { lang: "en", localize: (key) => english[key] ?? key },
  settings: {
    get: (moduleId, key) => settings.get(`${moduleId}.${key}`),
    register: () => {}
  }
};
globalThis.ui = { notifications: { warn: (message) => warnings.push(message), info: () => {} } };
globalThis.Hooks = { on: () => {}, off: () => {}, callAll: (...args) => hookCalls.push(args) };
globalThis.foundry = { applications: { api: { ApplicationV2: class { async close() {} } } } };

const { canViewCombatLogs, canWriteCombatLogs, playerHistoryEntry, playerShareSettings, playerTabs, playerViewLog } = await import("../scripts/services/player-view-service.js");
const { participantDirectory } = await import("../scripts/services/player-report-service.js");
const { registerSettings, settingDefinition } = await import("../scripts/settings.js");
const { CombatLogApp } = await import("../scripts/apps/combat-log-app.js");

function asPlayer(fn) {
  const previous = game.user.isGM;
  game.user.isGM = false;
  try {
    return fn();
  } finally {
    game.user.isGM = previous;
  }
}

function asGM(fn) {
  const previous = game.user.isGM;
  game.user.isGM = true;
  try {
    return fn();
  } finally {
    game.user.isGM = previous;
  }
}

function delta(id, sourceId, targetId, amount, extra = {}) {
  return {
    id,
    type: EVENT_TYPES.RESOURCE_DELTA,
    round: 1,
    combatantId: sourceId || targetId,
    visibility: VISIBILITY.GM,
    source: { kind: SOURCE_KINDS.ACTOR_UPDATE, id: `actor-${id}` },
    confidence: CONFIDENCE.SAFE,
    ignored: false,
    data: {
      delta: -amount,
      interpretedAs: RESOURCE_INTERPRETATIONS.DAMAGE,
      ...(sourceId ? { attribution: "systemApplied", sourceCombatantId: sourceId } : {}),
      targetCombatantId: targetId,
      ...extra
    }
  };
}

// A party member, a named enemy, a hidden enemy, and everything the GM keeps back.
function sampleLog(shareSettings = {}) {
  return {
    id: "log-1",
    title: "Ambush",
    status: "ended",
    systemId: "dnd5e",
    startedAt: "2026-10-15T10:00:00.000Z",
    endedAt: "2026-10-15T10:10:00.000Z",
    sessionSegments: [{ startedAt: "2026-10-15T10:00:00.000Z", endedAt: "2026-10-15T10:10:00.000Z" }],
    participants: [
      { combatantId: "hero", name: "Hero", img: "hero.webp", side: SIDES.FRIENDLY, isPlayerOwned: true },
      { combatantId: "boss", name: "Goblin Boss", img: "boss.webp", side: SIDES.HOSTILE },
      { combatantId: "assassin", name: "Hidden Assassin", img: "assassin.webp", side: SIDES.HOSTILE, hidden: true }
    ],
    initialSnapshots: { hero: { "system.attributes.hp.value": 20 }, boss: { "system.attributes.hp.value": 40 } },
    latestSnapshots: { boss: { "system.attributes.hp.value": 26 } },
    events: [
      delta("hit-boss", "hero", "boss", 7, { actionName: "Longsword" }),
      delta("boss-hits", "boss", "hero", 6, { actionName: "Scimitar" }),
      delta("assassin-hits", "assassin", "hero", 5, { actionName: "Poisoned Dagger" }),
      delta("hit-assassin", "hero", "assassin", 4),
      // A whispered damage roll of the boss and the hit point change it explains.
      { id: "secret-roll", type: EVENT_TYPES.ROLL_DAMAGE, round: 1, combatantId: "boss", visibility: VISIBILITY.GM, source: { kind: SOURCE_KINDS.ROLL, id: "msg-secret" }, confidence: CONFIDENCE.SAFE, data: { total: 3, actionName: "Secret Technique" } },
      delta("secret-hit", "boss", "hero", 3, { actionName: "Secret Technique", correlation: { status: "correlated", rollEventId: "secret-roll" } }),
      { id: "gm-note", type: EVENT_TYPES.GM_NOTE, round: 1, visibility: VISIBILITY.GM, source: { kind: SOURCE_KINDS.MANUAL }, confidence: CONFIDENCE.MANUAL, data: { note: "The boss is the mayor in disguise" } },
      { ...delta("unclear", "", "boss", 9), confidence: CONFIDENCE.UNCLEAR },
      { ...delta("ignored", "hero", "boss", 50), ignored: true },
      { id: "manual", type: EVENT_TYPES.DAMAGE_MANUAL_ADDED, round: 1, combatantId: "hero", visibility: VISIBILITY.GM, source: { kind: SOURCE_KINDS.MANUAL, id: "manualAdjustment" }, confidence: CONFIDENCE.MANUAL, data: { amount: 2, targetCombatantId: "boss", sourceCombatantId: "hero", note: "Forgot the sneak attack" } },
      // A chat application that named its target by text only.
      { id: "named", type: EVENT_TYPES.ROLL_ATTACK, round: 1, combatantId: "hero", visibility: VISIBILITY.PUBLIC, source: { kind: SOURCE_KINDS.ROLL, id: "msg-public" }, confidence: CONFIDENCE.SAFE, data: { isCritical: true, targetNames: ["Goblin Boss"], targetName: "Goblin Boss" } }
    ],
    shareSettings: { isShared: false, shareMode: SHARE_MODES.GM_ONLY, anonymizeEnemies: true, includeEnemyStats: false, includeHiddenCombatants: false, ...shareSettings }
  };
}

test("the player access setting is a world setting that is on by default and next to the sharing settings", () => {
  const definition = settingDefinition(SETTINGS.PLAYER_STATS_ACCESS);
  assert.equal(definition.scope, "world");
  assert.equal(definition.config, true);
  assert.equal(definition.type, Boolean);
  assert.equal(definition.default, true);

  const order = [];
  game.settings.register = (moduleId, key, registered) => order.push([key, registered]);
  registerSettings();
  const keys = order.map(([key]) => key);
  assert.equal(keys.indexOf(SETTINGS.PLAYER_STATS_ACCESS), keys.indexOf(SETTINGS.ENABLE_PLAYER_SHARING) + 1);
  const [, registered] = order.find(([key]) => key === SETTINGS.PLAYER_STATS_ACCESS);
  assert.equal(registered.name, "SCLS.Setting.playerStatsAccess.Name");
  assert.ok(english[registered.name] && english[registered.hint]);

  hookCalls.length = 0;
  registered.onChange(false);
  assert.deepEqual(hookCalls, [[HOOKS.PLAYER_ACCESS_CHANGED, false]]);
});

test("players can view while the setting is on or unset, GMs always, and only GMs write", () => {
  settings.delete(`${MODULE_ID}.${SETTINGS.PLAYER_STATS_ACCESS}`);
  assert.equal(asPlayer(canViewCombatLogs), true);
  assert.equal(asPlayer(canWriteCombatLogs), false);

  settings.set(`${MODULE_ID}.${SETTINGS.PLAYER_STATS_ACCESS}`, false);
  assert.equal(asPlayer(canViewCombatLogs), false);
  assert.equal(asGM(canViewCombatLogs), true);
  assert.equal(asGM(canWriteCombatLogs), true);
  settings.delete(`${MODULE_ID}.${SETTINGS.PLAYER_STATS_ACCESS}`);
});

test("the player view leaves out hidden combatants, whispered rolls, GM notes, unclear and ignored entries", () => {
  const log = sampleLog();
  const before = structuredClone(log);
  const view = playerViewLog(log);

  assert.deepEqual(log, before, "the stored log stays untouched");
  assert.deepEqual(view.participants.map((participant) => participant.combatantId), ["hero", "boss"]);
  const ids = view.events.map((event) => event.id);
  assert.deepEqual(ids, ["hit-boss", "boss-hits", "secret-hit", "manual", "named"]);
  // The change a whispered roll explains still counts, without the name of the action.
  assert.equal(view.events.find((event) => event.id === "secret-hit").data.actionName, undefined);
  assert.equal(view.events.find((event) => event.id === "hit-boss").data.actionName, "Longsword");
  // GM notes on manual changes and names read from chat cards never reach the page.
  assert.equal(view.events.find((event) => event.id === "manual").data.note, undefined);
  assert.equal(view.events.find((event) => event.id === "named").data.targetName, undefined);
  assert.equal(view.events.find((event) => event.id === "named").data.targetNames, undefined);
  assert.deepEqual(view.initialSnapshots, undefined);
  assert.deepEqual(view.latestSnapshots, undefined);
  const page = JSON.stringify(view);
  for (const secret of ["Hidden Assassin", "assassin", "Secret Technique", "mayor", "sneak attack", "Goblin Boss", "boss.webp"]) assert.equal(page.includes(secret), false, secret);
  assert.deepEqual(view.computed.warningCounts, {});
});

test("enemy names are anonymized like in the player report, portraits included", () => {
  const log = sampleLog();
  const view = playerViewLog(log);
  const share = playerShareSettings(log);
  const reportNames = participantDirectory(log, share).participants;

  const boss = view.participants.find((participant) => participant.combatantId === "boss");
  assert.equal(boss.name, "Enemy 1");
  assert.equal(boss.name, reportNames.get("boss").name);
  assert.equal(boss.img, "icons/svg/mystery-man.svg");
  assert.equal(view.participants.find((participant) => participant.combatantId === "hero").img, "hero.webp");

  const named = playerViewLog(sampleLog({ anonymizeEnemies: false }));
  const shown = named.participants.find((participant) => participant.combatantId === "boss");
  assert.equal(shown.name, "Goblin Boss");
  assert.equal(shown.img, "boss.webp");
});

test("without enemy stats the numbers are the party's and enemy rows are gone", () => {
  const view = playerViewLog(sampleLog());
  const computed = view.computed;

  assert.deepEqual(computed.byCombatant.map((row) => row.id), ["hero"]);
  assert.equal(computed.dpr.byCombatant.some((row) => row.side === SIDES.HOSTILE), false);
  assert.equal(computed.bySide.some((row) => row.id === SIDES.HOSTILE), false);
  assert.equal(computed.dpr.enemyDPR, null);
  assert.ok(computed.byRound.every((row) => row.enemyDamage === 0 && row.enemyHealing === 0));
  // Hero: 7 on the boss plus 2 added by the GM. The hit on the hidden assassin does not count for players.
  assert.equal(computed.byCombatant[0].damageAppliedNet, 9);
  assert.equal(computed.summary.netDamageApplied, 9);
  assert.equal(computed.byCombatant[0].damageTakenNet, 9);
  assert.equal(computed.summary.criticalHits, 1);
});

test("enemy stats need the GM's choice and a report detail that shows them", () => {
  const shared = playerViewLog(sampleLog({ includeEnemyStats: true, shareMode: SHARE_MODES.FULL_VISIBLE_RECAP }));
  assert.ok(shared.computed.byCombatant.some((row) => row.id === "boss"));
  assert.equal(shared.computed.dpr.enemyDPR, shared.computed.bySide.find((row) => row.id === SIDES.HOSTILE).netDPR);
  assert.equal(shared.computed.summary.netDamageApplied, 9 + 6 + 3);

  const totalsOnly = playerShareSettings(sampleLog({ includeEnemyStats: true, shareMode: SHARE_MODES.PARTY_DPR_ONLY }));
  assert.equal(totalsOnly.enemyStats, false);
  assert.equal(totalsOnly.roundLog, false);
  assert.equal(playerViewLog(sampleLog({ includeEnemyStats: true, shareMode: SHARE_MODES.PARTY_DPR_ONLY })).computed.dpr.enemyDPR, null);
});

test("hidden combatants appear only when the combat includes them", () => {
  const view = playerViewLog(sampleLog({ includeHiddenCombatants: true, anonymizeEnemies: false }));
  assert.ok(view.participants.some((participant) => participant.combatantId === "assassin" && participant.name === "Hidden Assassin"));
  assert.ok(view.events.some((event) => event.id === "assassin-hits"));
  assert.equal(view.computed.byCombatant.find((row) => row.id === "hero").damageAppliedNet, 13);
});

test("logs without saved choices follow the module defaults", () => {
  const log = sampleLog();
  log.shareSettings = {};
  settings.set(`${MODULE_ID}.${SETTINGS.DEFAULT_ANONYMIZE_ENEMIES}`, false);
  settings.set(`${MODULE_ID}.${SETTINGS.DEFAULT_SHARE_MODE}`, SHARE_MODES.SUMMARY_ONLY);
  try {
    const share = playerShareSettings(log);
    assert.equal(share.anonymizeEnemies, false);
    assert.equal(share.hideEnemyNames, false);
    assert.equal(share.shareMode, SHARE_MODES.SUMMARY_ONLY);
    assert.equal(share.roundLog, false);
    assert.equal(share.includeHiddenCombatants, false);
    assert.equal(share.enemyStats, false);
  } finally {
    settings.delete(`${MODULE_ID}.${SETTINGS.DEFAULT_ANONYMIZE_ENEMIES}`);
    settings.delete(`${MODULE_ID}.${SETTINGS.DEFAULT_SHARE_MODE}`);
  }
  // Unset defaults: names hidden, full recap with Round Log.
  const share = playerShareSettings(log);
  assert.equal(share.hideEnemyNames, true);
  assert.equal(share.shareMode, SHARE_MODES.FULL_VISIBLE_RECAP);
  assert.equal(share.roundLog, true);
});

test("players get no Corrections or Sharing tab, and the Round Log only with action details", () => {
  assert.deepEqual(playerTabs({ roundLog: true }), ["history", "sessions", "summary", "timeline", "statistics", "dpr", "participants"]);
  assert.deepEqual(playerTabs({ roundLog: false }), ["history", "sessions", "summary", "statistics", "dpr", "participants"]);
});

test("history rows for players count visible combatants and party damage only", () => {
  const entry = { combatLogId: "log-1", title: "Ambush", status: "ended", participantCount: 3, inlineLog: sampleLog(), filePath: "worlds/x/data/y.json" };
  const row = playerHistoryEntry(entry, sampleLog());
  assert.equal(row.participantCount, 2);
  assert.equal(row.netDamageApplied, 9);
  assert.equal(row.inlineLog, undefined);
  assert.equal(row.filePath, undefined);
  const missing = playerHistoryEntry(entry, null);
  assert.equal(missing.participantCount, "-");
  assert.equal(missing.loaded, false);
});

test("every action that changes, hands out or exports a log refuses players", async () => {
  const calls = [];
  const record = (name) => async (...args) => {
    calls.push(name);
    return args[0] ?? true;
  };
  const service = {
    deleteLog: record("deleteLog"),
    saveAndCompute: record("saveAndCompute"),
    addManualAdjustment: record("addManualAdjustment"),
    setEventSource: record("setEventSource"),
    debugLog: record("debugLog"),
    getLog: record("getLog"),
    listActiveLogs: () => [],
    persistence: { loadLog: record("loadLog"), loadActiveLogs: async () => [] }
  };
  const app = new CombatLogApp(service, "log-1");
  const readOnlyActions = ["switchTab", "openLog", "selectSession", "sortDpr"];
  const actions = Object.entries(CombatLogApp.DEFAULT_OPTIONS.actions).filter(([name]) => !readOnlyActions.includes(name));
  assert.deepEqual(actions.map(([name]) => name).sort(), [
    "addAdjustment", "copyDiscordReport", "copySessionDiscord", "createJournalReport", "deleteLog", "exportCsv", "exportDebug", "exportJson",
    "exportMarkdown", "ignoreEvent", "postPlayerReport", "postSessionReport", "renameLog", "restoreEvent", "saveSharing", "stopSharing"
  ]);
  warnings.length = 0;
  await asPlayer(async () => {
    for (const [, handler] of actions) {
      const target = { dataset: { logId: "log-1", eventId: "event-1" }, closest: () => null };
      await handler.call(app, {}, target);
    }
    await app.handleSelectChange({ currentTarget: { dataset: { sclsAction: "setSide", combatantId: "hero" }, value: SIDES.HOSTILE } });
    await app.saveLog({ id: "log-1" });
  });
  assert.deepEqual(calls, []);
  assert.equal(warnings.length, actions.length + 1);
  assert.ok(warnings.every((message) => message === english["SCLS.Notification.ReadOnly"]));
  assert.equal(asPlayer(() => app.readOnly), true);
  assert.equal(asGM(() => app.readOnly), false);
});

test("the window prepares the player view: read only, no GM tabs and nothing the GM keeps back", async () => {
  const stored = sampleLog();
  const service = {
    statsOptions: () => ({}),
    listActiveLogs: () => [],
    flushPendingSaves: async () => {
      throw new Error("players never flush");
    },
    persistence: {
      loadLog: async () => structuredClone(stored),
      loadActiveLogs: async () => [structuredClone({ ...stored, status: "active" })],
      loadHistoryEntries: async () => [{ combatLogId: "log-1", title: "Ambush", status: "ended", participantCount: 3, netDamageApplied: 27, loaded: true }]
    }
  };
  const app = new CombatLogApp(service);
  app.activeTab = "corrections";
  const context = await app._prepareContext({});

  assert.equal(app.logId, "log-1", "the running fight stays selected");
  assert.equal(context.readOnly, true);
  assert.equal(context.enemyStats, false);
  assert.equal(context.activeTab, "summary");
  assert.deepEqual(context.tabs.map((tab) => tab.id), ["history", "sessions", "summary", "timeline", "statistics", "dpr", "participants"]);
  for (const key of ["sharing", "correctionEvents", "manualAdjustmentEvents", "participantOptions", "reportSectionOptions"]) assert.equal(key in context, false, key);
  assert.equal(context.netDamageLabel, english["SCLS.Label.PartyNetDamage"]);
  assert.equal(context.charts.roundLegend.length, 1);
  assert.deepEqual(context.historyRows, [], "history rows wait for the History tab");
  const actions = context.combatRounds.flatMap((round) => round.actions);
  assert.ok(actions.length > 0);
  assert.equal(actions.some((action) => action.kind === "damage" && action.amount === 2), false, "manual changes only count in the numbers");
  const page = JSON.stringify(context);
  for (const secret of ["Hidden Assassin", "Goblin Boss", "Secret Technique", "mayor", "sneak attack", "Poisoned Dagger"]) assert.equal(page.includes(secret), false, secret);

  app.activeTab = "history";
  const history = await app._prepareContext({});
  assert.equal(history.historyRows[0].participantCount, 2);
  assert.equal(history.historyRows[0].netDamageApplied, 9);
});
