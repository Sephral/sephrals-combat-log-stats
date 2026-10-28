import { CONFIDENCE, EVENT_TYPES, GM_TABS, SETTINGS, SHARE_MODES, SIDES, TABS } from "../constants.js";
import { getSetting } from "../settings.js";
import { isGM, localize } from "../utils.js";
import { CombatStatsService } from "./stats-service.js";
import {
  ACTION_DETAIL_MODES, enemyNamesHidden, enemyStatsShared, involvesHidden, isBookkeepingEvent, isPrivateEvent, participantDirectory
} from "./player-report-service.js";

// The log window for players: the same window, read only, showing a copy of each log with the privacy choices the
// GM made for that combat in the Sharing tab (or the module defaults). The privacy rules are those of the player
// reports (player-report-service.js), so the window and the reports name and leave out the same things.

export const SHAREABLE_MODES = Object.freeze([SHARE_MODES.SUMMARY_ONLY, SHARE_MODES.PARTY_DPR_ONLY, SHARE_MODES.FULL_VISIBLE_DPR, SHARE_MODES.FULL_VISIBLE_RECAP, SHARE_MODES.PUBLIC_REPORT]);

const UNKNOWN_IMAGE = "icons/svg/mystery-man.svg";

// Changes the GM made to the numbers. They count, because the GM made them to get the numbers right, although they
// are stored with GM visibility. Applied damage and healing from a whispered card changed hit points every player
// sees on the token, so it counts too, without the name of the action.
const COUNTED_DESPITE_WHISPER = new Set([
  EVENT_TYPES.DAMAGE_APPLIED,
  EVENT_TYPES.HEALING_APPLIED,
  EVENT_TYPES.DAMAGE_CORRECTED_UP,
  EVENT_TYPES.DAMAGE_CORRECTED_DOWN,
  EVENT_TYPES.DAMAGE_MANUAL_ADDED,
  EVENT_TYPES.DAMAGE_MANUAL_REDUCED,
  EVENT_TYPES.HEALING_CORRECTED_UP,
  EVENT_TYPES.HEALING_CORRECTED_DOWN,
  EVENT_TYPES.HEALING_MANUAL_ADDED,
  EVENT_TYPES.HEALING_MANUAL_REDUCED
]);

// Event data players never get: GM notes, names typed or read from chat cards (they may name a hidden or
// anonymized enemy), and the candidates of a change the GM still has to settle.
const PRIVATE_DATA_KEYS = ["note", "notes", "targetName", "targetNames", "speakerAlias", "plannedCandidates"];
const ACTION_NAME_KEYS = ["actionName", "itemName", "spellName"];

// Only GMs change logs. Players read them, when the GM lets them.
export function canWriteCombatLogs() {
  return isGM();
}

export function canViewCombatLogs() {
  return isGM() || getSetting(SETTINGS.PLAYER_STATS_ACCESS, true) !== false;
}

// The report detail of a combat: the saved one, else the default from the settings, else the full recap. The
// Sharing form preselects the same.
export function effectiveShareMode(share = {}) {
  if (SHAREABLE_MODES.includes(share?.shareMode)) return share.shareMode;
  const configured = getSetting(SETTINGS.DEFAULT_SHARE_MODE);
  return SHAREABLE_MODES.includes(configured) ? configured : SHARE_MODES.FULL_VISIBLE_RECAP;
}

// The sharing choices of a combat as the player view applies them. Saved choices win; a log without them follows
// the module defaults. Private rolls, GM notes, unclear entries and corrections are never part of it.
export function playerShareSettings(log) {
  const share = log?.shareSettings ?? {};
  const anonymizeEnemies = typeof share.anonymizeEnemies === "boolean" ? share.anonymizeEnemies : getSetting(SETTINGS.DEFAULT_ANONYMIZE_ENEMIES, true) !== false;
  const settings = {
    shareMode: effectiveShareMode(share),
    anonymizeEnemies,
    includeNpcNames: typeof share.anonymizeEnemies === "boolean" ? share.includeNpcNames === true : !anonymizeEnemies,
    includeEnemyStats: Boolean(share.includeEnemyStats),
    includeHiddenCombatants: Boolean(share.includeHiddenCombatants),
    includePrivateRolls: false,
    includeGMNotes: false,
    includeUnclearEvents: false,
    includeCorrections: false
  };
  return {
    ...settings,
    enemyStats: enemyStatsShared(settings),
    hideEnemyNames: enemyNamesHidden(settings),
    // The Round Log tells single actions, like the report sections that need the full recap.
    roundLog: ACTION_DETAIL_MODES.has(settings.shareMode)
  };
}

