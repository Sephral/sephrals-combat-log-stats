import assert from "node:assert/strict";
import { test } from "node:test";
import { CONFIDENCE, EVENT_TYPES, HOOKS, RESOURCE_INTERPRETATIONS, SIDES } from "../scripts/constants.js";

globalThis.game = { i18n: { lang: "en", localize: (key) => key }, settings: { get: () => false } };
globalThis.foundry = { applications: { api: { ApplicationV2: class { async close() {} } } } };

const hookCallbacks = new Map();
globalThis.Hooks = {
  on: (name, callback) => hookCallbacks.set(name, callback),
  off: (name, callback) => {
    if (hookCallbacks.get(name) === callback) hookCallbacks.delete(name);
  }
};

const { CombatLogApp, __test__ } = await import("../scripts/apps/combat-log-app.js");

test("correction candidates include unclear, corrected and unattributed hit point changes", () => {
  const result = __test__.correctionEvents({
    participants: [{ combatantId: "hero", name: "Hero", side: SIDES.FRIENDLY }, { combatantId: "foe", name: "Foe", side: SIDES.HOSTILE }],
    events: [
      { id: "started", type: EVENT_TYPES.COMBAT_STARTED, confidence: CONFIDENCE.UNCLEAR, data: {} },
      { id: "attributed", type: EVENT_TYPES.RESOURCE_DELTA, combatantId: "hero", confidence: CONFIDENCE.SAFE, data: { interpretedAs: RESOURCE_INTERPRETATIONS.DAMAGE, attribution: "systemApplied", targetCombatantId: "foe" } },
      { id: "no-source", type: EVENT_TYPES.RESOURCE_DELTA, combatantId: "foe", confidence: CONFIDENCE.PROBABLE, data: { interpretedAs: RESOURCE_INTERPRETATIONS.DAMAGE, targetCombatantId: "foe" } },
      { id: "unclear-delta", type: EVENT_TYPES.RESOURCE_DELTA, combatantId: "foe", confidence: CONFIDENCE.UNCLEAR, data: { interpretedAs: RESOURCE_INTERPRETATIONS.UNKNOWN } },
      { id: "manual-delta", type: EVENT_TYPES.RESOURCE_DELTA_OFFLINE, combatantId: "hero", confidence: CONFIDENCE.MANUAL, data: { manualCorrection: true, interpretedAs: RESOURCE_INTERPRETATIONS.HEALING } }
    ]
  });

  assert.deepEqual(result.map((event) => event.id), ["no-source", "unclear-delta", "manual-delta"]);
  assert.equal(result[0].targetName, "Foe");
  assert.equal(result[0].sourceOptions.find((option) => option.selected)?.value, "");
  assert.equal(result[0].sourceOptions.some((option) => option.value === "foe"), false);
  assert.equal(result[1].interpretationOptions.find((option) => option.value === RESOURCE_INTERPRETATIONS.UNKNOWN)?.selected, true);
  assert.equal(result[2].interpretationOptions.find((option) => option.value === RESOURCE_INTERPRETATIONS.HEALING)?.selected, true);
});

test("participant side options preserve the selected side", () => {
  const result = __test__.participantRows({
    participants: [{ combatantId: "foe", name: "Foe", side: SIDES.HOSTILE }],
    computed: { byCombatant: [{ id: "foe", damageAppliedNet: 3 }] }
  });

  assert.equal(result[0].sideOptions.find((option) => option.value === SIDES.HOSTILE)?.selected, true);
  assert.equal(result[0].stats.damageAppliedNet, 3);
});

test("combat rounds group readable damage and healing actions by round", () => {
  const result = __test__.combatRounds({
    participants: [
      { combatantId: "hero", name: "Hero", side: SIDES.FRIENDLY, img: "hero.webp" },
      { combatantId: "foe", name: "Foe", side: SIDES.HOSTILE, img: "foe.webp" }
    ],
    computed: { summary: { rounds: 2 } },
    events: [
      { id: "hit", type: EVENT_TYPES.DAMAGE_APPLIED, round: 1, combatantId: "hero", confidence: CONFIDENCE.SAFE, data: { amount: 7, targetCombatantId: "foe", actionName: "Fire Bolt" } },
      { id: "heal", type: EVENT_TYPES.HEALING_APPLIED, round: 1, combatantId: "hero", confidence: CONFIDENCE.SAFE, data: { amount: 3, targetCombatantId: "hero" } },
      { id: "miss", type: EVENT_TYPES.TURN_CHANGED, round: 2, combatantId: "foe", confidence: CONFIDENCE.SAFE, data: {} }
    ]
  });

  assert.equal(result.length, 1);
  assert.equal(result[0].actions.length, 2);
  assert.equal(result[0].heroDamage, 7);
  assert.equal(result[0].healing, 3);
  assert.equal(result[0].actions[0].actor, "Hero");
  assert.equal(result[0].actions[0].target, "Foe");
  assert.equal(result[0].actions[0].detail, "Fire Bolt");
});

