import { CONFIDENCE, EVENT_TYPES, RESOURCE_INTERPRETATIONS } from "../constants.js";

// Fallback attribution for hit point changes that no system hook explained: find the damage or healing
// roll that most likely caused the change. Rolls are grouped per chat message, so multi part damage
// (for example slashing plus fire) is compared as one total.
export class CorrelationService {
  constructor({ windowMs = 60000 } = {}) {
    this.windowMs = windowMs;
  }

  correlateResourceDelta(log, deltaEvent) {
    const interpretation = deltaEvent?.data?.interpretedAs;
    const rollType = interpretation === RESOURCE_INTERPRETATIONS.DAMAGE ? EVENT_TYPES.ROLL_DAMAGE
      : interpretation === RESOURCE_INTERPRETATIONS.HEALING ? EVENT_TYPES.ROLL_HEALING
        : null;
    if (!rollType) return uncorrelated("Only damage and healing are matched to rolls.");

    const created = new Date(deltaEvent.createdAt).getTime();
    const { used, appliedElsewhere } = usedRolls(log, deltaEvent);
    const groups = rollGroups(log, rollType, created, this.windowMs, deltaEvent.id)
      .filter((group) => !used.has(group.messageId) && !used.has(group.firstEventId))
      // A roll aimed at other targets that was already applied to one of them is spent: a matching change of
      // somebody else (a GM edit, regeneration) is a coincidence of numbers.
      .filter((group) => !(hasTargets(group) && !isTargeted(group, deltaEvent) && (appliedElsewhere.has(group.messageId) || appliedElsewhere.has(group.firstEventId))));
    const candidates = groups
      .map((group) => ({ group, score: correlationScore(group, deltaEvent, interpretation) }))
      .filter((candidate) => candidate.score !== null);
    if (!candidates.length) return uncorrelated("No nearby roll matched this hit point change.");

    const bestScore = Math.max(...candidates.map((candidate) => candidate.score));
    const best = candidates.filter((candidate) => candidate.score === bestScore);
    // Weak evidence (only a capped amount) needs a single candidate.
    if (best.length > 1 || (bestScore < 2 && candidates.length > 1)) {
      return {
        status: "ambiguous",
        rollEventId: null,
        candidateRollEventIds: best.map((candidate) => candidate.group.firstEventId),
        confidence: CONFIDENCE.UNCLEAR,
        reason: "Several nearby rolls could explain this hit point change."
      };
    }
    const group = best[0].group;
    return {
      status: "correlated",
      rollEventId: group.firstEventId,
      messageId: group.messageId,
      candidateRollEventIds: [group.firstEventId],
      // A capped amount without targets is only a suggestion for the GM, not an attribution.
      confidence: bestScore >= 2 ? CONFIDENCE.PROBABLE : CONFIDENCE.UNCLEAR,
      reason: "One nearby roll matched this hit point change."
    };
  }
}

function uncorrelated(reason) {
  return { status: "uncorrelated", rollEventId: null, candidateRollEventIds: [], confidence: CONFIDENCE.UNCLEAR, reason };
}

// A roll explains the hit point change of a target once. A later change of the same target, such as a GM
// edit or regeneration, must not be credited to a roll that was already applied. Temporary and regular
// hit points that change in the same update share their roll.
// Rolls applied to other targets are collected apart (appliedElsewhere): an area roll may still hit this target.
function usedRolls(log, deltaEvent) {
  const used = new Set();
  const appliedElsewhere = new Set();
  const target = targetKey(deltaEvent);
  if (!target) return { used, appliedElsewhere };
  for (const event of log?.events ?? []) {
    if (event.id === deltaEvent.id || event.type !== EVENT_TYPES.RESOURCE_DELTA || event.ignored) continue;
    if (deltaEvent.data?.updateId && event.data?.updateId === deltaEvent.data.updateId) continue;
    const correlation = event.data?.correlation;
    if (!correlation || correlation.status === "ambiguous" || correlation.status === "uncorrelated") continue;
    const into = targetKey(event) === target ? used : appliedElsewhere;
    if (correlation.messageId) into.add(String(correlation.messageId));
    if (correlation.rollEventId) into.add(String(correlation.rollEventId));
  }
  return { used, appliedElsewhere };
}

function targetKey(event) {
  return event?.data?.targetCombatantId || event?.data?.targetActorUuid || "";
}

function rollGroups(log, rollType, created, windowMs, excludeId) {
  const groups = new Map();
  for (const event of log?.events ?? []) {
    if (event.id === excludeId || event.type !== rollType || event.ignored) continue;
    const time = new Date(event.createdAt).getTime();
    if (!Number.isFinite(time) || !Number.isFinite(created) || Math.abs(created - time) > windowMs) continue;
    const key = String(event.source?.id || event.id);
    const group = groups.get(key) ?? {
      messageId: event.source?.id ?? "",
      firstEventId: event.id,
      combatantId: event.combatantId ?? "",
      actorUuid: event.actorUuid ?? "",
      tokenUuid: event.tokenUuid ?? "",
      total: 0,
      targetCombatantIds: new Set(),
      targetActorUuids: new Set(),
      targetTokenUuids: new Set()
    };
    group.total += Math.abs(Number(event.data?.total ?? event.data?.amount ?? 0)) || 0;
    for (const id of event.data?.targetCombatantIds ?? []) group.targetCombatantIds.add(id);
    for (const uuid of event.data?.targetActorUuids ?? []) group.targetActorUuids.add(uuid);
    for (const uuid of event.data?.targetTokenUuids ?? []) group.targetTokenUuids.add(uuid);
    groups.set(key, group);
  }
  return Array.from(groups.values());
}

function hasTargets(group) {
  return group.targetCombatantIds.size > 0 || group.targetActorUuids.size > 0 || group.targetTokenUuids.size > 0;
}

function isTargeted(group, deltaEvent) {
  const targetId = deltaEvent.data?.targetCombatantId || deltaEvent.combatantId || "";
  return Boolean((targetId && group.targetCombatantIds.has(targetId))
    || (deltaEvent.tokenUuid && group.targetTokenUuids.has(deltaEvent.tokenUuid))
    || (deltaEvent.actorUuid && group.targetActorUuids.has(deltaEvent.actorUuid)));
}

function correlationScore(group, deltaEvent, interpretation) {
  const amount = Math.abs(Number(deltaEvent?.data?.delta ?? deltaEvent?.data?.amount ?? 0)) || 0;
  if (!amount || !group.total) return null;
  const targetId = deltaEvent.data?.targetCombatantId || deltaEvent.combatantId || "";
  const targeted = isTargeted(group, deltaEvent);
  const sameCombatant = Boolean(targetId && group.combatantId && targetId === group.combatantId);
  // Nobody damages themselves by accident; self healing is common.
  if (interpretation === RESOURCE_INTERPRETATIONS.DAMAGE && sameCombatant && !targeted) return null;

  const exact = group.total === amount;
  // Damage stops at 0 hit points, so a killing blow removes less than was rolled.
  const capped = interpretation === RESOURCE_INTERPRETATIONS.DAMAGE
    ? Number(deltaEvent.data?.newValue) === 0 && group.total > amount
    : group.total > amount;
  if (targeted && exact) return 5;
  if (targeted && capped) return 4;
  if (targeted) return 3;
  if (exact) return 2;
  if (capped) return 1;
  return null;
}
