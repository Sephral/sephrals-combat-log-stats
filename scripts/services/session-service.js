import { EVENT_TYPES, SETTINGS, SIDES } from "../constants.js";
import { getSetting } from "../settings.js";
import { escapeHtml, format, formatDateRange, formatDuration, isGM, localize } from "../utils.js";
import { awardDetail, awardLabel, awardLine, awardTallies, computeAwards } from "./awards-service.js";
import { discordReportMessages, discordText, formatNumber, markedName } from "./player-report-service.js";
import { playerViewLog } from "./player-view-service.js";
import { CombatStatsService, dprValue } from "./stats-service.js";
import { isCrucibleLog, termKey } from "./system-terms.js";

// Game sessions: the fights of one evening at the table. Foundry knows no sessions, so they are found from the times
// the fights were played: fights less than SESSION_GAP_MS apart belong together, also past midnight. A fight that
// goes on in a later session counts for the session in which it started.
export const SESSION_GAP_MS = 6 * 60 * 60 * 1000;
export const ALL_SESSIONS = "all";

// A longer pause between two events of a fight is a break, not time in combat.
export const PAUSE_MS = 30 * 60 * 1000;

// Events that may be written long after the fight was played: shares, exports, notes, manual changes and the
// changes found when a reload picks the fight up again.
const LATE_TYPES = new Set([
  EVENT_TYPES.SHARE_CREATED, EVENT_TYPES.SHARE_UPDATED, EVENT_TYPES.SHARE_REVOKED, EVENT_TYPES.EXPORT_CREATED,
  EVENT_TYPES.GM_NOTE, EVENT_TYPES.GM_MARKER, EVENT_TYPES.SYSTEM_WARNING, EVENT_TYPES.RESOURCE_DELTA_OFFLINE,
  EVENT_TYPES.DAMAGE_MANUAL_ADDED, EVENT_TYPES.DAMAGE_MANUAL_REDUCED, EVENT_TYPES.HEALING_MANUAL_ADDED, EVENT_TYPES.HEALING_MANUAL_REDUCED
]);

// Numbers of a combatant row that add up over fights.
const MEMBER_FIELDS = ["damageAppliedNet", "damageTakenNet", "healingNet", "moraleDamageDealt", "moraleHealing", "takedowns", "downed", "crits", "fumbles", "control"];

/**
 * When a fight was played. end: the end of its first sitting, before the first pause longer than gapMs.
 * durationMs: the time in combat over all sittings, without breaks longer than PAUSE_MS.
 * @returns {{start: number, end: number, durationMs: number}|null}
 */
export function fightSpan(log, gapMs = SESSION_GAP_MS) {
  const start = timeOf(log?.startedAt) ?? timeOf(log?.createdAt);
  if (start === null) return null;
  const stamps = [log.endedAt, ...(log.events ?? []).filter((event) => event && !LATE_TYPES.has(event.type)).map((event) => event.createdAt)]
    .map(timeOf)
    .filter((stamp) => stamp !== null && stamp >= start)
    .sort((left, right) => left - right);
  let end = start;
  let last = start;
  let durationMs = 0;
  let firstSitting = true;
  for (const stamp of stamps) {
    const pause = stamp - last;
    if (pause > gapMs) firstSitting = false;
    if (pause <= PAUSE_MS) durationMs += pause;
    if (firstSitting) end = stamp;
    last = stamp;
  }
  return { start, end, durationMs };
}

/**
 * The sessions with their fights, the latest session first. A session keeps its id while its first fight stays.
 * @returns {{id: string, startedAt: string, endedAt: string, logs: object[]}[]}
 */
