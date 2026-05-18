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

test("correction candidates only include unclear or manually classified resource deltas", () => {
  const result = __test__.correctionEvents({
    events: [
      { id: "started", type: EVENT_TYPES.COMBAT_STARTED, confidence: CONFIDENCE.UNCLEAR, data: {} },
      { id: "resumed", type: EVENT_TYPES.COMBAT_RESUMED, confidence: CONFIDENCE.UNCLEAR, data: {} },
      { id: "safe-delta", type: EVENT_TYPES.RESOURCE_DELTA, confidence: CONFIDENCE.SAFE, data: { interpretedAs: RESOURCE_INTERPRETATIONS.DAMAGE } },
      { id: "unclear-delta", type: EVENT_TYPES.RESOURCE_DELTA, confidence: CONFIDENCE.UNCLEAR, data: { interpretedAs: RESOURCE_INTERPRETATIONS.UNKNOWN } },
      { id: "manual-delta", type: EVENT_TYPES.RESOURCE_DELTA_OFFLINE, confidence: CONFIDENCE.MANUAL, data: { manualCorrection: true, interpretedAs: RESOURCE_INTERPRETATIONS.HEALING } }
    ]
  });

  assert.deepEqual(result.map((event) => event.id), ["unclear-delta", "manual-delta"]);
  assert.equal(result[0].interpretationOptions.find((option) => option.value === RESOURCE_INTERPRETATIONS.UNKNOWN)?.selected, true);
  assert.equal(result[1].interpretationOptions.find((option) => option.value === RESOURCE_INTERPRETATIONS.HEALING)?.selected, true);
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

test("dpr rows include participant images and discipline metrics", () => {
  const result = __test__.dprRows({
    participants: [
      { combatantId: "hero", name: "Hero", side: SIDES.FRIENDLY, img: "hero.webp" },
      { combatantId: "foe", name: "Foe", side: SIDES.HOSTILE, img: "foe.webp" }
    ],
    events: [
      { id: "hit", type: EVENT_TYPES.DAMAGE_APPLIED, combatantId: "hero", data: { amount: 12, actionName: "Longsword Slash", targetCombatantId: "foe" } },
      { id: "spell", type: EVENT_TYPES.DAMAGE_APPLIED, combatantId: "hero", data: { amount: 10, actionName: "Fireball", targetCombatantId: "foe" } },
      { id: "heal", type: EVENT_TYPES.HEALING_APPLIED, combatantId: "hero", data: { amount: 5, actionName: "Healing Word", targetCombatantId: "hero" } },
      { id: "control", type: EVENT_TYPES.ACTIVE_EFFECT_CREATED, combatantId: "hero", data: { name: "Slowed", targetCombatantId: "foe" } },
      { id: "down", type: EVENT_TYPES.DAMAGE_APPLIED, combatantId: "foe", data: { amount: 9, actionName: "Arrow Shot", targetCombatantId: "hero", targetHpAfter: 0 } }
    ],
    computed: { dpr: { byCombatant: [{ id: "hero", name: "Hero", side: SIDES.FRIENDLY, damageAppliedNet: 12, netDPR: 6 }] } }
  });

  assert.equal(result[0].img, "hero.webp");
  assert.equal(result[0].damageAppliedNet, 12);
  assert.equal(result[0].netDPR, 6);
  assert.equal(result[0].healing, 5);
  assert.equal(result[0].martial, 1);
  assert.equal(result[0].magic, 1);
  assert.equal(result[0].control, 1);
  assert.equal(result[0].downed, 1);
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
      { id: "hit", type: EVENT_TYPES.DAMAGE_APPLIED, combatantId: "hero", data: { amount: 12, actionName: "Longsword Slash", targetCombatantId: "foe" } },
      { id: "spell", type: EVENT_TYPES.DAMAGE_APPLIED, combatantId: "hero", data: { amount: 10, actionName: "Fireball", targetCombatantId: "foe" } },
      { id: "heal", type: EVENT_TYPES.HEALING_APPLIED, combatantId: "hero", data: { amount: 5, actionName: "Healing Word", targetCombatantId: "hero" } },
      { id: "control", type: EVENT_TYPES.ACTIVE_EFFECT_CREATED, combatantId: "hero", data: { name: "Slowed", targetCombatantId: "foe" } },
      { id: "down", type: EVENT_TYPES.DAMAGE_APPLIED, combatantId: "foe", data: { amount: 9, actionName: "Arrow Shot", targetCombatantId: "hero", targetHpAfter: 0 } }
    ],
    computed: {
      dpr: {
        byCombatant: [
          { id: "hero", name: "Hero", side: SIDES.FRIENDLY, damageAppliedNet: 22, netDPR: 11 },
          { id: "foe", name: "Foe", side: SIDES.HOSTILE, damageAppliedNet: 9, netDPR: 4.5 }
        ],
        bySide: [
          { id: SIDES.FRIENDLY, name: SIDES.FRIENDLY, damageAppliedNet: 22, damageRolled: 0, damageAppliedGross: 22, netDPR: 11 },
          { id: SIDES.HOSTILE, name: SIDES.HOSTILE, damageAppliedNet: 9, damageRolled: 0, damageAppliedGross: 9, netDPR: 4.5 }
        ]
      }
    }
  });

  assert.equal(result.contributionRows[0].name, "Hero");
  assert.equal(result.contributionRows[0].damagePercent, 100);
  assert.equal(result.totals.healing, 5);
  assert.equal(result.totals.control, 1);
  assert.equal(result.totals.downed, 1);
  assert.equal(result.disciplineRows.find((row) => row.id === "magic")?.value, 1);
  assert.equal(result.disciplineRows.find((row) => row.id === "damage")?.percent, 100);
  assert.ok((result.disciplineRows.find((row) => row.id === "healing")?.percent ?? 0) < 100);
  assert.equal(result.topActions[0].name, "Longsword Slash");
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
  assert.equal(result.connectorArrow, "-->");
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

test("open combat log windows schedule a live render for matching log updates", async () => {
  let renders = 0;
  const app = new CombatLogApp({ persistence: {}, listActiveLogs: () => [] }, "current");
  app.element = { isConnected: true };
  app.render = async () => { renders += 1; };

  assert.equal(hookCallbacks.has(HOOKS.LOG_UPDATED), true);
  hookCallbacks.get(HOOKS.LOG_UPDATED)({ id: "other" });
  hookCallbacks.get(HOOKS.LOG_UPDATED)({ id: "current" });
  hookCallbacks.get(HOOKS.LOG_UPDATED)({ id: "current" });
  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.equal(renders, 1);
  await app.close();
  assert.equal(hookCallbacks.has(HOOKS.LOG_UPDATED), false);
});
