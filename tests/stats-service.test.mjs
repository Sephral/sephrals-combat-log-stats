import assert from "node:assert/strict";
import { test } from "node:test";
import { CONFIDENCE, EVENT_TYPES, RESOURCE_INTERPRETATIONS } from "../scripts/constants.js";
import { CombatStatsService } from "../scripts/services/stats-service.js";

function baseLog(events) {
  return {
    participants: [{ combatantId: "c1", actorUuid: "Actor.a", name: "Hero", side: "friendly" }],
    sessionSegments: [{ startedAt: "2026-05-17T10:00:00.000Z", endedAt: "2026-05-17T10:10:00.000Z" }],
    events,
    computed: { summary: { rounds: 1 } }
  };
}

test("net damage includes applied damage and correction events", () => {
  const result = CombatStatsService.compute(baseLog([
    { type: EVENT_TYPES.DAMAGE_APPLIED, combatantId: "c1", confidence: CONFIDENCE.SAFE, data: { amount: 20 } },
    { type: EVENT_TYPES.DAMAGE_CORRECTED_DOWN, combatantId: "c1", confidence: CONFIDENCE.MANUAL, data: { amount: 8 } },
    { type: EVENT_TYPES.DAMAGE_CORRECTED_UP, combatantId: "c1", confidence: CONFIDENCE.MANUAL, data: { amount: 5 } }
  ]));

  assert.equal(result.summary.grossDamageApplied, 20);
  assert.equal(result.summary.damageCorrectionsDown, 8);
  assert.equal(result.summary.damageCorrectionsUp, 5);
  assert.equal(result.summary.netDamageApplied, 17);
  assert.equal(result.dpr.partyDPR, 17);
});

test("unclear resource deltas are excluded by default", () => {
  const result = CombatStatsService.compute(baseLog([
    { type: EVENT_TYPES.RESOURCE_DELTA, combatantId: "c1", confidence: CONFIDENCE.UNCLEAR, data: { delta: -12, interpretedAs: RESOURCE_INTERPRETATIONS.DAMAGE } }
  ]));

  assert.equal(result.summary.netDamageApplied, 0);
  assert.equal(result.summary.unclassifiedDeltas, 1);
  assert.equal(result.dpr.partyDPR, 0);
});

test("manual resource delta classification records damage taken without inventing a source", () => {
  const result = CombatStatsService.compute(baseLog([
    { type: EVENT_TYPES.RESOURCE_DELTA, combatantId: "c1", confidence: CONFIDENCE.MANUAL, data: { delta: -12, interpretedAs: RESOURCE_INTERPRETATIONS.DAMAGE } }
  ]));

  assert.equal(result.summary.grossDamageApplied, 12);
  assert.equal(result.summary.netDamageApplied, 12);
  assert.equal(result.dpr.partyDPR, 0);
  assert.equal(result.dpr.byCombatant.find((entry) => entry.id === "c1")?.damageAppliedNet, 0);
  assert.equal(result.dpr.byCombatant.find((entry) => entry.id === "c1")?.damageTakenNet, 12);
});

test("source-attributed resource delta records dealt and taken damage separately", () => {
  const result = CombatStatsService.compute({
    participants: [
      { combatantId: "hero", actorUuid: "Actor.hero", name: "Hero", side: "friendly" },
      { combatantId: "foe", actorUuid: "Actor.foe", name: "Foe", side: "hostile" }
    ],
    rounds: 4,
    sessionSegments: [{ startedAt: "2026-05-17T10:00:00.000Z", endedAt: "2026-05-17T10:10:00.000Z" }],
    events: [
      { type: EVENT_TYPES.RESOURCE_DELTA, combatantId: "hero", actorUuid: "Actor.hero", confidence: CONFIDENCE.PROBABLE, data: { delta: -58, interpretedAs: RESOURCE_INTERPRETATIONS.DAMAGE, attribution: "correlatedChatRoll", targetCombatantId: "foe", targetActorUuid: "Actor.foe" } }
    ],
    computed: { summary: { rounds: 4 } }
  });

  const hero = result.dpr.byCombatant.find((entry) => entry.id === "hero");
  const foe = result.dpr.byCombatant.find((entry) => entry.id === "foe");
  assert.equal(result.summary.netDamageApplied, 58);
  assert.equal(result.dpr.partyDPR, 14.5);
  assert.equal(result.dpr.enemyDPR, 0);
  assert.equal(hero.damageAppliedNet, 58);
  assert.equal(hero.damageTakenNet, 0);
  assert.equal(foe.damageAppliedNet, 0);
  assert.equal(foe.damageTakenNet, 58);
});

test("manual damage and healing adjustments affect net totals", () => {
  const result = CombatStatsService.compute(baseLog([
    { type: EVENT_TYPES.DAMAGE_MANUAL_ADDED, combatantId: "c1", confidence: CONFIDENCE.MANUAL, data: { amount: 15 } },
    { type: EVENT_TYPES.DAMAGE_MANUAL_REDUCED, combatantId: "c1", confidence: CONFIDENCE.MANUAL, data: { amount: 4 } },
    { type: EVENT_TYPES.HEALING_MANUAL_ADDED, combatantId: "c1", confidence: CONFIDENCE.MANUAL, data: { amount: 6 } },
    { type: EVENT_TYPES.HEALING_MANUAL_REDUCED, combatantId: "c1", confidence: CONFIDENCE.MANUAL, data: { amount: 2 } }
  ]));

  assert.equal(result.summary.grossDamageApplied, 15);
  assert.equal(result.summary.netDamageApplied, 11);
  assert.equal(result.summary.grossHealingApplied, 6);
  assert.equal(result.summary.netHealingApplied, 4);
  assert.equal(result.dpr.partyDPR, 11);
});

