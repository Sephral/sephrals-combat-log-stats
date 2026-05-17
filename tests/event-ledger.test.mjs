import assert from "node:assert/strict";
import { test } from "node:test";
import { CONFIDENCE, EVENT_TYPES } from "../scripts/constants.js";
import { CombatEventLedger } from "../scripts/services/event-ledger.js";

globalThis.game = { user: { id: "gm" } };

test("combat lifecycle ledger events are safe, not correction candidates", () => {
  const log = { combatId: "combat1", sceneUuid: "Scene.test", events: [] };
  const ledger = new CombatEventLedger(log);
  const combat = { id: "combat1", round: 1, turn: 0, scene: { uuid: "Scene.test" } };

  ledger.combatStarted(combat);
  ledger.combatResumed(combat);

  assert.deepEqual(log.events.map((event) => event.type), [EVENT_TYPES.COMBAT_STARTED, EVENT_TYPES.COMBAT_RESUMED]);
  assert.deepEqual(log.events.map((event) => event.confidence), [CONFIDENCE.SAFE, CONFIDENCE.SAFE]);
});