test("dpr rows read the computed discipline metrics", () => {
  const result = __test__.dprRows({
    participants: [
      { combatantId: "hero", name: "Hero", side: SIDES.FRIENDLY, img: "hero.webp" },
      { combatantId: "foe", name: "Foe", side: SIDES.HOSTILE, img: "foe.webp" }
    ],
    events: [],
    computed: { dpr: { byCombatant: [{ id: "hero", name: "Hero", side: SIDES.FRIENDLY, damageAppliedNet: 12, netDPR: 6, healingNet: 5, martial: 1, magic: 1, control: 1, downed: 1, takedowns: 2 }] } }
  });

  assert.equal(result[0].img, "hero.webp");
  assert.equal(result[0].damageAppliedNet, 12);
  assert.equal(result[0].netDPR, 6);
  assert.equal(result[0].healing, 5);
  assert.equal(result[0].martial, 1);
  assert.equal(result[0].magic, 1);
  assert.equal(result[0].control, 1);
  assert.equal(result[0].downed, 1);
  assert.equal(result[0].takedowns, 2);
  assert.equal(result[0].sideLabel, "SCLS.Side.friendly");
});

test("impact meter rows sort by numeric and text columns", () => {
  const log = {
    participants: [
      { combatantId: "alpha", name: "Alpha", side: SIDES.FRIENDLY, img: "alpha.webp" },
      { combatantId: "beta", name: "Beta", side: SIDES.HOSTILE, img: "beta.webp" },
      { combatantId: "gamma", name: "Gamma", side: SIDES.NEUTRAL, img: "gamma.webp" }
    ],
    events: [],
    computed: {
      dpr: {
        byCombatant: [
          { id: "alpha", name: "Alpha", side: SIDES.FRIENDLY, damageAppliedNet: 8, netDPR: 4 },
          { id: "beta", name: "Beta", side: SIDES.HOSTILE, damageAppliedNet: 15, netDPR: 7.5 },
          { id: "gamma", name: "Gamma", side: SIDES.NEUTRAL, damageAppliedNet: 3, netDPR: 1.5 }
        ]
      }
    }
  };

  assert.deepEqual(__test__.sortedDprRows(log, { key: "damageAppliedNet", direction: "desc" }).map((row) => row.name), ["Beta", "Alpha", "Gamma"]);
  assert.deepEqual(__test__.sortedDprRows(log, { key: "name", direction: "asc" }).map((row) => row.name), ["Alpha", "Beta", "Gamma"]);
  assert.equal(__test__.dprColumns({ key: "netDPR", direction: "asc" }).find((column) => column.key === "netDPR")?.icon, "fa-solid fa-arrow-up-wide-short");
});

test("combat metrics summarize contributions, disciplines, and top actions", () => {
  const result = __test__.combatMetrics({
    participants: [
      { combatantId: "hero", name: "Hero", side: SIDES.FRIENDLY, img: "hero.webp" },
      { combatantId: "foe", name: "Foe", side: SIDES.HOSTILE, img: "foe.webp" }
    ],
    events: [
      { id: "hit", type: EVENT_TYPES.DAMAGE_APPLIED, combatantId: "hero", data: { amount: 12, actionName: "Longsword Slash", actionKind: "melee", targetCombatantId: "foe" } },
      { id: "spell", type: EVENT_TYPES.DAMAGE_APPLIED, combatantId: "hero", data: { amount: 10, actionName: "Fireball", actionKind: "spell", targetCombatantId: "foe" } },
      { id: "heal", type: EVENT_TYPES.HEALING_APPLIED, combatantId: "hero", data: { amount: 5, actionName: "Healing Word", targetCombatantId: "hero" } },
      { id: "control", type: EVENT_TYPES.ACTIVE_EFFECT_CREATED, combatantId: "hero", data: { name: "Slowed", control: true, sourceCombatantId: "hero", targetCombatantId: "foe" } }
    ],
    computed: {
      summary: { netDamageApplied: 31, netHealingApplied: 5, partyDowned: 1, enemiesDefeated: 0 },
      dpr: {
        byCombatant: [
          { id: "hero", name: "Hero", side: SIDES.FRIENDLY, damageAppliedNet: 22, damageTakenNet: 9, healingNet: 5, martial: 1, magic: 1, control: 1, downed: 1, netDPR: 11 },
          { id: "foe", name: "Foe", side: SIDES.HOSTILE, damageAppliedNet: 9, damageTakenNet: 22, netDPR: 4.5 }
        ],
        bySide: [
          { id: SIDES.FRIENDLY, name: SIDES.FRIENDLY, damageAppliedNet: 22, damageTakenNet: 9, damageRolled: 0, damageAppliedGross: 22, netDPR: 11 },
          { id: SIDES.HOSTILE, name: SIDES.HOSTILE, damageAppliedNet: 9, damageTakenNet: 22, damageRolled: 0, damageAppliedGross: 9, netDPR: 4.5 }
        ]
      }
    }
  });

  assert.equal(result.contributionRows[0].name, "Hero");
  assert.equal(result.contributionRows[0].damagePercent, 100);
  assert.deepEqual(result.contributionRows[0].impactMetrics.map((metric) => metric.type), ["damage", "taken", "healing", "control", "downed"]);
  assert.equal(result.totals.damage, 31);
  assert.equal(result.totals.healing, 5);
  assert.equal(result.totals.control, 1);
  assert.equal(result.totals.partyDowned, 1);
  assert.equal(result.disciplineRows.find((row) => row.id === "magic")?.value, 1);
  assert.equal(result.disciplineRows.find((row) => row.id === "damage")?.percent, 100);
  assert.ok((result.disciplineRows.find((row) => row.id === "healing")?.percent ?? 0) < 100);
  assert.equal(result.topActions[0].name, "Longsword Slash");
  assert.equal(result.topActions[0].kindLabel, "SCLS.ActionKind.damage");
  assert.equal(result.topActions.some((row) => row.name === "Slowed" && row.kind === "control"), true);
  assert.equal(result.pressureRows[0].pressurePercent, 100);
});

