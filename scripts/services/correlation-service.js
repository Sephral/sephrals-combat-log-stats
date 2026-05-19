import { CONFIDENCE } from "../constants.js";

export class CorrelationService {
  constructor({ windowMs = 60000 } = {}) {
    this.windowMs = windowMs;
  }

  correlateResourceDelta(log, deltaEvent) {
    const created = new Date(deltaEvent.createdAt).getTime();
    const candidates = (log.events ?? []).map((event) => {
      if (!event.type?.startsWith("roll.")) return false;
      const eventTime = new Date(event.createdAt).getTime();
      if (!Number.isFinite(eventTime) || Math.abs(created - eventTime) > this.windowMs) return false;
      const score = correlationScore(event, deltaEvent);
      return score === null ? false : { event, score };
    }).filter(Boolean);

    if (!candidates.length) return { status: "uncorrelated", rollEventId: null, candidateRollEventIds: [], confidence: CONFIDENCE.UNCLEAR, reason: "No nearby roll event matched this resource delta." };
    const bestScore = Math.max(...candidates.map((candidate) => candidate.score));
    const bestCandidates = candidates.filter((candidate) => candidate.score === bestScore);
    if (bestCandidates.length > 1) return { status: "ambiguous", rollEventId: null, candidateRollEventIds: bestCandidates.map((candidate) => candidate.event.id), confidence: CONFIDENCE.UNCLEAR, reason: "Multiple nearby roll events could explain this resource delta." };
    return { status: "correlated", rollEventId: bestCandidates[0].event.id, candidateRollEventIds: [bestCandidates[0].event.id], confidence: CONFIDENCE.PROBABLE, reason: "One nearby roll event matched this resource delta." };
  }
}

function correlationScore(event, deltaEvent) {
  const explicitActorTarget = deltaEvent.actorUuid && event.data?.targetActorUuids?.includes(deltaEvent.actorUuid);
  const explicitTokenTarget = deltaEvent.tokenUuid && event.data?.targetTokenUuids?.includes(deltaEvent.tokenUuid);
  const matchingAmount = rollAmount(event) > 0 && rollAmount(event) === deltaAmount(deltaEvent);
  if (explicitActorTarget || explicitTokenTarget) return matchingAmount ? 4 : 3;
  if (matchingAmount && event.actorUuid && deltaEvent.actorUuid && event.actorUuid !== deltaEvent.actorUuid) return 2;
  if (matchingAmount) return 1;
  if (deltaEvent.actorUuid && event.actorUuid && deltaEvent.actorUuid === event.actorUuid) return 0;
  return null;
}

function rollAmount(event) {
  return Math.abs(Number(event?.data?.total ?? event?.data?.amount ?? 0)) || 0;
}

function deltaAmount(event) {
  return Math.abs(Number(event?.data?.delta ?? event?.data?.amount ?? event?.data?.total ?? 0)) || 0;
}