test("empty actor uuids do not corrupt participant side attribution", () => {
  const result = CombatStatsService.compute({
    participants: [
      { combatantId: "hero", actorUuid: "", name: "Hero", side: "friendly" },
      { combatantId: "foe", actorUuid: "", name: "Foe", side: "hostile" }
    ],
    sessionSegments: [{ startedAt: "2026-05-17T10:00:00.000Z", endedAt: "2026-05-17T10:10:00.000Z" }],
    events: [
      { type: EVENT_TYPES.COMBAT_STARTED, combatantId: "", actorUuid: "", confidence: CONFIDENCE.SAFE, data: {} },
      { type: EVENT_TYPES.DAMAGE_APPLIED, combatantId: "foe", actorUuid: "", confidence: CONFIDENCE.SAFE, data: { amount: 9 } }
    ],
    computed: { summary: { rounds: 1 } }
  });

  assert.equal(result.dpr.byCombatant.find((entry) => entry.id === "foe")?.side, "hostile");
  assert.equal(result.dpr.enemyDPR, 9);
  assert.equal(result.dpr.partyDPR, 0);
  assert.equal(result.dpr.byCombatant.some((entry) => entry.id === ""), false);
});

test("chat-attributed damage keeps source DPR and records target damage taken", () => {
  const result = CombatStatsService.compute({
    participants: [
      { combatantId: "hero", actorUuid: "Actor.hero", name: "Hero", side: "friendly" },
      { combatantId: "foe", actorUuid: "Actor.foe", name: "Foe", side: "hostile" }
    ],
    sessionSegments: [{ startedAt: "2026-05-17T10:00:00.000Z", endedAt: "2026-05-17T10:10:00.000Z" }],
    events: [
      { type: EVENT_TYPES.DAMAGE_APPLIED, combatantId: "hero", actorUuid: "Actor.hero", confidence: CONFIDENCE.PROBABLE, data: { amount: 13, targetCombatantId: "foe", targetActorUuid: "Actor.foe" } }
    ],
    computed: { summary: { rounds: 1 } }
  });

  const hero = result.dpr.byCombatant.find((entry) => entry.id === "hero");
  const foe = result.dpr.byCombatant.find((entry) => entry.id === "foe");
  assert.equal(result.dpr.partyDPR, 13);
  assert.equal(result.dpr.enemyDPR, 0);
  assert.equal(hero.damageAppliedNet, 13);
  assert.equal(foe.damageTakenNet, 13);
});

test("duplicate resource delta evidence does not double count chat-applied damage", () => {
  const result = CombatStatsService.compute({
    participants: [
      { combatantId: "hero", actorUuid: "Actor.hero", name: "Hero", side: "friendly" },
      { combatantId: "foe", actorUuid: "Actor.foe", name: "Foe", side: "hostile" }
    ],
    sessionSegments: [{ startedAt: "2026-05-17T10:00:00.000Z", endedAt: "2026-05-17T10:10:00.000Z" }],
    events: [
      { id: "chat-applied", type: EVENT_TYPES.DAMAGE_APPLIED, combatantId: "hero", actorUuid: "Actor.hero", confidence: CONFIDENCE.PROBABLE, tags: ["chat-applied"], data: { amount: 12, targetCombatantId: "foe", targetActorUuid: "Actor.foe" } },
      { id: "delta", type: EVENT_TYPES.RESOURCE_DELTA, combatantId: "hero", actorUuid: "Actor.hero", confidence: CONFIDENCE.SAFE, data: { delta: -12, interpretedAs: RESOURCE_INTERPRETATIONS.IGNORED, targetCombatantId: "foe", duplicateOfEventId: "chat-applied" } }
    ],
    computed: { summary: { rounds: 1 } }
  });

  assert.equal(result.summary.netDamageApplied, 12);
  assert.equal(result.dpr.partyDPR, 12);
  assert.equal(result.dpr.byCombatant.find((entry) => entry.id === "foe")?.damageTakenNet, 12);
});

test("round count is recomputed from ledger events instead of stale computed summary", () => {
  const result = CombatStatsService.compute({
    participants: [{ combatantId: "hero", actorUuid: "Actor.hero", name: "Hero", side: "friendly" }],
    sessionSegments: [{ startedAt: "2026-05-17T10:00:00.000Z", endedAt: "2026-05-17T10:10:00.000Z" }],
    events: [
      { type: EVENT_TYPES.DAMAGE_APPLIED, combatantId: "hero", actorUuid: "Actor.hero", round: 1, confidence: CONFIDENCE.SAFE, data: { amount: 12 } },
      { type: EVENT_TYPES.ROUND_CHANGED, round: 2, confidence: CONFIDENCE.SAFE, data: {} }
    ],
    computed: { summary: { rounds: 1 } }
  });

  assert.equal(result.summary.rounds, 2);
  assert.equal(result.dpr.partyDPR, 6);
});
