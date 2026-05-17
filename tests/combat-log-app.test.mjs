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
