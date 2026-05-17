import { CONFIDENCE } from "../constants.js";

export class CorrelationService {
  constructor({ windowMs = 3000 } = {}) {
    this.windowMs = windowMs;
  }

  correlateResourceDelta(log, deltaEvent) {
    const created = new Date(deltaEvent.createdAt).getTime();
    const candidates = (log.events ?? []).filter((event) => {
      if (!event.type?.startsWith("roll.")) return false;
      const eventTime = new Date(event.createdAt).getTime();
      if (!Number.isFinite(eventTime) || Math.abs(created - eventTime) > this.windowMs) return false;
      if (deltaEvent.actorUuid && event.data?.targetActorUuids?.length) return event.data.targetActorUuids.includes(deltaEvent.actorUuid);
      if (deltaEvent.tokenUuid && event.data?.targetTokenUuids?.length) return event.data.targetTokenUuids.includes(deltaEvent.tokenUuid);
      if (deltaEvent.actorUuid && event.actorUuid && deltaEvent.actorUuid !== event.actorUuid) return false;
      return true;
    });

    if (!candidates.length) return { status: "uncorrelated", rollEventId: null, candidateRollEventIds: [], confidence: CONFIDENCE.UNCLEAR, reason: "No nearby roll event matched this resource delta." };
    if (candidates.length > 1) return { status: "ambiguous", rollEventId: null, candidateRollEventIds: candidates.map((event) => event.id), confidence: CONFIDENCE.UNCLEAR, reason: "Multiple nearby roll events could explain this resource delta." };
    return { status: "correlated", rollEventId: candidates[0].id, candidateRollEventIds: [candidates[0].id], confidence: CONFIDENCE.PROBABLE, reason: "One nearby roll event matched this resource delta." };
  }
}
