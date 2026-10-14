import assert from "node:assert/strict";
import { test } from "node:test";
import { CONFIDENCE, EVENT_TYPES, RESOURCE_INTERPRETATIONS } from "../scripts/constants.js";
import { CorrelationService } from "../scripts/services/correlation-service.js";

const now = "2026-05-17T10:00:00.000Z";
const later = "2026-05-17T10:00:01.000Z";

function roll(id, data = {}, overrides = {}) {
  return { id, type: EVENT_TYPES.ROLL_DAMAGE, createdAt: now, combatantId: "hero", actorUuid: "Actor.hero", source: { id: `message-${id}` }, data, ...overrides };
}

function damageDelta(delta, overrides = {}) {
  return { id: "delta", createdAt: later, combatantId: "foe", actorUuid: "Actor.foe", data: { delta, interpretedAs: RESOURCE_INTERPRETATIONS.DAMAGE, targetCombatantId: "foe", ...overrides } };
}

test("a targeted damage roll explains the hit point change of its target", () => {
  const service = new CorrelationService({ windowMs: 3000 });
  const log = { events: [roll("r1", { total: 9, targetCombatantIds: ["foe"] })] };

  const result = service.correlateResourceDelta(log, damageDelta(-9));

  assert.equal(result.status, "correlated");
  assert.equal(result.rollEventId, "r1");
  assert.equal(result.messageId, "message-r1");
  assert.equal(result.confidence, CONFIDENCE.PROBABLE);
});

test("targetless damage rolls correlate by amount", () => {
  const service = new CorrelationService({ windowMs: 3000 });
  const log = { events: [roll("r5", { total: 5 }), roll("r12", { total: 12 })] };

  const result = service.correlateResourceDelta(log, damageDelta(-12));

  assert.equal(result.status, "correlated");
  assert.equal(result.rollEventId, "r12");
});

test("multi part damage of one message is compared as one total", () => {
  const service = new CorrelationService({ windowMs: 3000 });
  const log = { events: [
    roll("slash", { total: 7, targetCombatantIds: ["foe"] }, { source: { id: "message-1" } }),
    roll("fire", { total: 4, targetCombatantIds: ["foe"] }, { source: { id: "message-1" } })
  ] };

  const result = service.correlateResourceDelta(log, damageDelta(-11));

  assert.equal(result.status, "correlated");
  assert.equal(result.rollEventId, "slash");
});

test("a killing blow that removes less than was rolled still matches its targeted roll", () => {
  const service = new CorrelationService({ windowMs: 3000 });
  const log = { events: [roll("r1", { total: 14, targetCombatantIds: ["foe"] })] };

  const result = service.correlateResourceDelta(log, damageDelta(-3, { oldValue: 3, newValue: 0 }));

  assert.equal(result.status, "correlated");
  assert.equal(result.rollEventId, "r1");
});

test("healing changes never match damage rolls", () => {
  const service = new CorrelationService({ windowMs: 3000 });
  const log = { events: [roll("r4", { total: 4 })] };

  const result = service.correlateResourceDelta(log, { id: "heal", createdAt: later, combatantId: "hero", data: { delta: 4, interpretedAs: RESOURCE_INTERPRETATIONS.HEALING, targetCombatantId: "hero" } });

  assert.equal(result.status, "uncorrelated");
});

test("a combatant does not become the source of damage to itself through its own untargeted roll", () => {
  const service = new CorrelationService({ windowMs: 3000 });
  const log = { events: [roll("own", { total: 6 }, { combatantId: "foe", actorUuid: "Actor.foe" })] };

  const result = service.correlateResourceDelta(log, damageDelta(-6));

  assert.equal(result.status, "uncorrelated");
});

test("two equally good rolls stay ambiguous for the GM", () => {
  const service = new CorrelationService({ windowMs: 3000 });
  const log = { events: [roll("a", { total: 8 }), roll("b", { total: 8 }, { combatantId: "ally" })] };

  const result = service.correlateResourceDelta(log, damageDelta(-8));

  assert.equal(result.status, "ambiguous");
  assert.deepEqual(result.candidateRollEventIds.sort(), ["a", "b"]);
});

test("a capped amount without targets is only a suggestion", () => {
  const service = new CorrelationService({ windowMs: 3000 });
  const log = { events: [roll("big", { total: 20 })] };

  const result = service.correlateResourceDelta(log, damageDelta(-5, { oldValue: 5, newValue: 0 }));

  assert.equal(result.status, "correlated");
  assert.equal(result.confidence, CONFIDENCE.UNCLEAR);
});