test("history rows format combat index entries and mark the selected log", () => {
  const result = __test__.historyRows([
    { combatLogId: "older", title: "Older Fight", status: "ended", startedAt: "2026-05-17T10:00:00.000Z", rounds: 3, participantCount: 4, netDamageApplied: 22, partyDPR: 7.33, loaded: true },
    { combatLogId: "current", title: "Current Fight", status: "active", startedAt: "2026-05-17T11:00:00.000Z", rounds: 1, participantCount: 2, netDamageApplied: 12, partyDPR: 12, loaded: false }
  ], "current");

  assert.equal(result.length, 2);
  assert.equal(result[0].selected, false);
  assert.equal(result[0].statusLabel, "SCLS.Status.ended");
  assert.equal(result[0].loadedLabel, "SCLS.Label.Stored");
  assert.equal(result[1].selected, true);
  assert.equal(result[1].loadedLabel, "SCLS.Label.IndexOnly");
});

test("tab navigation separates history selection from combat detail pages", () => {
  const result = __test__.tabNavigation(true, "summary");

  assert.deepEqual(result.overviewTabs.map((tab) => tab.id), ["history", "sessions"]);
  assert.equal(result.showConnector, true);
  assert.equal(result.connectorIcon, "fa-solid fa-angles-right");
  assert.equal(result.detailTabs.some((tab) => tab.id === "summary" && tab.active), true);
  assert.equal(result.detailTabs.some((tab) => tab.id === "history" || tab.id === "sessions"), false);
  assert.equal(result.detailTabs.some((tab) => tab.id === "raw"), false);
  assert.equal(result.detailTabs.some((tab) => tab.id === "export"), false);
});

test("tab navigation shows only history and sessions when no combat is selected", () => {
  const result = __test__.tabNavigation(false, "history");

  assert.deepEqual(result.overviewTabs.map((tab) => tab.id), ["history", "sessions"]);
  assert.equal(result.showConnector, false);
  assert.deepEqual(result.detailTabs, []);
});

test("delete confirmation uses Foundry dialog instead of blocking browser confirm", async () => {
  let dialogOptions = null;
  let browserConfirmCalled = false;
  globalThis.foundry.applications.api.DialogV2 = {
    confirm: async (options) => {
      dialogOptions = options;
      return false;
    }
  };
  globalThis.confirm = () => {
    browserConfirmCalled = true;
    return true;
  };

  const confirmed = await __test__.confirmDeleteCombatLog("Danger <Combat>");

  assert.equal(confirmed, false);
  assert.equal(browserConfirmCalled, false);
  assert.equal(dialogOptions.window.title, "SCLS.Confirm.DeleteCombatTitle");
  assert.equal(dialogOptions.yes.icon, "fa-solid fa-trash");
  assert.match(dialogOptions.content, /Danger &lt;Combat&gt;/);
  delete globalThis.foundry.applications.api.DialogV2;
  delete globalThis.confirm;
});

