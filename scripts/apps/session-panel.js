import { awardDetail, awardLabel } from "../services/awards-service.js";
import { formatNumber } from "../services/player-report-service.js";
import { NIGHT_PREFIX, assignToSessions, betweenFightsPanel, looseNights, nightLabel } from "../services/offcombat-log.js";
import { ALL_SESSIONS, groupSessions, sessionRows, sessionTitle, summarizeFights } from "../services/session-service.js";
import { format, formatDateRange, formatDateTime, formatDuration, formatShortDate, localize } from "../utils.js";
import { groupDamageChart } from "./charts.js";

const UNKNOWN_IMAGE = "icons/svg/mystery-man.svg";

/**
 * The Sessions tab: the fights of one game session, or of all sessions, added up. The party against the enemies,
 * every party member, the awards and the fights (or sessions) one by one.
 * @param {object[]} logs  Every stored fight with its numbers; player views for players (player-view-service.js)
 * @param {object} options
 * @param {string|null} options.selectedId  A session id, ALL_SESSIONS, or null for the latest session
 */
export function sessionPanel(logs = [], { selectedId = null, statsOptions = {}, offEvents = null, offDropped = 0 } = {}) {
  const sessions = groupSessions(logs);
  // Hit point and condition changes outside the fights (GM only): the ones inside a session belong to it, the others
  // make nights of their own.
  const off = offEvents ? assignToSessions(sessions, offEvents) : { bySession: new Map(), loose: [] };
  const nights = looseNights(off.loose);
  if (!sessions.length && !nights.length) return { hasFights: false, selectedId: null };
  const night = (selectedId?.startsWith?.(NIGHT_PREFIX) ? nights.find((entry) => entry.id === selectedId) : null) ?? (sessions.length ? null : nights[0]);
  if (night) return nightPanel(sessions, nights, night, offDropped);
  const all = selectedId === ALL_SESSIONS;
  const selected = all ? null : sessions.find((session) => session.id === selectedId) ?? sessions[0];
  const fights = all ? sessions.flatMap((session) => session.logs) : selected.logs;
  const summary = summarizeFights(fights, { statsOptions });
  const perSession = all ? sessionRows(summary, sessions) : null;
  const enemyStats = summary.enemyStats;
  const chartRows = all
    ? [...perSession].reverse().map((row) => ({ label: formatShortDate(row.startedAt), name: formatDateRange(row.startedAt, row.endedAt), partyDamage: row.partyDamage, enemyDamage: row.enemyDamage ?? 0 }))
    : summary.fightRows.map((fight, index) => ({ label: String(index + 1), name: fight.title, partyDamage: fight.partyDamage, enemyDamage: fight.enemyDamage ?? 0 }));
  return {
    hasFights: true,
    selectedId: all ? ALL_SESSIONS : selected.id,
    isAll: all,
    title: sessionTitle(selected),
    rangeLabel: all
      ? format("SCLS.Session.AllRange", { sessions: countLabel("SCLS.Count.GameSessions", sessions.length), range: formatDateRange(sessions.at(-1).startedAt, sessions[0].endedAt) })
      : formatDateRange(selected.startedAt, selected.endedAt, { time: true }),
    options: sessionOptions(sessions, { selected, all }).concat(nightOptions(nights, null)),
    between: !all && offEvents ? betweenFightsPanel(off.bySession.get(selected.id) ?? [], { dropped: offDropped }) : null,
    nightRows: all ? nights.map((entry) => ({ id: entry.id, label: formatDateRange(entry.startedAt, entry.endedAt), count: formatNumber(entry.events.length) })) : [],
    showOutside: Boolean(offEvents),
    enemyStats,
    showMorale: summary.morale,
    cards: summaryCards(summary),
    versus: versusRows(summary),
    chart: groupDamageChart(chartRows, { formatValue: formatNumber, enemies: enemyStats, count: countLabel(all ? "SCLS.Count.GameSessions" : "SCLS.Count.Fights", chartRows.length) }),
    chartTitle: localize(all ? "SCLS.Chart.SessionDamage" : "SCLS.Chart.FightDamage"),
    // Many columns get the full width instead of a squeezed half.
    chartWide: chartRows.length > 10,
    chartLegend: [{ tone: "party", label: localize("SCLS.Chart.Party") }, { tone: "enemies", label: localize("SCLS.Chart.Enemies") }].slice(0, enemyStats ? 2 : 1),
    members: summary.members.map(memberRow),
    awards: summary.awards.map((award) => ({
      key: award.key,
      icon: award.icon,
      label: awardLabel(award.key),
      names: award.winners.map((winner) => winner.name).join(", "),
      detail: awardDetail(award)
    })),
    fightRows: all ? [] : summary.fightRows.map((fight) => ({
      id: fight.id,
      title: fight.title,
      startedLabel: formatDateTime(fight.startedAt),
      statusLabel: localize(`SCLS.Status.${fight.status}`),
      active: fight.status === "active",
      rounds: formatNumber(fight.rounds),
      partyDamage: formatNumber(fight.partyDamage),
      enemyDamage: fight.enemyDamage === null ? "-" : formatNumber(fight.enemyDamage),
      enemiesDefeated: formatNumber(fight.enemiesDefeated),
      partyDowned: formatNumber(fight.partyDowned)
    })),
    sessionRows: (perSession ?? []).map((row) => ({
      id: row.id,
      label: formatDateRange(row.startedAt, row.endedAt),
      outside: formatNumber(off.bySession.get(row.id)?.length ?? 0),
      fights: formatNumber(row.fights),
      rounds: formatNumber(row.rounds),
      partyDamage: formatNumber(row.partyDamage),
      enemyDamage: row.enemyDamage === null ? "-" : formatNumber(row.enemyDamage),
      enemiesDefeated: formatNumber(row.enemiesDefeated),
      partyDowned: formatNumber(row.partyDowned)
    }))
  };
}