// Tabs a player may open. The Round Log follows the report detail of the combat (see playerShareSettings).
export function playerTabs({ roundLog = true } = {}) {
  return TABS.filter((id) => !GM_TABS.includes(id) && (roundLog || id !== "timeline"));
}

// A copy of the log with only what players may see, and its numbers computed from that copy. The original stays
// untouched. Returns null without a log.
export function playerViewLog(log, { statsOptions = {}, share = playerShareSettings(log) } = {}) {
  if (!log) return null;
  const { participants: directory, hiddenIds } = participantDirectory(log, share);
  const participants = (log.participants ?? [])
    .filter((participant) => directory.has(String(participant?.combatantId ?? "")))
    .map((participant) => publicParticipant(participant, directory.get(String(participant.combatantId)), share));
  const events = playerEvents(log, hiddenIds);
  const view = {
    id: log.id,
    title: log.title,
    status: log.status,
    systemId: log.systemId,
    createdAt: log.createdAt,
    startedAt: log.startedAt,
    endedAt: log.endedAt,
    lastSeenAt: log.lastSeenAt,
    sessionSegments: (log.sessionSegments ?? []).map((segment) => ({ startedAt: segment?.startedAt ?? null, endedAt: segment?.endedAt ?? null })),
    participants,
    events,
    shareSettings: {},
    playerView: { enemyStats: share.enemyStats, roundLog: share.roundLog, hideEnemyNames: share.hideEnemyNames }
  };
  const computed = CombatStatsService.compute(view, statsOptions);
  view.computed = share.enemyStats ? computed : withoutEnemyStats(computed);
  // GM hints (unclear changes left out, manual changes, open action cards) are no business of the players.
  view.computed.warningCounts = {};
  view.computed.warningCodes = [];
  return view;
}

// One row of the History tab for players: the numbers of the player view of that log. Only these fields reach the
// page; the index entry itself may carry the whole stored log (inline storage on v13).
// netDamageApplied is the party's damage here, so every row means the same whatever each fight shares.
export function playerHistoryEntry(entry, log, options = {}) {
  const view = log ? playerViewLog(log, options) : null;
  const base = {
    combatLogId: entry?.combatLogId ?? view?.id ?? "",
    title: view?.title ?? entry?.title ?? entry?.combatLogId ?? "",
    status: view?.status ?? entry?.status,
    startedAt: view?.startedAt ?? entry?.startedAt ?? null,
    endedAt: view?.endedAt ?? entry?.endedAt ?? null,
    lastSeenAt: view?.lastSeenAt ?? entry?.lastSeenAt ?? null
  };
  if (!view) return { ...base, rounds: entry?.rounds ?? "-", participantCount: "-", netDamageApplied: "-", partyDPR: "-", loaded: false };
  const party = (view.computed?.bySide ?? []).find((row) => row.id === SIDES.FRIENDLY) ?? {};
  return {
    ...base,
    rounds: view.computed?.summary?.rounds ?? entry?.rounds ?? 0,
    participantCount: view.participants.length,
    netDamageApplied: Number(party.damageAppliedNet) || 0,
    partyDPR: view.computed?.dpr?.partyDPR ?? 0,
    loaded: true
  };
}

function publicParticipant(participant, visible, share) {
  const anonymized = visible.side === SIDES.HOSTILE && share.hideEnemyNames;
  return {
    combatantId: String(participant.combatantId),
    name: visible.name || localize("SCLS.Report.Fallback.Someone"),
    // A portrait would give an anonymized enemy away.
    img: anonymized ? UNKNOWN_IMAGE : (participant.img || UNKNOWN_IMAGE),
    side: visible.side,
    // The Sessions tab finds party members of different fights by their actor. Enemies keep theirs to themselves.
    actorUuid: visible.side === SIDES.FRIENDLY ? String(participant.actorUuid ?? "") : "",
    hidden: Boolean(participant.hidden),
    initiative: participant.initiative ?? null,
    isPlayerOwned: Boolean(participant.isPlayerOwned)
  };
}