function sharingLog() {
  return {
    id: "log-1",
    title: "Bridge Fight",
    participants: [
      { combatantId: "hero", name: "Hero", side: SIDES.FRIENDLY, isPlayerOwned: true },
      { combatantId: "gob", name: "Goblin Boss", side: SIDES.HOSTILE },
      { combatantId: "lurker", name: "Lurker", side: SIDES.FRIENDLY, hidden: true }
    ],
    computed: { summary: { rounds: 1 } },
    events: [
      { id: "hit", type: EVENT_TYPES.DAMAGE_APPLIED, round: 1, combatantId: "hero", confidence: CONFIDENCE.SAFE, visibility: "public", data: { amount: 7, actionName: "Longsword", actionKind: "melee", targetCombatantId: "gob" } },
      { id: "stab", type: EVENT_TYPES.DAMAGE_APPLIED, round: 1, combatantId: "lurker", confidence: CONFIDENCE.SAFE, visibility: "public", data: { amount: 3, actionName: "Dagger", actionKind: "melee", targetCombatantId: "gob" } }
    ],
    shareSettings: { isShared: false, anonymizeEnemies: true }
  };
}

function sharingForm({ mode = "fullVisibleRecap", anonymize = true, hidden = false, sections = ["combatRecap", "martialHighlights"] } = {}) {
  const form = new FormData();
  form.set("shareMode", mode);
  if (anonymize) form.set("anonymizeEnemies", "on");
  if (hidden) form.set("includeHiddenCombatants", "on");
  for (const section of sections) form.append("reportSections", section);
  return form;
}

async function withEnglish(callback) {
  const { readFileSync } = await import("node:fs");
  const english = JSON.parse(readFileSync(new URL("../lang/en.json", import.meta.url), "utf8"));
  const previous = game.i18n.localize;
  game.i18n.localize = (key) => english[key] ?? key;
  try {
    return await callback();
  } finally {
    game.i18n.localize = previous;
  }
}

test("report settings are read from the form without changing the log", () => {
  const log = sharingLog();
  const settings = __test__.reportSettingsFromForm(log, sharingForm({ anonymize: false, hidden: true }));

  assert.equal(settings.shareMode, "fullVisibleRecap");
  assert.equal(settings.anonymizeEnemies, false);
  assert.equal(settings.includeNpcNames, true);
  assert.equal(settings.includeHiddenCombatants, true);
  assert.equal(settings.reportSections.martialHighlights, true);
  assert.equal(settings.reportSections.aftermath, false);
  assert.deepEqual(log.shareSettings, { isShared: false, anonymizeEnemies: true });

  __test__.applyReportSettings(log, sharingForm());
  assert.equal(log.shareSettings.isShared, true);
  assert.equal(log.shareSettings.anonymizeEnemies, true);
  assert.ok(log.shareSettings.shareStartedAt);
  assert.equal(log.shareSettings.shareUpdatedAt, log.shareSettings.shareStartedAt);
});

test("the sharing preview renders the player report for the unsaved form settings", async () => {
  const { PlayerReportService } = await import("../scripts/services/player-report-service.js");
  const service = new PlayerReportService();
  await withEnglish(() => {
    const anonymous = __test__.reportPreviewHtml(service, sharingLog(), sharingForm());
    assert.match(anonymous, /^<div class="scls-report">/);
    assert.match(anonymous, /<h4>Blades and Bows<\/h4><ul><li>Round 1: Hero hit Enemy 1 with Longsword for 7 damage\.<\/li>/);
    assert.doesNotMatch(anonymous, /Goblin Boss|Lurker|Dagger/);

    const named = __test__.reportPreviewHtml(service, sharingLog(), sharingForm({ anonymize: false, hidden: true }));
    assert.match(named, /Hero hit Goblin Boss with Longsword/);
    assert.match(named, /Lurker hit Goblin Boss with Dagger/);

    const summary = __test__.reportPreviewHtml(service, sharingLog(), sharingForm({ mode: "summaryOnly" }));
    assert.doesNotMatch(summary, /Blades and Bows/);
  });
});

