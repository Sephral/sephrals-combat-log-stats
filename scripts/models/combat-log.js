import { CONFIDENCE, LOG_STATUS, MODULE_ID, SCHEMA_VERSION, SEGMENT_REASONS, SHARE_MODES, SIDES, VISIBILITY } from "../constants.js";
import { cloneData, generateId, isoNow } from "../utils.js";

export function defaultShareSettings() {
  return {
    isShared: false,
    shareMode: SHARE_MODES.GM_ONLY,
    shareStartedAt: null,
    shareUpdatedAt: null,
    sharedTabs: [],
    includePartyStats: true,
    includeEnemyStats: false,
    includeNpcNames: false,
    includeHiddenCombatants: false,
    includePrivateRolls: false,
    includeGMNotes: false,
    includeUnclearEvents: false,
    includeDPR: true,
    includeTimeline: false,
    includeCorrections: false,
    anonymizeEnemies: true,
    allowPlayersToOpenReport: false
  };
}

export function createSessionSegment(reason = SEGMENT_REASONS.UNKNOWN, now = isoNow()) {
  return { id: generateId("segment"), startedAt: now, endedAt: null, reason };
}

export function closeCurrentSegment(log, reason = SEGMENT_REASONS.UNKNOWN, now = isoNow()) {
  const current = [...(log.sessionSegments ?? [])].reverse().find((segment) => !segment.endedAt);
  if (current) {
    current.endedAt = now;
    current.endReason = reason;
  }
}

export function snapshotParticipant(combatant, adapter) {
  const actor = combatant?.actor ?? null;
  const token = combatant?.token ?? combatant?.token?.object ?? null;
  const disposition = Number(token?.disposition ?? combatant?.token?.disposition ?? 0);
  return {
    combatantId: combatant?.id ?? "",
    actorUuid: actor?.uuid ?? combatant?.actorUuid ?? "",
    tokenUuid: token?.document?.uuid ?? combatant?.token?.uuid ?? "",
    actorId: actor?.id ?? combatant?.actorId ?? "",
    tokenId: token?.id ?? combatant?.tokenId ?? "",
    name: combatant?.name ?? actor?.name ?? token?.name ?? "Unknown Combatant",
    img: combatant?.img ?? actor?.img ?? token?.texture?.src ?? "icons/svg/mystery-man.svg",
    disposition,
    isPlayerOwned: Boolean(actor?.hasPlayerOwner),
    isNpc: !actor?.hasPlayerOwner,
    initiative: combatant?.initiative ?? null,
    side: disposition > 0 ? SIDES.FRIENDLY : disposition < 0 ? SIDES.HOSTILE : SIDES.UNKNOWN,
    initialResources: actor ? adapter.snapshotResources(actor) : {},
    finalResources: null
  };
}

export function createCombatLog(combat, adapter, now = isoNow()) {
  const combatants = Array.from(combat?.combatants ?? []);
  const participants = combatants.map((combatant) => snapshotParticipant(combatant, adapter));
  const initialSnapshots = Object.fromEntries(participants.map((participant) => [participant.combatantId, cloneData(participant.initialResources)]));
  return {
    schemaVersion: SCHEMA_VERSION,
    moduleVersion: game?.modules?.get?.(MODULE_ID)?.version ?? "0.0.0",
    id: generateId("combat-log"),
    worldId: game?.world?.id ?? "unknown-world",
    systemId: game?.system?.id ?? "unknown-system",
    foundryVersion: game?.version ?? "unknown",
    combatId: combat?.id ?? "",
    combatUuid: combat?.uuid ?? "",
    sceneUuid: combat?.scene?.uuid ?? canvas?.scene?.uuid ?? "",
    title: combat?.scene?.name ? `${combat.scene.name} Combat` : "Combat Log",
    status: LOG_STATUS.ACTIVE,
    createdAt: now,
    startedAt: now,
    endedAt: null,
    lastSeenAt: now,
    sessionSegments: [createSessionSegment(SEGMENT_REASONS.COMBAT_STARTED, now)],
    participants,
    initialSnapshots,
    latestSnapshots: cloneData(initialSnapshots),
    events: [],
    manualOverrides: [],
    shareSettings: defaultShareSettings(),
    computed: null
  };
}

export function createEvent(log, input = {}) {
  return {
    id: input.id ?? generateId("event"),
    type: input.type ?? "system.warning",
    createdAt: input.createdAt ?? isoNow(),
    sequence: input.sequence ?? ((log?.events?.length ?? 0) + 1),
    round: input.round ?? null,
    turn: input.turn ?? null,
    combatantId: input.combatantId ?? "",
    actorUuid: input.actorUuid ?? "",
    tokenUuid: input.tokenUuid ?? "",
    sceneUuid: input.sceneUuid ?? log?.sceneUuid ?? "",
    userId: input.userId ?? game?.user?.id ?? "",
    visibility: input.visibility ?? VISIBILITY.GM,
    source: input.source ?? { kind: "manual", id: "" },
    confidence: input.confidence ?? CONFIDENCE.UNCLEAR,
    ignored: Boolean(input.ignored),
    tags: Array.isArray(input.tags) ? input.tags : [],
    data: input.data ?? {}
  };
}

export function normalizeCombatLog(log) {
  return {
    schemaVersion: SCHEMA_VERSION,
    moduleVersion: log?.moduleVersion ?? "0.0.0",
    id: String(log?.id ?? generateId("combat-log")),
    worldId: String(log?.worldId ?? game?.world?.id ?? "unknown-world"),
    systemId: String(log?.systemId ?? game?.system?.id ?? "unknown-system"),
    foundryVersion: String(log?.foundryVersion ?? game?.version ?? "unknown"),
    combatId: String(log?.combatId ?? ""),
    combatUuid: String(log?.combatUuid ?? ""),
    sceneUuid: String(log?.sceneUuid ?? ""),
    title: String(log?.title ?? "Combat Log"),
    status: Object.values(LOG_STATUS).includes(log?.status) ? log.status : LOG_STATUS.ORPHANED,
    createdAt: String(log?.createdAt ?? isoNow()),
    startedAt: String(log?.startedAt ?? log?.createdAt ?? isoNow()),
    endedAt: log?.endedAt ?? null,
    lastSeenAt: String(log?.lastSeenAt ?? isoNow()),
    sessionSegments: Array.isArray(log?.sessionSegments) ? log.sessionSegments : [],
    participants: Array.isArray(log?.participants) ? log.participants : [],
    initialSnapshots: log?.initialSnapshots ?? {},
    latestSnapshots: log?.latestSnapshots ?? {},
    events: Array.isArray(log?.events) ? log.events : [],
    manualOverrides: Array.isArray(log?.manualOverrides) ? log.manualOverrides : [],
    shareSettings: { ...defaultShareSettings(), ...(log?.shareSettings ?? {}) },
    computed: log?.computed ?? null
  };
}