test("rolls outside the time window are ignored", () => {
  const service = new CorrelationService({ windowMs: 500 });
  const log = { events: [roll("old", { total: 9, targetCombatantIds: ["foe"] })] };

  const result = service.correlateResourceDelta(log, damageDelta(-9));

  assert.equal(result.status, "uncorrelated");
});

test("a roll that already explained a change of its target does not explain a later change of that target", () => {
  const service = new CorrelationService({ windowMs: 60000 });
  const applied = { ...damageDelta(-9), id: "first", type: EVENT_TYPES.RESOURCE_DELTA, data: { ...damageDelta(-9).data, updateId: "u1", correlation: { status: "system", messageId: "message-r1", rollEventId: "r1" } } };
  const log = { events: [roll("r1", { total: 9, targetCombatantIds: ["foe"] }), applied] };

  const gmEdit = damageDelta(-2, { updateId: "u2" });
  assert.equal(service.correlateResourceDelta(log, gmEdit).status, "uncorrelated");

  const otherTarget = { ...damageDelta(-9, { updateId: "u3", targetCombatantId: "foe2" }), combatantId: "foe2" };
  log.events[0].data.targetCombatantIds.push("foe2");
  assert.equal(service.correlateResourceDelta(log, otherTarget).rollEventId, "r1");
});

test("temporary and regular hit points of one update share their roll", () => {
  const service = new CorrelationService({ windowMs: 60000 });
  const tempPart = { ...damageDelta(-3), id: "temp", type: EVENT_TYPES.RESOURCE_DELTA, data: { ...damageDelta(-3).data, updateId: "u1", correlation: { status: "correlated", messageId: "message-r1", rollEventId: "r1" } } };
  const log = { events: [roll("r1", { total: 9, targetCombatantIds: ["foe"] }), tempPart] };

  const result = service.correlateResourceDelta(log, damageDelta(-6, { updateId: "u1" }));

  assert.equal(result.status, "correlated");
  assert.equal(result.rollEventId, "r1");
});

test("a roll already applied to its own target does not explain a matching change of somebody else", () => {
  const service = new CorrelationService({ windowMs: 60000 });
  const applied = { id: "applied", type: EVENT_TYPES.RESOURCE_DELTA, createdAt: now, combatantId: "hero", data: { delta: -5, interpretedAs: RESOURCE_INTERPRETATIONS.DAMAGE, targetCombatantId: "wizard", correlation: { status: "system", messageId: "message-r1", rollEventId: "r1" } } };
  const log = { events: [roll("r1", { total: 4, targetCombatantIds: ["wizard"] }), applied] };

  const result = service.correlateResourceDelta(log, damageDelta(-4, { targetCombatantId: "orc" }));

  assert.equal(result.status, "uncorrelated");
});

test("an applied area roll still explains the change of another of its targets", () => {
  const service = new CorrelationService({ windowMs: 60000 });
  const applied = { id: "applied", type: EVENT_TYPES.RESOURCE_DELTA, createdAt: now, combatantId: "hero", data: { delta: -8, interpretedAs: RESOURCE_INTERPRETATIONS.DAMAGE, targetCombatantId: "orc1", correlation: { status: "system", messageId: "message-r1", rollEventId: "r1" } } };
  const log = { events: [roll("r1", { total: 8, targetCombatantIds: ["orc1", "foe"] }), applied] };

  const result = service.correlateResourceDelta(log, damageDelta(-8));

  assert.equal(result.status, "correlated");
  assert.equal(result.rollEventId, "r1");
});

test("an applied roll without targets may still explain another change", () => {
  const service = new CorrelationService({ windowMs: 60000 });
  const applied = { id: "applied", type: EVENT_TYPES.RESOURCE_DELTA, createdAt: now, combatantId: "hero", data: { delta: -6, interpretedAs: RESOURCE_INTERPRETATIONS.DAMAGE, targetCombatantId: "orc1", correlation: { status: "correlated", messageId: "message-r1", rollEventId: "r1" } } };
  const log = { events: [roll("r1", { total: 6 }), applied] };

  const result = service.correlateResourceDelta(log, damageDelta(-6));

  assert.equal(result.status, "correlated");
});