test("a Discord report longer than one message lists every part with its own copy button", () => {
  const html = __test__.discordPartsContent(["## One <b>", "Two & more"]);
  assert.match(html, /^<div class="scls-discord-parts"><p>SCLS\.Discord\.Hint<\/p>/);
  assert.equal((html.match(/data-scls-copy-part="\d"/g) ?? []).join(" "), "data-scls-copy-part=\"0\" data-scls-copy-part=\"1\"");
  assert.match(html, /<textarea readonly rows="6">## One &lt;b&gt;<\/textarea>/);
  assert.match(html, /<textarea readonly rows="6">Two &amp; more<\/textarea>/);
});

test("Discord parts open in a Foundry dialog whose buttons copy one part each", async () => {
  const copied = [];
  const listeners = [];
  let dialogOptions = null;
  globalThis.game.clipboard = { copyPlainText: async (text) => copied.push(text) };
  globalThis.foundry.applications.api.DialogV2 = {
    wait: async (options) => {
      dialogOptions = options;
      const buttons = [0, 1, 2].map((index) => ({ dataset: { sclsCopyPart: String(index) }, classList: { add: () => {} }, addEventListener: (type, callback) => listeners.push(callback) }));
      options.render({}, { element: { querySelectorAll: () => buttons } });
      return "close";
    }
  };
  try {
    await __test__.showDiscordParts(["first", "second", "third"]);
    assert.equal(dialogOptions.window.title, "SCLS.Discord.Title");
    assert.equal(dialogOptions.buttons.length, 1);
    assert.equal(listeners.length, 3);
    await listeners[1]();
    assert.deepEqual(copied, ["second"]);
  } finally {
    delete globalThis.game.clipboard;
    delete globalThis.foundry.applications.api.DialogV2;
  }
});

test("copying uses Foundry's clipboard helper and falls back to the Clipboard API", async () => {
  const copied = [];
  globalThis.game.clipboard = { copyPlainText: async (text) => copied.push(`foundry:${text}`) };
  assert.equal(await __test__.copyText("one"), true);
  delete globalThis.game.clipboard;

  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: async (text) => copied.push(`browser:${text}`) } } });
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = () => {};
  globalThis.ui = { notifications: { error: (message) => warnings.push(message) } };
  try {
    assert.equal(await __test__.copyText("two"), true);
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: async () => { throw new Error("blocked"); } } } });
    assert.equal(await __test__.copyText("three"), false);
    assert.deepEqual(copied, ["foundry:one", "browser:two"]);
    assert.deepEqual(warnings, ["SCLS.Notification.CopyFailed"]);
  } finally {
    console.warn = originalWarn;
    delete globalThis.ui;
    if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    else delete globalThis.navigator;
  }
});

test("open combat log windows schedule a live render for matching log updates", async () => {
  let renders = 0;
  const app = new CombatLogApp({ persistence: {}, listActiveLogs: () => [] }, "current");
  app.element = { isConnected: true };
  app.render = async () => { renders += 1; };

  assert.equal(hookCallbacks.has(HOOKS.LOG_UPDATED), true);
  hookCallbacks.get(HOOKS.LOG_UPDATED)({ id: "other" });
  hookCallbacks.get(HOOKS.LOG_UPDATED)({ id: "current" });
  hookCallbacks.get(HOOKS.LOG_UPDATED)({ id: "current" });
  await new Promise((resolve) => setTimeout(resolve, 350));

  assert.equal(renders, 1);
  await app.close();
  assert.equal(hookCallbacks.has(HOOKS.LOG_UPDATED), false);
});

test("the round log leaves out states the system sets on its own", () => {
  const effect = (id, type, statuses, name, extra = {}) => ({ id, type, round: 1, combatantId: "foe", confidence: CONFIDENCE.PROBABLE, data: { name, statuses, sourceCombatantId: "hero", targetCombatantId: "foe", ...extra } });
  const result = __test__.combatRounds({
    participants: [
      { combatantId: "hero", name: "Hero", side: SIDES.FRIENDLY, img: "hero.webp" },
      { combatantId: "foe", name: "Foe", side: SIDES.HOSTILE, img: "foe.webp" }
    ],
    computed: { summary: { rounds: 1 } },
    events: [
      effect("bloodied", EVENT_TYPES.ACTIVE_EFFECT_CREATED, ["bloodied"], "Bloodied"),
      effect("bloodied-gone", EVENT_TYPES.ACTIVE_EFFECT_DELETED, ["bloodied"], "Bloodied"),
      effect("focus", EVENT_TYPES.ACTIVE_EFFECT_CREATED, ["concentrating"], "Concentrating: Bless"),
      effect("old-log", EVENT_TYPES.ACTIVE_EFFECT_CREATED, undefined, "Bloodied"),
      effect("prone", EVENT_TYPES.ACTIVE_EFFECT_CREATED, ["prone"], "Prone", { control: true }),
      effect("bless", EVENT_TYPES.ACTIVE_EFFECT_CREATED, [], "Bless", { control: false })
    ]
  });

  assert.deepEqual(result[0].actions.map((action) => action.detail), ["Prone", "Bless"]);
});

