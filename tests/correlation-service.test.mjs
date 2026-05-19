import assert from "node:assert/strict";
import { test } from "node:test";
import { CONFIDENCE, EVENT_TYPES } from "../scripts/constants.js";
import { CorrelationService } from "../scripts/services/correlation-service.js";

const now = "2026-05-17T10:00:00.000Z";

test("resource deltas correlate to chat roll targets with different source actor", () => {
  const service = new CorrelationService({ windowMs: 3000 });
  const log = {
    events: [{
      id: "roll-1",
      type: EVENT_TYPES.ROLL_DAMAGE,
      createdAt: now,
      actorUuid: "Actor.attacker",
      data: { targetActorUuids: ["Actor.defender"] }
    }]
  };

  const result = service.correlateResourceDelta(log, {
    createdAt: "2026-05-17T10:00:01.000Z",
    actorUuid: "Actor.defender"
  });

  assert.equal(result.status, "correlated");
  assert.equal(result.rollEventId, "roll-1");
  assert.equal(result.confidence, CONFIDENCE.PROBABLE);
});

test("targetless damage rolls correlate by amount to another actor hp delta", () => {
  const service = new CorrelationService({ windowMs: 3000 });
  const log = {
    events: [{
      id: "roll-amount",
      type: EVENT_TYPES.ROLL_DAMAGE,
      createdAt: now,
      actorUuid: "Actor.attacker",
      data: { total: 12 }
    }]
  };

  const result = service.correlateResourceDelta(log, {
    createdAt: "2026-05-17T10:00:01.000Z",
    actorUuid: "Actor.defender",
    data: { delta: -12 }
  });

  assert.equal(result.status, "correlated");
  assert.equal(result.rollEventId, "roll-amount");
});

test("multiple nearby targetless rolls prefer the matching amount", () => {
  const service = new CorrelationService({ windowMs: 3000 });
  const log = {
    events: [
      { id: "roll-5", type: EVENT_TYPES.ROLL_DAMAGE, createdAt: now, actorUuid: "Actor.attacker", data: { total: 5 } },
      { id: "roll-12", type: EVENT_TYPES.ROLL_DAMAGE, createdAt: now, actorUuid: "Actor.attacker", data: { total: 12 } }
    ]
  };

  const result = service.correlateResourceDelta(log, {
    createdAt: "2026-05-17T10:00:01.000Z",
    actorUuid: "Actor.defender",
    data: { delta: -12 }
  });

  assert.equal(result.status, "correlated");
  assert.equal(result.rollEventId, "roll-12");
});
