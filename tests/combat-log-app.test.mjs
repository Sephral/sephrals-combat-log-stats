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

  assert.equal(result.historyTab.id, "history");
  assert.equal(result.showConnector, true);
  assert.equal(result.connectorIcon, "fa-solid fa-angles-right");
  assert.equal(result.detailTabs.some((tab) => tab.id === "summary" && tab.active), true);
  assert.equal(result.detailTabs.some((tab) => tab.id === "history"), false);
  assert.equal(result.detailTabs.some((tab) => tab.id === "raw"), false);
  assert.equal(result.detailTabs.some((tab) => tab.id === "export"), false);
});

test("tab navigation shows only history when no combat is selected", () => {
  const result = __test__.tabNavigation(false, "history");

  assert.equal(result.historyTab.id, "history");
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