function crucibleLog() {
  return {
    id: "log-c",
    systemId: "crucible",
    participants: [
      { combatantId: "aria", name: "Aria", side: SIDES.FRIENDLY },
      { combatantId: "orc", name: "Orc", side: SIDES.HOSTILE }
    ],
    computed: {
      summary: { rounds: 2 },
      byCombatant: [
        { id: "aria", name: "Aria", side: SIDES.FRIENDLY, damageAppliedNet: 12, healingNet: 0, damageTakenNet: 3, moraleDamageDealt: 4, takedowns: 1, downed: 0 },
        { id: "orc", name: "Orc", side: SIDES.HOSTILE, damageAppliedNet: 3, damageTakenNet: 12, downed: 1 }
      ],
      dpr: { method: "appliedNet" },
      warningCounts: { openActions: 1 }
    },
    events: [
      { id: "card", type: EVENT_TYPES.ACTION_USED, round: 1, combatantId: "aria", confidence: CONFIDENCE.SAFE, data: { status: "pending", actionName: "Flame Arrow", plannedDamage: 8, outcomes: [{ targetCombatantId: "orc", pools: { health: -8 } }] } },
      { id: "done", type: EVENT_TYPES.ACTION_USED, round: 1, combatantId: "aria", confidence: CONFIDENCE.SAFE, data: { status: "confirmed", actionName: "Strike", plannedDamage: 12, outcomes: [] } },
      { id: "hit", type: EVENT_TYPES.RESOURCE_DELTA, round: 1, combatantId: "aria", confidence: CONFIDENCE.SAFE, data: { pool: "health", resourcePath: "system.resources.health.value", interpretedAs: RESOURCE_INTERPRETATIONS.DAMAGE, delta: -12, oldValue: 12, newValue: 0, attribution: "systemApplied", sourceCombatantId: "aria", targetCombatantId: "orc", actionName: "Strike", downState: "dead", targetDowned: true } },
      { id: "taunt", type: EVENT_TYPES.RESOURCE_DELTA, round: 2, combatantId: "aria", confidence: CONFIDENCE.SAFE, data: { pool: "morale", resourcePath: "system.resources.morale.value", interpretedAs: RESOURCE_INTERPRETATIONS.DAMAGE, delta: -4, oldValue: 8, newValue: 4, attribution: "systemApplied", sourceCombatantId: "aria", targetCombatantId: "orc", actionName: "Taunt" } },
      { id: "undo", type: EVENT_TYPES.RESOURCE_DELTA, round: 2, combatantId: "aria", confidence: CONFIDENCE.SAFE, data: { pool: "health", resourcePath: "system.resources.health.value", interpretedAs: RESOURCE_INTERPRETATIONS.CORRECTION_DAMAGE_DOWN, reversal: true, delta: 2, oldValue: 0, newValue: 2, attribution: "systemApplied", sourceCombatantId: "aria", targetCombatantId: "orc", actionName: "Strike" } },
      { id: "bleed", type: EVENT_TYPES.RESOURCE_DELTA, round: 2, combatantId: "aria", confidence: CONFIDENCE.PROBABLE, data: { pool: "health", resourcePath: "system.resources.health.value", interpretedAs: RESOURCE_INTERPRETATIONS.DAMAGE, delta: -7, oldValue: 3, newValue: 0, parts: { health: -3, wounds: 4 }, targetCombatantId: "aria" } }
    ]
  };
}

test("the Crucible round log shows open action cards, morale, states and undone cards", () => {
  const rounds = __test__.combatRounds(crucibleLog());
  const verbs = rounds.flatMap((round) => round.actions.map((action) => `${action.verb}|${action.actor}|${action.target}|${action.amountLabel}`));
  assert.ok(verbs.includes("SCLS.Protocol.ActionOpen|Aria|Orc|8"), verbs.join("\n"));
  assert.ok(!verbs.some((verb) => verb.includes("|Aria|-|12") && verb.startsWith("SCLS.Protocol.ActionOpen")));
  assert.ok(verbs.includes("SCLS.Crucible.State.dead|Orc|-|-"));
  assert.ok(verbs.includes("SCLS.Protocol.MoraleDamage|Aria|Orc|4"));
  assert.ok(verbs.includes("SCLS.Protocol.ActionUndone|Aria|Orc|2"));
  const round2 = rounds.find((round) => round.round === 2);
  // Morale damage is not added to the party's damage of the round.
  assert.equal(round2.heroDamage, 0);
  assert.equal(round2.actions.find((action) => action.verb === "SCLS.Protocol.MoraleDamage").kind, "morale");
});

test("Crucible corrections name the pool and its parts", () => {
  const [bleed] = __test__.correctionEvents(crucibleLog());
  assert.equal(bleed.id, "bleed");
  assert.equal(bleed.label, "SCLS.Crucible.Event.health");
  assert.equal(bleed.partsLabel, "SCLS.Crucible.Pool.health -3, SCLS.Crucible.Pool.wounds +4");
});