export function groupSessions(logs = [], { gapMs = SESSION_GAP_MS } = {}) {
  const fights = (logs ?? []).filter(Boolean).map((log) => ({ log, span: fightSpan(log, gapMs) })).filter((fight) => fight.span)
    .sort((left, right) => (left.span.start - right.span.start) || String(left.log.id).localeCompare(String(right.log.id)));
  const sessions = [];
  for (const fight of fights) {
    const current = sessions.at(-1);
    if (current && fight.span.start - current.end <= gapMs) {
      current.logs.push(fight.log);
      current.end = Math.max(current.end, fight.span.end);
      continue;
    }
    sessions.push({ id: `session-${fight.log.id}`, start: fight.span.start, end: fight.span.end, logs: [fight.log] });
  }
  return sessions.reverse().map((session) => ({
    id: session.id,
    startedAt: new Date(session.start).toISOString(),
    endedAt: new Date(session.end).toISOString(),
    logs: session.logs
  }));
}

/**
 * Several fights added up: totals of all combatants, the party against the enemies, every party member, one row per
 * fight and the awards over all of them. Each log carries its numbers (computed), a log without them is computed
 * with statsOptions. A player view without enemy numbers (player-view-service.js) has no enemy side: the summary
 * then shows enemy numbers only when every fight shares them, and its totals are the party's.
 */
export function summarizeFights(logs = [], { statsOptions = {}, gapMs = SESSION_GAP_MS } = {}) {
  const totals = { fights: 0, rounds: 0, durationMs: 0, damage: 0, healing: 0, moraleDamage: 0, enemiesDefeated: 0, partyDowned: 0, criticalHits: 0 };
  const party = sideTotals();
  const enemies = sideTotals();
  const members = new Map();
  const tallies = { rolls: new Map(), rescues: new Map() };
  const fightRows = [];
  let enemyStats = true;
  let systemId = "";
  const ordered = (logs ?? []).filter(Boolean).sort((left, right) => (timeOf(left.startedAt) ?? 0) - (timeOf(right.startedAt) ?? 0));
  for (const log of ordered) {
    const computed = computedFor(log, statsOptions);
    const summary = computed.summary ?? {};
    const rounds = Math.max(1, Number(summary.rounds) || 0);
    const method = computed.dpr?.method;
    const sides = new Map((computed.bySide ?? []).map((row) => [row.id, row]));
    const shared = sides.has(SIDES.HOSTILE);
    if (!shared) enemyStats = false;
    systemId ||= String(log.systemId ?? "");
    totals.fights += 1;
    totals.rounds += rounds;
    totals.durationMs += fightSpan(log, gapMs)?.durationMs ?? 0;
    totals.damage += number(summary.netDamageApplied);
    totals.healing += number(summary.netHealingApplied);
    totals.moraleDamage += number(summary.moraleDamageApplied);
    totals.enemiesDefeated += number(summary.enemiesDefeated);
    totals.partyDowned += number(summary.partyDowned);
    totals.criticalHits += number(summary.criticalHits);
    const partyRow = sides.get(SIDES.FRIENDLY) ?? {};
    const enemyRow = sides.get(SIDES.HOSTILE) ?? {};
    addSide(party, partyRow, method, rounds);
    if (shared) addSide(enemies, enemyRow, method, rounds);
    addMembers(members, tallies, log, computed, method, rounds);
    fightRows.push({
      id: log.id,
      title: log.title ?? "",
      status: log.status,
      startedAt: log.startedAt,
      rounds,
      partyDamage: number(partyRow.damageAppliedNet),
      enemyDamage: shared ? number(enemyRow.damageAppliedNet) : null,
      enemiesDefeated: number(summary.enemiesDefeated),
      partyDowned: number(summary.partyDowned)
    });
  }
  for (const side of [party, enemies]) side.dpr = round(side.rounds ? side.dprDamage / side.rounds : 0);
  if (!enemyStats) Object.assign(totals, { damage: party.damageDealt, healing: party.healing, moraleDamage: party.moraleDamage });
  const memberRows = Array.from(members.values())
    .map((member) => ({ ...member, netDPR: round(member.rounds ? member.dprDamage / member.rounds : 0) }))
    .sort((left, right) => (right.damageAppliedNet - left.damageAppliedNet) || (right.healingNet - left.healingNet) || left.name.localeCompare(right.name));
  const awards = computeAwards({ members: memberRows.map((member) => ({ id: member.id, name: member.name })), rows: memberRows, tallies })
    // "The lowest rolls of the fight" would be wrong for several fights.
    .map((award) => award.details?.lowRolls ? { ...award, details: { ...award.details, lowRollsKey: "SCLS.Award.Detail.unluckyLowSession" } } : award);
  return {
    ...totals,
    systemId,
    morale: isCrucibleLog(systemId),
    enemyStats,
    party,
    enemies,
    members: memberRows,
    fightRows,
    awards
  };
}

