import { CONFIDENCE, EVENT_TYPES, SOURCE_KINDS } from "../constants.js";
import { createEvent } from "../models/combat-log.js";

export class CombatEventLedger {
  constructor(log) {
    this.log = log;
  }

  append(input) {
    const event = createEvent(this.log, input);
    this.log.events.push(event);
    this.log.lastSeenAt = event.createdAt;
    return event;
  }

  combatEvent(type, combat, data = {}) {
    return this.append({
      type,
      round: combat?.round ?? null,
      turn: combat?.turn ?? null,
      sceneUuid: combat?.scene?.uuid ?? this.log.sceneUuid,
      source: { kind: SOURCE_KINDS.COMBAT_UPDATE, id: combat?.id ?? this.log.combatId },
      confidence: CONFIDENCE.SAFE,
      data
    });
  }

  combatStarted(combat) {
    return this.combatEvent(EVENT_TYPES.COMBAT_STARTED, combat, { title: this.log.title });
  }

  combatResumed(combat, reason = "resumedAfterReload") {
    return this.append({
      type: EVENT_TYPES.COMBAT_RESUMED,
      round: combat?.round ?? null,
      turn: combat?.turn ?? null,
      source: { kind: SOURCE_KINDS.RESUME, id: combat?.id ?? this.log.combatId },
      confidence: CONFIDENCE.SAFE,
      data: { reason }
    });
  }
}