test("warnings use Crucible wording and report open action cards", () => {
  assert.deepEqual(__test__.warningLines({ openActions: 2, unclearExcluded: 1 }, "crucible"), ["SCLS.Crucible.Warning.UnclearExcludedOne", "SCLS.Warning.OpenActionsOther"]);
  assert.deepEqual(__test__.warningLines({ unclearExcluded: 1 }, "dnd5e"), ["SCLS.Warning.UnclearExcludedOne"]);
});

test("the morale column appears in Crucible logs only", () => {
  assert.ok(__test__.dprColumns({}, { morale: true }).some((column) => column.key === "moraleDamageDealt"));
  assert.ok(!__test__.dprColumns({}).some((column) => column.key === "moraleDamageDealt"));
  assert.equal(__test__.dprRows(crucibleLog())[0].moraleDamageDealt, 4);
});

test("the statistics charts use stored or computed round numbers", () => {
  const log = crucibleLog();
  const charts = __test__.chartContext(log);
  // No byRound stored: computed from the events (12 in round 1, 2 undone in round 2).
  assert.equal(charts.hasCharts, true);
  assert.match(charts.roundChart, /<svg class="scls-chart__svg"/);
  assert.match(charts.combatantChart, /Aria/);
  assert.equal(charts.roundLegend.length, 2);
  assert.equal(charts.combatantLegend.length, 3);
  const empty = __test__.chartContext({ participants: [], events: [], computed: { byRound: [], byCombatant: [] } });
  assert.equal(empty.hasCharts, false);
});

test("award cards list party members only", () => {
  const cards = __test__.awardCards(crucibleLog());
  const mvp = cards.find((card) => card.key === "mvp");
  assert.equal(mvp.names, "Aria");
  assert.equal(mvp.label, "SCLS.Award.Label.mvp");
  assert.equal(mvp.icon, "fa-solid fa-crown");
  assert.ok(cards.every((card) => card.names !== "Orc"));
});

test("every key in the window template exists in both languages", async () => {
  const { readFileSync } = await import("node:fs");
  const template = readFileSync(new URL("../templates/combat-log-app.hbs", import.meta.url), "utf8");
  const keys = Array.from(template.matchAll(/sclsLocalize "([^"]+)"/g), (match) => match[1]);
  for (const language of ["en", "de"]) {
    const strings = JSON.parse(readFileSync(new URL(`../lang/${language}.json`, import.meta.url), "utf8"));
    for (const key of keys) assert.ok(key in strings, `${language}: ${key}`);
  }
});

test("Crucible and award keys exist in both languages and follow the text rules", async () => {
  const { readFileSync } = await import("node:fs");
  const languages = Object.fromEntries(["en", "de"].map((language) => [language, JSON.parse(readFileSync(new URL(`../lang/${language}.json`, import.meta.url), "utf8"))]));
  const own = (language) => Object.keys(languages[language]).filter((key) => /^SCLS\.(Crucible|Award|Chart)\./.test(key)).sort();
  assert.deepEqual(own("de"), own("en"));
  const { SYSTEM_TERM_KEYS } = await import("../scripts/services/system-terms.js");
  for (const key of SYSTEM_TERM_KEYS.crucible) assert.ok(key.replace(/^SCLS\./, "SCLS.Crucible.") in languages.en, key);
  for (const language of ["en", "de"]) {
    for (const key of own(language)) {
      const value = languages[language][key];
      assert.doesNotMatch(value, /;|\s[-–—]\s|[–—]|\bHP\b|\bTP\b/, `${language}: ${key}`);
    }
  }
});

test("Crucible corrections offer no temporary or maximum hit point choices and use Crucible wording", async () => {
  const dnd = __test__.interpretationOptions("damage", "dnd5e").map((option) => option.value);
  const crucible = __test__.interpretationOptions("damage", "crucible").map((option) => option.value);
  assert.ok(dnd.includes(RESOURCE_INTERPRETATIONS.TEMP_HP_GAIN) && dnd.includes(RESOURCE_INTERPRETATIONS.MAX_HP_CHANGE));
  assert.ok(!crucible.some((value) => [RESOURCE_INTERPRETATIONS.TEMP_HP_GAIN, RESOURCE_INTERPRETATIONS.TEMP_HP_LOSS, RESOURCE_INTERPRETATIONS.MAX_HP_CHANGE].includes(value)));
  assert.ok(crucible.includes(RESOURCE_INTERPRETATIONS.DAMAGE) && crucible.includes(RESOURCE_INTERPRETATIONS.IGNORED));
  // A change filed that way earlier keeps its choice.
  assert.ok(__test__.interpretationOptions(RESOURCE_INTERPRETATIONS.MAX_HP_CHANGE, "crucible").some((option) => option.selected && option.value === RESOURCE_INTERPRETATIONS.MAX_HP_CHANGE));
  const { termKey } = await import("../scripts/services/system-terms.js");
  assert.equal(termKey("crucible", "SCLS.Label.AutomaticCorrections"), "SCLS.Crucible.Label.AutomaticCorrections");
  assert.equal(termKey("dnd5e", "SCLS.Label.AutomaticCorrections"), "SCLS.Label.AutomaticCorrections");
});