/** One row per session, the latest first, from the fight rows of a summary over these sessions. */
export function sessionRows(summary, sessions = []) {
  const sessionOf = new Map(sessions.flatMap((session) => session.logs.map((log) => [log.id, session.id])));
  const rows = new Map(sessions.map((session) => [session.id, {
    id: session.id,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    fights: 0,
    rounds: 0,
    partyDamage: 0,
    enemyDamage: summary.enemyStats ? 0 : null,
    enemiesDefeated: 0,
    partyDowned: 0
  }]));
  for (const fight of summary.fightRows ?? []) {
    const row = rows.get(sessionOf.get(fight.id));
    if (!row) continue;
    row.fights += 1;
    row.rounds += fight.rounds;
    row.partyDamage += fight.partyDamage;
    if (row.enemyDamage !== null) row.enemyDamage += fight.enemyDamage ?? 0;
    row.enemiesDefeated += fight.enemiesDefeated;
    row.partyDowned += fight.partyDowned;
  }
  return Array.from(rows.values()).filter((row) => row.fights > 0);
}

// The same character in every fight: world actors by their id, tokens without an actor of their own by name.
export function memberKey(participant) {
  const uuid = String(participant?.actorUuid ?? "");
  if (/^Actor\.[^.]+$/.test(uuid)) return uuid;
  return `name:${String(participant?.name ?? "").trim().toLowerCase()}`;
}

/**
 * A session as a report for chat and Discord. Built from player views, it tells only what players may see of each
 * fight. sessions: the rows of sessionRows, listed instead of the fights when the report covers several sessions.
 * markNames: names in bold for Discord.
 */
export function sessionReport(summary, { title = "", sessions = null, markNames = false } = {}) {
  const name = (value) => (markNames ? markedName(value) : value);
  const term = (key) => termKey(summary.systemId, key);
  const { party, enemies } = summary;
  const recap = [format(summary.durationMs > 0 ? "SCLS.Session.Report.Overview" : "SCLS.Session.Report.OverviewNoTime", {
    fights: countText("SCLS.Count.Fights", summary.fights),
    rounds: countText("SCLS.Count.Rounds", summary.rounds),
    time: formatDuration(summary.durationMs)
  })];
  if (party.damageDealt > 0) recap.push(format("SCLS.Session.Report.PartyDamage", { damage: formatNumber(party.damageDealt), dpr: formatNumber(party.dpr) }));
  if (party.healing > 0) recap.push(format(term("SCLS.Session.Report.Healing"), { healing: formatNumber(party.healing) }));
  if (summary.enemyStats && enemies.damageDealt > 0) recap.push(format("SCLS.Report.Enemy.Totals", { damage: formatNumber(enemies.damageDealt), dpr: formatNumber(enemies.dpr) }));
  if (summary.enemiesDefeated > 0) recap.push(plural(summary.enemiesDefeated, "SCLS.Report.Recap.DefeatedOne", "SCLS.Report.Recap.DefeatedOther"));
  if (summary.partyDowned > 0) recap.push(plural(summary.partyDowned, term("SCLS.Report.Recap.PartyDownOne"), term("SCLS.Report.Recap.PartyDownOther")));
  if (party.crits > 0) recap.push(plural(party.crits, "SCLS.Session.Report.CritsOne", "SCLS.Session.Report.CritsOther"));
  const members = summary.members.map((member) => memberLine(member, name(member.name)));
  const awards = summary.awards.map((award) => awardLine({ ...award, winners: award.winners.map((winner) => ({ ...winner, name: name(winner.name) })) }));
  const list = sessions
    ? sessions.map((row) => listLine(formatDateRange(row.startedAt, row.endedAt), countText("SCLS.Count.Fights", row.fights), row))
    : summary.fightRows.map((fight) => listLine(fight.title, countText("SCLS.Count.Rounds", fight.rounds), fight));
  return {
    title,
    sections: [
      { label: localize("SCLS.Session.Report.Recap"), entries: recap },
      { label: localize("SCLS.Session.Report.Party"), entries: members },
      { label: localize("SCLS.Metrics.Awards"), entries: awards },
      { label: localize(sessions ? "SCLS.Tab.sessions" : "SCLS.Label.Fights"), entries: list }
    ].filter((section) => section.entries.length)
  };
}