// Absolute sums first. Without enemy numbers the totals are the party's, and say so.
function summaryCards(summary) {
  const cards = [
    card("", "SCLS.Label.Fights", formatNumber(summary.fights)),
    card("", "SCLS.Label.Rounds", formatNumber(summary.rounds)),
    card("", "SCLS.Label.CombatTime", formatDuration(summary.durationMs)),
    card("damage", summary.enemyStats ? "SCLS.Label.TotalDamage" : "SCLS.Label.PartyNetDamage", formatNumber(summary.damage)),
    card("healing", summary.enemyStats ? "SCLS.Label.TotalHealing" : "SCLS.Label.PartyNetHealing", formatNumber(summary.healing)),
    card("hostile", "SCLS.Label.EnemiesDefeated", formatNumber(summary.enemiesDefeated)),
    card("friendly", "SCLS.Label.PartyDowned", formatNumber(summary.partyDowned)),
    card("", "SCLS.Label.CriticalHits", formatNumber(summary.criticalHits))
  ];
  if (summary.morale) cards.push(card("morale", summary.enemyStats ? "SCLS.Label.MoraleDamage" : "SCLS.Session.PartyMoraleDamage", formatNumber(summary.moraleDamage)));
  return cards;
}

function card(tone, labelKey, value) {
  return { tone, label: localize(labelKey), value };
}

// The party against the enemies, with the party's share of both as a bar. The first rows always show, the others
// only when somebody scored.
function versusRows(summary) {
  const { party, enemies } = summary;
  const rows = [
    ["SCLS.Label.DamageDealt", party.damageDealt, enemies.damageDealt, true],
    ["SCLS.Label.DamagePerRound", party.dpr, enemies.dpr, true],
    ["SCLS.Label.DamageTaken", party.damageTaken, enemies.damageTaken, true],
    ["SCLS.Label.Healing", party.healing, enemies.healing, true],
    ["SCLS.Session.WentDown", party.downed, enemies.downed, true],
    ["SCLS.Label.CriticalHits", party.crits, enemies.crits, false],
    ["SCLS.Label.Fumbles", party.fumbles, enemies.fumbles, false],
    ["SCLS.Label.Control", party.control, enemies.control, false]
  ];
  if (summary.morale) rows.push(["SCLS.Label.MoraleDamage", party.moraleDamage, enemies.moraleDamage, false]);
  return rows.filter(([, partyValue, enemyValue, always]) => always || partyValue > 0 || (summary.enemyStats && enemyValue > 0)).map(([key, partyValue, enemyValue]) => {
    const ours = Math.max(0, Number(partyValue) || 0);
    const total = ours + Math.max(0, Number(enemyValue) || 0);
    const share = total > 0 ? Math.round((ours / total) * 100) : 50;
    return {
      label: localize(key),
      party: formatNumber(partyValue),
      enemies: formatNumber(enemyValue),
      share,
      empty: total <= 0,
      tooltip: format("SCLS.Session.ShareTooltip", { party: share, enemies: 100 - share })
    };
  });
}

function memberRow(member) {
  return {
    name: member.name || localize("SCLS.Report.Fallback.Someone"),
    img: member.img || UNKNOWN_IMAGE,
    fights: formatNumber(member.fights),
    damage: formatNumber(member.damageAppliedNet),
    dpr: formatNumber(member.netDPR),
    taken: formatNumber(member.damageTakenNet),
    healing: formatNumber(member.healingNet),
    takedowns: formatNumber(member.takedowns),
    downed: formatNumber(member.downed),
    crits: formatNumber(member.crits),
    morale: formatNumber(member.moraleDamageDealt)
  };
}

function countLabel(key, count) {
  return count === 1 ? localize(`${key}One`) : format(`${key}Other`, { count: formatNumber(count) });
}

function sessionOptions(sessions, { selected, all }) {
  if (!sessions.length) return [];
  return sessions.map((session) => ({
    value: session.id,
    label: format("SCLS.Session.Option", { date: formatDateRange(session.startedAt, session.endedAt), fights: countLabel("SCLS.Count.Fights", session.logs.length) }),
    selected: session === selected
  })).concat({
    value: ALL_SESSIONS,
    label: format("SCLS.Session.Option", { date: localize("SCLS.Session.All"), fights: countLabel("SCLS.Count.Fights", sessions.reduce((total, session) => total + session.logs.length, 0)) }),
    selected: all
  });
}

function nightOptions(nights, selected) {
  return nights.map((night) => ({ value: night.id, label: nightLabel(night), selected: night === selected }));
}

// A game night without a fight: only what happened outside combat.
function nightPanel(sessions, nights, night, dropped) {
  return {
    hasFights: true,
    offOnly: true,
    showOutside: true,
    selectedId: night.id,
    isAll: false,
    title: format("SCLS.Session.Report.Title", { date: formatDateRange(night.startedAt, night.endedAt) }),
    rangeLabel: formatDateRange(night.startedAt, night.endedAt, { time: true }),
    options: sessionOptions(sessions, { selected: null, all: false }).concat(nightOptions(nights, night)),
    between: betweenFightsPanel(night.events, { dropped }),
    nightRows: [],
    sessionRows: [],
    fightRows: []
  };
}