test("the Sharing form hides empty sections and options without anyone to apply to, but keeps their values", () => {
  const log = sharingLog();
  log.shareSettings = { ...log.shareSettings, shareMode: "fullVisibleRecap", reportSections: { spellwork: true, healingSupport: false } };
  const options = __test__.reportSectionOptions(log);
  const option = (key) => options.find((entry) => entry.value === key);
  assert.equal(option("martialHighlights").available, true);
  // No spell, no healing in this fight: hidden, the stored choice stays as it was.
  assert.deepEqual([option("spellwork").available, option("spellwork").selected], [false, true]);
  assert.deepEqual([option("healingSupport").available, option("healingSupport").selected], [false, false]);

  const sharing = __test__.sharingContext(log, { canShare: () => true });
  assert.equal(sharing.showHiddenOption, true);
  assert.equal(sharing.showEnemyOptions, true);
  const friendsOnly = { ...log, participants: log.participants.filter((entry) => entry.side === SIDES.FRIENDLY && !entry.hidden) };
  const quiet = __test__.sharingContext(friendsOnly, { canShare: () => true });
  assert.equal(quiet.showHiddenOption, false);
  assert.equal(quiet.showEnemyOptions, false);

  // Hidden checkboxes are still part of the form data, so saving keeps them.
  const form = sharingForm({ sections: ["combatRecap", "spellwork"] });
  assert.equal(__test__.reportSettingsFromForm(log, form).reportSections.spellwork, true);

  // Live update: labels of sections without content are hidden, the fieldset too when nothing is left.
  const labels = ["combatRecap", "spellwork"].map((key) => ({ dataset: { sclsReportSection: key }, hidden: false }));
  const fieldset = { hidden: false };
  const fakeForm = { querySelectorAll: () => labels, querySelector: () => fieldset };
  __test__.showReportSections(fakeForm, new Set(["combatRecap"]));
  assert.deepEqual(labels.map((label) => label.hidden), [false, true]);
  assert.equal(fieldset.hidden, false);
  __test__.showReportSections(fakeForm, new Set());
  assert.equal(fieldset.hidden, true);
  __test__.showReportSections(fakeForm, new Set(["spellwork"]));
  assert.deepEqual([labels[1].hidden, fieldset.hidden], [false, false]);
});

test("the tabs drop their labels only when they do not fit in one row", () => {
  const nav = (fullWidth, clientWidth) => {
    const classes = new Set(["scls-tabs"]);
    return {
      classes,
      clientWidth,
      // Without labels the tabs need about half the room.
      get scrollWidth() { return classes.has("scls-tabs--compact") ? fullWidth / 2 : fullWidth; },
      classList: { remove: (name) => classes.delete(name), toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)) }
    };
  };
  const wide = nav(1000, 1100);
  assert.equal(__test__.fitTabs(wide), false);
  assert.equal(wide.classes.has("scls-tabs--compact"), false);
  const narrow = nav(1000, 800);
  assert.equal(__test__.fitTabs(narrow), true);
  assert.equal(narrow.classes.has("scls-tabs--compact"), true);
  // Measured with labels again: a wider window brings them back.
  narrow.clientWidth = 1050;
  assert.equal(__test__.fitTabs(narrow), false);
  assert.equal(narrow.classes.has("scls-tabs--compact"), false);
  assert.equal(__test__.fitTabs(null), false);
});

test("combat round totals follow the statistics, so damage without a known source counts like in the chart", () => {
  const result = __test__.combatRounds({
    participants: [
      { combatantId: "hero", name: "Hero", side: SIDES.FRIENDLY },
      { combatantId: "foe", name: "Foe", side: SIDES.HOSTILE }
    ],
    computed: { summary: { rounds: 1 }, byRound: [{ round: 1, partyDamage: 11, enemyDamage: 0, partyHealing: 0, enemyHealing: 0 }] },
    events: [
      { id: "hit", type: EVENT_TYPES.DAMAGE_APPLIED, round: 1, combatantId: "hero", confidence: CONFIDENCE.SAFE, data: { amount: 7, targetCombatantId: "foe" } },
      { id: "unknown", type: "resource.delta", round: 1, combatantId: "foe", confidence: CONFIDENCE.LIKELY, data: { amount: 4, interpretedAs: "damage" } }
    ]
  });
  assert.equal(result[0].heroDamage, 11);
  assert.equal(result[0].foeDamage, 0);
  assert.match(result[0].summary, /11/);
});