// Chat card: the markup of the player reports, so the module stylesheet styles it alike.
export function renderSessionHtml(report) {
  const body = report.sections.map((section) => `<div class="scls-report__section"><h4>${escapeHtml(section.label)}</h4><ul>${section.entries.map((entry) => `<li>${escapeHtml(entry)}</li>`).join("")}</ul></div>`).join("\n");
  return `<div class="scls-report scls-report--session">\n<h3 class="scls-report__title">${escapeHtml(report.title)}</h3>\n${body}\n</div>`;
}

// Discord messages of at most 2,000 characters each, formatted like the player report, with its credit line.
export function sessionDiscordMessages(report) {
  const blocks = [`## ${discordText(report.title)}`];
  for (const section of report.sections) blocks.push([`**${discordText(section.label)}**`, ...section.entries.map((entry) => `- ${discordText(entry)}`)].join("\n"));
  return discordReportMessages(blocks.join("\n\n"));
}

/**
 * The sessions of a time span: every session that overlaps it, oldest first. When none does, the nearest session less
 * than gapMs before or after it, so a photo taken just before the first fight of an evening still finds that evening.
 * Without from: the latest session.
 * @param {{id: string, startedAt: string, endedAt: string}[]} sessions  As groupSessions returns them
 * @param {{from?: Date|number|string, to?: Date|number|string}} span
 */
export function sessionsInSpan(sessions = [], { from = null, to = null } = {}, { gapMs = SESSION_GAP_MS } = {}) {
  if (!sessions.length) return [];
  const start = timeOf(from);
  if (start === null) return [sessions[0]];
  const end = timeOf(to) ?? start;
  const [low, high] = start <= end ? [start, end] : [end, start];
  const bounds = (session) => [timeOf(session.startedAt) ?? 0, timeOf(session.endedAt) ?? timeOf(session.startedAt) ?? 0];
  const overlapping = sessions.filter((session) => {
    const [first, last] = bounds(session);
    return first <= high && last >= low;
  });
  if (overlapping.length) return overlapping.reverse();
  const distance = (session) => {
    const [first, last] = bounds(session);
    return first > high ? first - high : low - last;
  };
  const nearest = sessions.map((session) => ({ session, distance: distance(session) }))
    .filter((entry) => entry.distance <= gapMs)
    .sort((left, right) => left.distance - right.distance)[0];
  return nearest ? [nearest.session] : [];
}

/**
 * The totals of a summary for other modules (API sessionTotals): plain numbers and the names players may see, the
 * party's numbers where a summary also knows the enemies'. enemyDamage is null unless every fight shares it.
 */