// Events players may see: no GM bookkeeping, nothing about hidden combatants the GM keeps back, no whispered
// rolls or cards, no unclear hit point changes and nothing the GM ignored. Corrections and manual changes count.
function playerEvents(log, hiddenIds) {
  const all = (log?.events ?? []).filter(Boolean);
  // Whispered rolls and cards; an action named after one of them stays unnamed.
  const privateIds = new Set(all.filter((event) => isPrivateEvent(event) && !COUNTED_DESPITE_WHISPER.has(event.type)).map((event) => String(event.id ?? "")).filter(Boolean));
  const events = [];
  for (const event of all) {
    if (event.ignored || isBookkeepingEvent(event)) continue;
    if (involvesHidden(event, hiddenIds)) continue;
    // Attack rolls of the generic adapter are filed as unclear; they only add critical hits and fumbles (see stats).
    if (event.confidence === CONFIDENCE.UNCLEAR && event.type !== EVENT_TYPES.ROLL_ATTACK) continue;
    const whispered = isPrivateEvent(event);
    if (whispered && !COUNTED_DESPITE_WHISPER.has(event.type)) continue;
    events.push(publicEvent(event, { hideAction: whispered || namedAfterPrivate(event, privateIds) }));
  }
  return events;
}

function namedAfterPrivate(event, privateIds) {
  if (!privateIds.size) return false;
  const correlation = event?.data?.correlation ?? {};
  return [correlation.rollEventId, correlation.actionEventId, event?.data?.rollEventId].some((id) => id && privateIds.has(String(id)));
}

function publicEvent(event, { hideAction = false } = {}) {
  const data = { ...(event.data ?? {}) };
  for (const key of PRIVATE_DATA_KEYS) delete data[key];
  if (hideAction) for (const key of ACTION_NAME_KEYS) delete data[key];
  if (Array.isArray(data.outcomes)) data.outcomes = data.outcomes.map(({ targetName: _name, ...outcome }) => outcome);
  return {
    id: event.id,
    type: event.type,
    createdAt: event.createdAt,
    sequence: event.sequence,
    round: event.round ?? null,
    turn: event.turn ?? null,
    combatantId: event.combatantId ?? "",
    visibility: event.visibility,
    source: event.source ? { kind: event.source.kind, id: event.source.id } : undefined,
    confidence: event.confidence,
    ignored: false,
    tags: Array.isArray(event.tags) ? [...event.tags] : [],
    data
  };
}

// Without enemy numbers the player view keeps the party, neutral and unknown sides. Totals become party totals,
// otherwise the difference to the party numbers would give the enemy numbers away.
function withoutEnemyStats(computed) {
  const party = computed.bySide.find((row) => row.id === SIDES.FRIENDLY) ?? {};
  const byCombatant = computed.byCombatant.filter((row) => row.side !== SIDES.HOSTILE);
  const bySide = computed.bySide.filter((row) => row.id !== SIDES.HOSTILE);
  const summary = {
    ...computed.summary,
    grossDamageRolled: Number(party.damageRolled) || 0,
    grossDamageApplied: Number(party.damageAppliedGross) || 0,
    netDamageApplied: Number(party.damageAppliedNet) || 0,
    damageCorrectionsUp: Number(party.damageCorrectionsUp) || 0,
    damageCorrectionsDown: Number(party.damageCorrectionsDown) || 0,
    grossHealingRolled: Number(party.healingRolled) || 0,
    grossHealingApplied: Number(party.healingAppliedGross) || 0,
    netHealingApplied: Number(party.healingNet) || 0,
    healingCorrectionsUp: Number(party.healingCorrectionsUp) || 0,
    healingCorrectionsDown: Number(party.healingCorrectionsDown) || 0,
    moraleDamageApplied: Number(party.moraleDamageDealt) || 0,
    moraleHealingApplied: Number(party.moraleHealing) || 0
  };
  return {
    ...computed,
    summary,
    byCombatant,
    bySide,
    dpr: { ...computed.dpr, enemyDPR: null, byCombatant, bySide },
    byRound: (computed.byRound ?? []).map((row) => ({ ...row, enemyDamage: 0, enemyHealing: 0 })),
    confidenceSummary: {}
  };
}

export const __test__ = { playerEvents, publicEvent, publicParticipant, withoutEnemyStats };