export function publicSessionTotals(summary, sessions = []) {
  const starts = sessions.map((session) => timeOf(session.startedAt)).filter((time) => time !== null);
  const ends = sessions.map((session) => timeOf(session.endedAt)).filter((time) => time !== null);
  const { party, enemies } = summary;
  return {
    sessionIds: sessions.map((session) => session.id),
    startedAt: starts.length ? new Date(Math.min(...starts)).toISOString() : null,
    endedAt: ends.length ? new Date(Math.max(...ends)).toISOString() : null,
    systemId: summary.systemId,
    fights: summary.fights,
    rounds: summary.rounds,
    durationMs: summary.durationMs,
    damage: party.damageDealt,
    healing: party.healing,
    moraleDamage: party.moraleDamage,
    enemyDamage: summary.enemyStats ? enemies.damageDealt : null,
    enemiesDefeated: summary.enemiesDefeated,
    partyDowned: summary.partyDowned,
    criticalHits: party.crits,
    members: summary.members.map((member) => ({
      name: member.name,
      img: member.img,
      fights: member.fights,
      damage: member.damageAppliedNet,
      healing: member.healingNet,
      moraleDamage: member.moraleDamageDealt,
      takedowns: member.takedowns,
      downed: member.downed,
      criticalHits: member.crits
    })),
    awards: summary.awards.map((award) => ({
      key: award.key,
      label: awardLabel(award.key),
      names: award.winners.map((winner) => winner.name),
      value: award.value,
      detail: awardDetail(award)
    }))
  };
}

/**
 * API sessionTotals: the combat totals of the game sessions in a time span, as players may see them. Each fight counts
 * with its own sharing choices, like the session report for chat. null without a session in the span and while
 * player reports are off. spans: one span or a list of them (one answer each, the fights are read once).
 * @param {object} service   The CombatLogService
 * @param {{from?: *, to?: *}|{from?: *, to?: *}[]} spans
 */
export async function sessionTotals(service, spans = {}) {
  const list = Array.isArray(spans) ? spans : [spans ?? {}];
  const none = () => (Array.isArray(spans) ? list.map(() => null) : null);
  if (!service?.persistence || getSetting(SETTINGS.ENABLE_PLAYER_SHARING, true) === false) return none();
  if (isGM()) await service.flushPendingSaves?.();
  const live = new Map((service.listActiveLogs?.() ?? []).map((log) => [log.id, log]));
  const logs = [];
  for (const entry of await service.persistence.loadHistoryEntries()) {
    if (!entry.loaded) continue;
    const log = live.get(entry.combatLogId) ?? await service.persistence.loadLog(entry.combatLogId);
    if (log) logs.push(log);
  }
  const sessions = groupSessions(logs);
  const options = { statsOptions: service.statsOptions?.() ?? {} };
  const views = new Map();
  const viewOf = (log) => {
    if (!views.has(log.id)) views.set(log.id, playerViewLog(log, options));
    return views.get(log.id);
  };
  const answers = list.map((span) => {
    const matched = sessionsInSpan(sessions, span ?? {});
    if (!matched.length) return null;
    return publicSessionTotals(summarizeFights(matched.flatMap((session) => session.logs).map(viewOf), options), matched);
  });
  return Array.isArray(spans) ? answers : answers[0];
}

// "Session of Sat, Oct 24, 2026", or the title for all sessions.
export function sessionTitle(session) {
  if (!session) return localize("SCLS.Session.Report.AllTitle");
  return format("SCLS.Session.Report.Title", { date: formatDateRange(session.startedAt, session.endedAt) });
}

function memberLine(member, name) {
  const details = [];
  if (member.damageAppliedNet > 0) details.push(format("SCLS.Report.Count.Damage", { amount: formatNumber(member.damageAppliedNet) }));
  if (member.healingNet > 0) details.push(format("SCLS.Report.Count.Healing", { amount: formatNumber(member.healingNet) }));
  if (member.moraleDamageDealt > 0) details.push(format("SCLS.Crucible.Report.Count.MoraleDamage", { amount: formatNumber(member.moraleDamageDealt) }));
  if (member.takedowns > 0) details.push(plural(member.takedowns, "SCLS.Report.Count.DefeatOne", "SCLS.Report.Count.DefeatOther"));
  if (member.crits > 0) details.push(plural(member.crits, "SCLS.Award.Detail.luckyOne", "SCLS.Award.Detail.luckyOther"));
  if (!details.length) return format("SCLS.Report.Contribution.Quiet", { name });
  return format("SCLS.Report.Contribution.Line", { name, details: joinList(details) });
}

// "Ambush: 4 rounds, party 38 damage, enemies 21." Without enemy numbers the party only.
function listLine(label, size, row) {
  const key = row.enemyDamage === null || row.enemyDamage === undefined ? "SCLS.Session.Report.ListParty" : "SCLS.Session.Report.List";
  return format(key, { label, size, party: formatNumber(row.partyDamage), enemies: formatNumber(row.enemyDamage ?? 0) });
}

function computedFor(log, statsOptions) {
  return log?.computed?.summary && Array.isArray(log.computed.bySide) ? log.computed : CombatStatsService.compute(log, statsOptions);
}

function sideTotals() {
  return { damageDealt: 0, damageTaken: 0, healing: 0, dprDamage: 0, rounds: 0, dpr: 0, downed: 0, takedowns: 0, crits: 0, fumbles: 0, control: 0, moraleDamage: 0 };
}

function addSide(side, row, method, rounds) {
  side.damageDealt += number(row.damageAppliedNet);
  side.damageTaken += number(row.damageTakenNet);
  side.healing += number(row.healingNet);
  side.dprDamage += number(dprValue(row, method));
  side.rounds += rounds;
  side.downed += number(row.downed);
  side.takedowns += number(row.takedowns);
  side.crits += number(row.crits);
  side.fumbles += number(row.fumbles);
  side.control += number(row.control);
  side.moraleDamage += number(row.moraleDamageDealt);
}

// Party members of one fight into the session rows, with their rolls and rescues for the awards. Combatant ids differ
// from fight to fight, so the awards count by member.
function addMembers(members, tallies, log, computed, method, rounds) {
  const rows = new Map((computed.byCombatant ?? []).map((row) => [String(row.id), row]));
  const keys = new Map();
  const counted = new Set();
  for (const participant of log.participants ?? []) {
    const id = String(participant?.combatantId ?? "");
    if (!id || participant.side !== SIDES.FRIENDLY) continue;
    const key = memberKey(participant);
    const member = members.get(key) ?? { id: key, name: "", img: "", fights: 0, rounds: 0, dprDamage: 0, ...Object.fromEntries(MEMBER_FIELDS.map((field) => [field, 0])) };
    const row = rows.get(id) ?? {};
    // The latest fight names the member. Two tokens of one character are one fight.
    member.name = participant.name || member.name;
    member.img = participant.img || member.img;
    if (!counted.has(key)) {
      member.fights += 1;
      member.rounds += rounds;
      counted.add(key);
    }
    for (const field of MEMBER_FIELDS) member[field] += number(row[field]);
    member.dprDamage += number(dprValue(row, method));
    members.set(key, member);
    keys.set(id, key);
  }
  if (!keys.size) return;
  const own = awardTallies((log.events ?? []).filter((event) => event && !event.ignored), new Set(keys.keys()));
  for (const [id, entry] of own.rolls) {
    const key = keys.get(id);
    const total = tallies.rolls.get(key) ?? { crits: 0, fumbles: 0, total: 0, count: 0, average: null };
    total.crits += entry.crits;
    total.fumbles += entry.fumbles;
    total.total += entry.total;
    total.count += entry.count;
    total.average = total.count ? total.total / total.count : null;
    tallies.rolls.set(key, total);
  }
  for (const [id, count] of own.rescues) {
    const key = keys.get(id);
    tallies.rescues.set(key, (tallies.rescues.get(key) ?? 0) + count);
  }
}

function countText(key, count) {
  return Number(count) === 1 ? localize(`${key}One`) : format(`${key}Other`, { count: formatNumber(count) });
}

function plural(count, oneKey, otherKey) {
  return format(Number(count) === 1 ? oneKey : otherKey, { count: formatNumber(count) });
}

function joinList(items) {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} ${localize("SCLS.Report.ListAnd")} ${items.at(-1)}`;
}

function timeOf(value) {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function number(value) {
  return Number(value) || 0;
}

function round(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}
