import { CONFIDENCE, EVENT_TYPES, SETTINGS, SHARE_MODES, SIDES, SOURCE_KINDS, VISIBILITY } from "../constants.js";
import { getSetting } from "../settings.js";
import { activeLocale, escapeHtml, format, isoNow, localize } from "../utils.js";
import { awardLine, computeAwards } from "./awards-service.js";
import { termKey } from "./system-terms.js";
import {
  actionName,
  downIncidents,
  downState,
  eventActors,
  eventAmount,
  isAutomaticEffect,
  isControl,
  isCritical,
  isDamageApplied,
  isDamageDealt,
  isDowned,
  isHealingApplied,
  isMagic,
  isMartial,
  isMoraleEvent,
  isRanged,
  isUndone,
  rescueIncidents,
  reversedCardMessageIds
} from "./event-insights.js";

// Moved to event-insights.js in 1.1; the export service and older callers import them from here.
export { downIncidents, eventActors };

const PLAYER_VISIBLE_MODES = new Set([
  SHARE_MODES.SUMMARY_ONLY,
  SHARE_MODES.PARTY_DPR_ONLY,
  SHARE_MODES.FULL_VISIBLE_DPR,
  SHARE_MODES.FULL_VISIBLE_RECAP,
  SHARE_MODES.PUBLIC_REPORT
]);

// Modes that may show numbers about the enemy side, and only when the GM includes enemy stats.
export const ENEMY_STAT_MODES = new Set([SHARE_MODES.FULL_VISIBLE_DPR, SHARE_MODES.FULL_VISIBLE_RECAP, SHARE_MODES.PUBLIC_REPORT]);
// Modes that may describe single actions. The other modes share totals only.
export const ACTION_DETAIL_MODES = new Set([SHARE_MODES.FULL_VISIBLE_RECAP, SHARE_MODES.PUBLIC_REPORT]);

export const REPORT_SECTIONS = Object.freeze([
  { key: "combatRecap", labelKey: "SCLS.ReportSection.CombatRecap" },
  { key: "partyContributions", labelKey: "SCLS.ReportSection.PartyContributions" },
  { key: "martialHighlights", labelKey: "SCLS.ReportSection.MartialHighlights" },
  { key: "spellwork", labelKey: "SCLS.ReportSection.Spellwork" },
  { key: "healingSupport", labelKey: "SCLS.ReportSection.HealingSupport" },
  { key: "controlPlays", labelKey: "SCLS.ReportSection.ControlPlays" },
  { key: "closeCalls", labelKey: "SCLS.ReportSection.CloseCalls" },
  { key: "damageSpotlight", labelKey: "SCLS.ReportSection.DamageSpotlight" },
  { key: "awards", labelKey: "SCLS.ReportSection.Awards" },
  { key: "heroMoments", labelKey: "SCLS.ReportSection.HeroMoments", defaultSelected: false },
  { key: "enemyPressure", labelKey: "SCLS.ReportSection.EnemyPressure", defaultSelected: false },
  { key: "tacticalTurningPoints", labelKey: "SCLS.ReportSection.TacticalTurningPoints", defaultSelected: false },
  { key: "supportSaves", labelKey: "SCLS.ReportSection.SupportSaves", defaultSelected: false },
  { key: "aftermath", labelKey: "SCLS.ReportSection.Aftermath", defaultSelected: false }
]);

const DEFAULT_REPORT_SECTIONS = Object.freeze(Object.fromEntries(REPORT_SECTIONS.map((section) => [section.key, section.defaultSelected !== false])));

// Sections that describe single actions and therefore need an action detail mode.
const ACTION_SECTIONS = new Set(["martialHighlights", "spellwork", "healingSupport", "controlPlays", "closeCalls", "heroMoments", "tacticalTurningPoints", "supportSaves"]);

// Bookkeeping events that never belong in a player report.
const NON_REPORT_TYPES = new Set([
  EVENT_TYPES.GM_NOTE,
  EVENT_TYPES.GM_MARKER,
  EVENT_TYPES.SHARE_CREATED,
  EVENT_TYPES.SHARE_UPDATED,
  EVENT_TYPES.SHARE_REVOKED,
  EVENT_TYPES.EXPORT_CREATED,
  EVENT_TYPES.SYSTEM_WARNING,
  EVENT_TYPES.CHAT_MESSAGE_CREATED
]);

// Events read from the game state (hit point changes, effects, combat updates) are stored with GM visibility,
// although every player sees the change on the token. Only chat messages and rolls carry a real whisper decision.
const OBSERVED_SOURCE_KINDS = new Set([
  SOURCE_KINDS.ACTOR_UPDATE,
  SOURCE_KINDS.ACTIVE_EFFECT_UPDATE,
  SOURCE_KINDS.TOKEN_UPDATE,
  SOURCE_KINDS.COMBAT_UPDATE,
  SOURCE_KINDS.HOOK,
  SOURCE_KINDS.RESUME
]);

const TARGET_FALLBACK = "SCLS.Report.Fallback.Target";
const SOMEONE_FALLBACK = "SCLS.Report.Fallback.Someone";

// Discord allows up to 2,000 characters per message.
export const DISCORD_MESSAGE_LIMIT = 2000;
// Mark participant names in the Discord text, so they can be set in bold after the rest is escaped.
const NAME_START = "\u0001";
const NAME_END = "\u0002";

export class PlayerReportService {
  canShare(log) {
    if (!getSetting(SETTINGS.ENABLE_PLAYER_SHARING, true)) return false;
    if (!log?.shareSettings?.isShared) return false;
    if (!PLAYER_VISIBLE_MODES.has(log.shareSettings.shareMode)) return false;
    return true;
  }

  buildReport(log, options = {}) {
    const share = { ...(log?.shareSettings ?? {}), ...(options.shareSettings ?? {}) };
    const sections = normalizeReportSections(share.reportSections);
    const ctx = reportContext(log, share, { markNames: Boolean(options.markNames) });
    const lines = {};
    for (const section of REPORT_SECTIONS) {
      lines[section.key] = sections[section.key] && sectionAllowed(section.key, ctx) ? SECTION_BUILDERS[section.key](ctx) : [];
    }
    return {
      title: log?.title || localize("SCLS.Report.DefaultTitle"),
      shareMode: ctx.mode,
      sections,
      summary: ctx.summary,
      lines
    };
  }

  renderMarkdown(report) {
    const sections = reportSectionEntries(report);
    const lines = [`# ${report.title}`];
    for (const section of sections) lines.push("", `## ${localize(section.labelKey)}`, "", ...section.entries.map((entry) => `- ${entry}`));
    if (!sections.length) lines.push("", localize("SCLS.Report.Empty"));
    return `${lines.join("\n")}\n`;
  }

  // Chat card and journal page. The module stylesheet styles .scls-report there and in the Sharing preview.
  renderHtml(report) {
    const sections = reportSectionEntries(report);
    const body = sections.length
      ? sections.map((section) => `<div class="scls-report__section"><h4>${escapeHtml(localize(section.labelKey))}</h4><ul>${section.entries.map((entry) => `<li>${escapeHtml(entry)}</li>`).join("")}</ul></div>`).join("\n")
      : `<p class="scls-report__empty">${escapeHtml(localize("SCLS.Report.Empty"))}</p>`;
    return `<div class="scls-report">\n<h3 class="scls-report__title">${escapeHtml(report.title)}</h3>\n${body}\n</div>`;
  }

  // Discord Markdown: the title as ## heading, section names and participant names in bold, everything else escaped.
  renderDiscordMarkdown(report) {
    const sections = reportSectionEntries(report);
    const blocks = [`## ${discordText(report.title)}`];
    for (const section of sections) blocks.push([`**${discordText(localize(section.labelKey))}**`, ...section.entries.map((entry) => `- ${discordText(entry)}`)].join("\n"));
    if (!sections.length) blocks.push(discordText(localize("SCLS.Report.Empty")));
    return blocks.join("\n\n");
  }

  // The player report as Discord messages of at most 2,000 characters each.
  discordMessages(log, options = {}) {
    return splitDiscordMessage(this.renderDiscordMarkdown(this.buildReport(log, { ...options, markNames: true })));
  }

  appendShareEvent(log, action, data = {}) {
    log.events.push({
      id: `share-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: action === "created" ? EVENT_TYPES.SHARE_CREATED : EVENT_TYPES.SHARE_UPDATED,
      createdAt: isoNow(),
      sequence: (log.events?.length ?? 0) + 1,
      round: null,
      turn: null,
      combatantId: "",
      actorUuid: "",
      tokenUuid: "",
      sceneUuid: log.sceneUuid,
      userId: globalThis.game?.user?.id ?? "",
      visibility: VISIBILITY.GM,
      source: { kind: SOURCE_KINDS.MANUAL, id: action },
      confidence: CONFIDENCE.MANUAL,
      ignored: false,
      tags: ["share"],
      data
    });
  }

  async postChatSummary(log) {
    const ChatMessageClass = globalThis.ChatMessage;
    if (!this.canShare(log) || typeof ChatMessageClass?.create !== "function") return null;
    const report = this.buildReport(log);
    const content = this.renderHtml(report);
    this.appendShareEvent(log, "updated", { target: "chat", shareMode: report.shareMode });
    return ChatMessageClass.create({ content, speaker: ChatMessageClass.getSpeaker?.() ?? {}, whisper: [] });
  }

  async createJournalReport(log) {
    const JournalEntryClass = globalThis.JournalEntry;
    if (!this.canShare(log) || typeof JournalEntryClass?.create !== "function") return null;
    const report = this.buildReport(log);
    const content = this.renderHtml(report);
    const page = {
      name: report.title,
      type: "text",
      text: { content, format: globalThis.CONST?.JOURNAL_ENTRY_PAGE_FORMATS?.HTML ?? 1 }
    };
    this.appendShareEvent(log, "updated", { target: "journal", shareMode: report.shareMode });
    const entry = await JournalEntryClass.create({ name: report.title, pages: [page], ownership: journalOwnership() });
    if (entry?.uuid) log.shareSettings.journalUuids = [...new Set([...(log.shareSettings.journalUuids ?? []), entry.uuid])];
    return entry;
  }

  // Stopping the share hides the journal reports of this combat from players again. The GM keeps them.
  async revokeJournalReports(log) {
    const none = globalThis.CONST?.DOCUMENT_OWNERSHIP_LEVELS?.NONE ?? 0;
    let revoked = 0;
    for (const uuid of log?.shareSettings?.journalUuids ?? []) {
      const entry = await globalThis.fromUuid?.(uuid);
      if (!entry) continue;
      await entry.update({ "ownership.default": none });
      revoked += 1;
    }
    return revoked;
  }
}

// Players may read the report. The creating GM stays owner (GMs keep full rights in any case).
function journalOwnership() {
  const levels = globalThis.CONST?.DOCUMENT_OWNERSHIP_LEVELS;
  const ownership = { default: levels?.OBSERVER ?? 2 };
  const userId = globalThis.game?.user?.id;
  if (userId) ownership[userId] = levels?.OWNER ?? 3;
  return ownership;
}

export function normalizeReportSections(sections = null) {
  return { ...DEFAULT_REPORT_SECTIONS, ...(sections ?? {}) };
}

// Keys of the sections that would show at least one line for this log with these share settings, whatever the
// GM selected. The Sharing tab offers only these, a checkbox for an empty section would change nothing.
export function reportSectionsWithContent(log, shareSettings = {}) {
  const all = Object.fromEntries(REPORT_SECTIONS.map((section) => [section.key, true]));
  const report = new PlayerReportService().buildReport(log, { shareSettings: { ...shareSettings, reportSections: all } });
  return new Set(REPORT_SECTIONS.filter((section) => report.lines[section.key]?.length).map((section) => section.key));
}

// Share options that can change the report of this log: hidden combatants and enemies need someone to apply to.
export function shareOptionAvailability(log) {
  const participants = (log?.participants ?? []).filter((participant) => participant?.combatantId);
  return {
    hiddenCombatants: participants.some((participant) => Boolean(participant.hidden)),
    enemies: participants.some((participant) => participant.side === SIDES.HOSTILE)
  };
}

function sectionEnabled(report, key) {
  return normalizeReportSections(report.sections)[key] !== false;
}

// Selected sections that have something to tell, in report order.
function reportSectionEntries(report) {
  return REPORT_SECTIONS
    .map((section) => ({ ...section, entries: sectionEnabled(report, section.key) ? (report.lines?.[section.key] ?? []) : [] }))
    .filter((section) => section.entries.length);
}

function sectionAllowed(key, ctx) {
  if (key === "damageSpotlight") return ctx.mode !== SHARE_MODES.SUMMARY_ONLY;
  if (key === "enemyPressure") return ctx.includeEnemyStats;
  if (ACTION_SECTIONS.has(key)) return ACTION_DETAIL_MODES.has(ctx.mode);
  return true;
}

// ---------------------------------------------------------------------------------------------
// Report context: visible participants with public names and the events the share settings allow.

function reportContext(log, share, { markNames = false } = {}) {
  const mode = share.shareMode ?? SHARE_MODES.GM_ONLY;
  const { participants, hiddenIds } = participantDirectory(log, share, markNames);
  const { events, privateRollIds } = shareableEvents(log, share, hiddenIds);
  const ctx = {
    share,
    mode,
    system: String(log?.systemId ?? ""),
    includeEnemyStats: enemyStatsShared(share),
    participants,
    events,
    entries: events.map((event, index) => eventEntry(event, index)),
    downs: downIncidents(events),
    privateRollIds,
    stats: log?.computed ?? {}
  };
  // Events already told as a drop to 0 HP, so hit lists do not repeat them.
  ctx.downEvents = new Set(ctx.downs.flatMap((down) => down.events));
  ctx.summary = reportSummary(ctx);
  return ctx;
}

// Enemy numbers need the GM's choice and a report detail that may show them. The player view of the log window
// follows the same rule.
export function enemyStatsShared(share = {}) {
  return Boolean(share.includeEnemyStats) && ENEMY_STAT_MODES.has(share.shareMode ?? SHARE_MODES.GM_ONLY);
}

// Enemies are called Enemy 1, Enemy 2 and so on unless the GM shows their names for this combat.
export function enemyNamesHidden(share = {}) {
  return Boolean(share.anonymizeEnemies) && share.includeNpcNames !== true;
}

// Participants players may see, with the names they may see. hiddenIds: hidden combatants the GM keeps back.
// Exported for the player view of the log window, so the window and the reports name everybody alike.
export function participantDirectory(log, share, markNames = false) {
  const participants = new Map();
  const hiddenIds = new Set();
  let enemyIndex = 0;
  for (const participant of log?.participants ?? []) {
    const id = String(participant?.combatantId ?? "");
    if (!id) continue;
    if (participant.hidden && !share.includeHiddenCombatants) {
      hiddenIds.add(id);
      continue;
    }
    const side = participant.side ?? SIDES.UNKNOWN;
    const name = side === SIDES.HOSTILE ? publicEnemyName(participant, share, () => ++enemyIndex) : (participant.name || localize(SOMEONE_FALLBACK));
    participants.set(id, { id, name: markNames ? `${NAME_START}${name}${NAME_END}` : name, side, isPlayerOwned: Boolean(participant.isPlayerOwned) });
  }
  return { participants, hiddenIds };
}

function publicEnemyName(participant, share, nextEnemyIndex) {
  if (!enemyNamesHidden(share) && participant.name) return participant.name;
  return format("SCLS.Report.EnemyName", { index: nextEnemyIndex() });
}

function shareableEvents(log, share, hiddenIds) {
  const events = [];
  const privateRollIds = new Set();
  const undoneCards = reversedCardMessageIds(log?.events ?? []);
  for (const event of log?.events ?? []) {
    if (!event || event.ignored || NON_REPORT_TYPES.has(event.type) || isCorrectionEvent(event)) continue;
    // An undone action card (Crucible) is no hit and no critical; its damage is taken back by the reversal.
    if (isUndone(event, undoneCards)) continue;
    if (isPrivateEvent(event)) {
      if (isRollEvent(event) && event.id) privateRollIds.add(event.id);
      if (!share.includePrivateRolls) continue;
    }
    if (!share.includeUnclearEvents && event.confidence === CONFIDENCE.UNCLEAR) continue;
    if (involvesHidden(event, hiddenIds)) continue;
    events.push(event);
  }
  if (share.includePrivateRolls) privateRollIds.clear();
  return { events, privateRollIds };
}

// GM notes, markers, share and export records, system warnings and chat messages.
export function isBookkeepingEvent(event) {
  return NON_REPORT_TYPES.has(event?.type);
}

// A whispered chat card or roll. Changes read from the game state are seen by everyone and are never private.
export function isPrivateEvent(event) {
  return event.visibility === VISIBILITY.GM && !OBSERVED_SOURCE_KINDS.has(event.source?.kind);
}

export function involvesHidden(event, hiddenIds) {
  if (!hiddenIds.size) return false;
  const targets = Array.isArray(event.data?.targetCombatantIds) ? event.data.targetCombatantIds : [];
  return [event.combatantId, event.data?.sourceCombatantId, event.data?.targetCombatantId, ...targets].some((id) => id && hiddenIds.has(String(id)));
}

function isRollEvent(event) {
  return String(event?.type ?? "").startsWith("roll.");
}

function isCorrectionEvent(event) {
  const type = String(event?.type ?? "");
  return type.includes("correct") || type.includes("manual");
}

function eventEntry(event, index) {
  return { event, index, round: event.round, amount: eventAmount(event), ...eventActors(event) };
}

function reportSummary(ctx) {
  const stats = ctx.stats;
  const sides = stats?.dpr?.bySide ?? stats?.bySide ?? [];
  const sideRow = (side) => sides.find((row) => row.id === side || row.side === side);
  const party = sideRow(SIDES.FRIENDLY);
  const enemies = sideRow(SIDES.HOSTILE);
  const eventRounds = ctx.events.map((event) => Number(event.round) || 0);
  return {
    rounds: Math.max(toNumber(stats?.summary?.rounds), 0, ...eventRounds),
    netDamageApplied: toNumber(party?.damageAppliedNet ?? stats?.summary?.netDamageApplied),
    netHealingApplied: toNumber(party?.healingNet ?? stats?.summary?.netHealingApplied),
    partyDPR: toNumber(stats?.dpr?.partyDPR),
    enemyDamage: ctx.includeEnemyStats ? toNumber(enemies?.damageAppliedNet) : null,
    enemyDPR: ctx.includeEnemyStats ? toNumber(stats?.dpr?.enemyDPR) : null,
    defeatedEnemies: new Set(ctx.downs.filter((down) => isEnemy(ctx, down.targetId)).map((down) => down.targetId)).size,
    partyDowns: ctx.downs.filter((down) => isParty(ctx, down.targetId)).length,
    unclassifiedDeltas: ctx.share.includeUnclearEvents ? toNumber(stats?.summary?.unclassifiedDeltas) : null
  };
}

function sideOf(ctx, id) {
  return ctx.participants.get(id)?.side ?? SIDES.UNKNOWN;
}

function isParty(ctx, id) {
  return Boolean(id) && sideOf(ctx, id) === SIDES.FRIENDLY;
}

function isEnemy(ctx, id) {
  return Boolean(id) && sideOf(ctx, id) === SIDES.HOSTILE;
}

function nameOf(ctx, id, fallbackKey = SOMEONE_FALLBACK) {
  return ctx.participants.get(id)?.name ?? localize(fallbackKey);
}

function partyMembers(ctx) {
  return Array.from(ctx.participants.values()).filter((participant) => participant.side === SIDES.FRIENDLY);
}

// Item or spell name, unless it came from a whispered roll the GM did not share.
function actionOf(ctx, ...events) {
  for (const event of events) {
    const rollId = event?.data?.correlation?.rollEventId;
    if (rollId && ctx.privateRollIds.has(rollId)) continue;
    const name = actionName(event);
    if (name) return name;
  }
  return "";
}

function effectName(event) {
  return String(event?.data?.name ?? "").trim() || actionName(event);
}

function memberTotals(ctx, member) {
  const row = (ctx.stats?.dpr?.byCombatant ?? ctx.stats?.byCombatant ?? []).find((entry) => String(entry.id) === member.id);
  if (row) {
    return {
      damage: toNumber(row.damageAppliedNet),
      healing: toNumber(row.healingNet ?? row.healingAppliedNet),
      morale: toNumber(row.moraleDamageDealt),
      dpr: toNumber(row.netDPR)
    };
  }
  const own = ctx.entries.filter((entry) => entry.sourceId === member.id);
  const damage = sum(own.filter((entry) => isDamageDealt(entry.event) && !isMoraleEvent(entry.event)));
  return {
    damage,
    healing: sum(own.filter((entry) => isHealingApplied(entry.event) && !isMoraleEvent(entry.event))),
    morale: sum(own.filter((entry) => isDamageDealt(entry.event) && isMoraleEvent(entry.event))),
    dpr: ctx.summary.rounds ? Math.round((damage / ctx.summary.rounds) * 100) / 100 : 0
  };
}

// ---------------------------------------------------------------------------------------------
// Sections

const SECTION_BUILDERS = Object.freeze({
  combatRecap: recapLines,
  partyContributions: contributionLines,
  martialHighlights: martialLines,
  spellwork: spellLines,
  healingSupport: healingLines,
  controlPlays: controlLines,
  closeCalls: closeCallLines,
  damageSpotlight: spotlightLines,
  awards: awardLines,
  heroMoments: heroMomentLines,
  enemyPressure: enemyPressureLines,
  tacticalTurningPoints: turningPointLines,
  supportSaves: supportLines,
  aftermath: aftermathLines
});

// The key for this log's system: Crucible texts speak of health and morale instead of hit points.
function term(ctx, key) {
  return termKey(ctx.system, key);
}

function recapLines(ctx) {
  const { summary } = ctx;
  const lines = [plural(summary.rounds, "SCLS.Report.Recap.DamageOne", "SCLS.Report.Recap.DamageOther", { damage: formatNumber(summary.netDamageApplied) })];
  if (summary.netHealingApplied > 0) lines.push(format(term(ctx, "SCLS.Report.Recap.Healing"), { healing: formatNumber(summary.netHealingApplied) }));
  if (summary.partyDPR > 0) lines.push(format("SCLS.Report.Recap.Pace", { dpr: formatNumber(summary.partyDPR) }));
  if (summary.defeatedEnemies > 0) lines.push(plural(summary.defeatedEnemies, "SCLS.Report.Recap.DefeatedOne", "SCLS.Report.Recap.DefeatedOther"));
  if (summary.partyDowns > 0) lines.push(plural(summary.partyDowns, term(ctx, "SCLS.Report.Recap.PartyDownOne"), term(ctx, "SCLS.Report.Recap.PartyDownOther")));
  if (summary.unclassifiedDeltas > 0) lines.push(plural(summary.unclassifiedDeltas, term(ctx, "SCLS.Report.Recap.UnclearOne"), term(ctx, "SCLS.Report.Recap.UnclearOther")));
  return lines;
}

function contributionLines(ctx) {
  return partyMembers(ctx).map((member) => {
    const own = ctx.entries.filter((entry) => entry.sourceId === member.id);
    const totals = memberTotals(ctx, member);
    const counts = [
      [own.filter((entry) => isMartial(entry.event)).length, "SCLS.Report.Count.MeleeOne", "SCLS.Report.Count.MeleeOther"],
      [own.filter((entry) => isRanged(entry.event)).length, "SCLS.Report.Count.RangedOne", "SCLS.Report.Count.RangedOther"],
      [own.filter((entry) => isMagic(entry.event)).length, "SCLS.Report.Count.SpellOne", "SCLS.Report.Count.SpellOther"],
      [own.filter((entry) => isControl(entry.event)).length, "SCLS.Report.Count.ControlOne", "SCLS.Report.Count.ControlOther"],
      [ctx.downs.filter((down) => down.sourceId === member.id && isEnemy(ctx, down.targetId)).length, "SCLS.Report.Count.DefeatOne", "SCLS.Report.Count.DefeatOther"]
    ];
    const details = [];
    if (totals.damage > 0) details.push(format("SCLS.Report.Count.Damage", { amount: formatNumber(totals.damage) }));
    if (totals.healing > 0) details.push(format("SCLS.Report.Count.Healing", { amount: formatNumber(totals.healing) }));
    if (totals.morale > 0) details.push(format("SCLS.Crucible.Report.Count.MoraleDamage", { amount: formatNumber(totals.morale) }));
    for (const [count, oneKey, otherKey] of counts) if (count > 0) details.push(plural(count, oneKey, otherKey));
    if (!details.length) return format("SCLS.Report.Contribution.Quiet", { name: member.name });
    return format("SCLS.Report.Contribution.Line", { name: member.name, details: joinList(details) });
  });
}

function martialLines(ctx) {
  const hits = ctx.entries.filter((entry) => (isMartial(entry.event) || isRanged(entry.event)) && isParty(ctx, entry.sourceId));
  return topByAmount(hits, 3).map((entry) => hitLine(ctx, entry));
}

function spellLines(ctx) {
  const hits = ctx.entries.filter((entry) => isMagic(entry.event) && isParty(ctx, entry.sourceId) && entry.amount > 0);
  const groups = new Map();
  for (const entry of hits) {
    const action = actionOf(ctx, entry.event);
    // Area totals add up damage. Morale damage (Crucible) is told hit by hit.
    if (!action || isMoraleEvent(entry.event)) continue;
    const key = `${entry.round ?? ""}|${entry.sourceId}|${action.toLowerCase()}`;
    const group = groups.get(key) ?? { round: entry.round, sourceId: entry.sourceId, action, total: 0, targets: new Set(), entries: [] };
    group.total += entry.amount;
    group.targets.add(entry.targetId || entry.event.id);
    group.entries.push(entry);
    groups.set(key, group);
  }
  const areas = Array.from(groups.values()).filter((group) => group.targets.size > 1).sort((left, right) => right.total - left.total).slice(0, 3);
  const covered = new Set(areas.flatMap((group) => group.entries));
  const areaLines = areas.map((group) => ({
    index: group.entries[0].index,
    line: roundLine(group.round, format("SCLS.Report.Hit.Area", {
      source: nameOf(ctx, group.sourceId),
      count: formatNumber(group.targets.size),
      action: group.action,
      amount: formatNumber(group.total)
    }))
  }));
  const singleLines = topByAmount(hits.filter((entry) => !covered.has(entry)), 5 - areaLines.length).map((entry) => ({ index: entry.index, line: hitLine(ctx, entry) }));
  return [...areaLines, ...singleLines].sort((left, right) => left.index - right.index).map((entry) => entry.line);
}

function healingEntries(ctx) {
  return ctx.entries.filter((entry) => isHealingApplied(entry.event) && entry.amount > 0 && (isParty(ctx, entry.sourceId) || (!entry.sourceId && isParty(ctx, entry.targetId))));
}

function healingLines(ctx) {
  return topByAmount(healingEntries(ctx), 4).map((entry) => roundLine(entry.round, healingSentence({
    source: entry.sourceId ? nameOf(ctx, entry.sourceId) : "",
    target: nameOf(ctx, entry.targetId, TARGET_FALLBACK),
    amount: formatNumber(entry.amount),
    action: actionOf(ctx, entry.event),
    pool: isMoraleEvent(entry.event) ? "morale" : "",
    system: ctx.system
  })));
}

function controlLines(ctx) {
  return ctx.entries.filter((entry) => isControl(entry.event) && isParty(ctx, entry.sourceId)).slice(0, 5).map((entry) => controlLine(ctx, entry));
}

function closeCallLines(ctx) {
  return ctx.downs.filter((down) => isParty(ctx, down.targetId)).slice(0, 5).map((down) => downLine(ctx, down));
}

function spotlightLines(ctx) {
  return partyMembers(ctx)
    .map((member) => ({ member, totals: memberTotals(ctx, member) }))
    .filter(({ totals }) => totals.damage > 0)
    .sort((left, right) => right.totals.damage - left.totals.damage)
    .slice(0, 5)
    .map(({ member, totals }) => format("SCLS.Report.Spotlight.Line", { name: member.name, damage: formatNumber(totals.damage), dpr: formatNumber(totals.dpr) }));
}

// Awards for party members: MVP, best healer, damage sponge and more (see awards-service.js).
function awardLines(ctx) {
  return computeAwards({ members: partyMembers(ctx), rows: ctx.stats?.byCombatant ?? ctx.stats?.dpr?.byCombatant ?? [], events: ctx.events }).map(awardLine);
}

function heroMomentLines(ctx) {
  const defeats = ctx.downs
    .filter((down) => isParty(ctx, down.sourceId) && isEnemy(ctx, down.targetId))
    .map((down) => {
      const action = actionOf(ctx, ...down.events);
      const data = { source: nameOf(ctx, down.sourceId), target: nameOf(ctx, down.targetId, TARGET_FALLBACK), action };
      return roundLine(down.round, format(action ? "SCLS.Report.Defeat.With" : "SCLS.Report.Defeat.Plain", data));
    });
  const crits = ctx.entries
    .filter((entry) => isCritical(entry.event) && isParty(ctx, entry.sourceId))
    .map((entry) => {
      const action = actionOf(ctx, entry.event);
      return roundLine(entry.round, format(action ? "SCLS.Report.Crit.With" : "SCLS.Report.Crit.Plain", { source: nameOf(ctx, entry.sourceId), action }));
    });
  const bestHits = partyMembers(ctx)
    .map((member) => topByAmount(ctx.entries.filter((entry) => isDamageDealt(entry.event) && entry.sourceId === member.id && !ctx.downEvents.has(entry.event)), 1)[0])
    .filter(Boolean)
    .sort((left, right) => left.index - right.index)
    .map((entry) => hitLine(ctx, entry));
  return unique([...defeats, ...crits, ...bestHits]).slice(0, 6);
}

function enemyPressureLines(ctx) {
  const lines = [];
  const { enemyDamage, enemyDPR } = ctx.summary;
  if (enemyDamage > 0 || enemyDPR > 0) lines.push(format("SCLS.Report.Enemy.Totals", { damage: formatNumber(enemyDamage), dpr: formatNumber(enemyDPR) }));
  if (!ACTION_DETAIL_MODES.has(ctx.mode)) return lines;
  const downs = ctx.downs.filter((down) => isParty(ctx, down.targetId) && isEnemy(ctx, down.sourceId)).map((down) => downLine(ctx, down));
  const hits = topByAmount(ctx.entries.filter((entry) => isDamageApplied(entry.event) && isParty(ctx, entry.targetId) && (isEnemy(ctx, entry.sourceId) || !entry.sourceId) && !ctx.downEvents.has(entry.event)), 3)
    .map((entry) => hitLine(ctx, entry));
  const controls = ctx.entries.filter((entry) => isControl(entry.event) && isEnemy(ctx, entry.sourceId) && isParty(ctx, entry.targetId)).slice(0, 2)
    .map((entry) => controlLine(ctx, entry));
  return [...lines, ...unique([...downs, ...hits, ...controls]).slice(0, 6)];
}

function turningPointLines(ctx) {
  const rounds = new Map();
  const bucket = (round) => {
    const number = Number(round) || 0;
    if (!rounds.has(number)) rounds.set(number, { round: number, damage: 0, healing: 0, defeats: 0, downs: 0, control: 0 });
    return rounds.get(number);
  };
  const healing = new Set(healingEntries(ctx));
  for (const entry of ctx.entries) {
    if (!(Number(entry.round) > 0)) continue;
    if (isDamageDealt(entry.event) && !isMoraleEvent(entry.event) && isParty(ctx, entry.sourceId)) bucket(entry.round).damage += entry.amount;
    if (healing.has(entry)) bucket(entry.round).healing += entry.amount;
    if (isControl(entry.event) && isParty(ctx, entry.sourceId)) bucket(entry.round).control += 1;
  }
  for (const down of ctx.downs) {
    if (!(Number(down.round) > 0)) continue;
    if (isEnemy(ctx, down.targetId)) bucket(down.round).defeats += 1;
    else if (isParty(ctx, down.targetId)) bucket(down.round).downs += 1;
  }
  return Array.from(rounds.values())
    .map((round) => ({ ...round, score: round.damage + round.healing + (25 * round.defeats) + (15 * round.downs) + (10 * round.control) }))
    .filter((round) => round.score > 0)
    .sort((left, right) => (right.score - left.score) || (left.round - right.round))
    .slice(0, 3)
    .sort((left, right) => left.round - right.round)
    .map((round) => roundLine(round.round, format("SCLS.Report.Turning.Line", { parts: joinList(turningParts(ctx, round)) })));
}

function turningParts(ctx, round) {
  const parts = [];
  if (round.damage > 0) parts.push(format("SCLS.Report.Count.PartyDamage", { amount: formatNumber(round.damage) }));
  if (round.defeats > 0) parts.push(plural(round.defeats, "SCLS.Report.Count.DefeatOne", "SCLS.Report.Count.DefeatOther"));
  if (round.downs > 0) parts.push(plural(round.downs, term(ctx, "SCLS.Report.Count.DownOne"), term(ctx, "SCLS.Report.Count.DownOther")));
  if (round.control > 0) parts.push(plural(round.control, "SCLS.Report.Count.ControlOne", "SCLS.Report.Count.ControlOther"));
  if (round.healing > 0) parts.push(format(term(ctx, "SCLS.Report.Count.PartyHealing"), { amount: formatNumber(round.healing) }));
  return parts;
}

function supportLines(ctx) {
  const rescues = rescueIncidents(ctx.events)
    .filter((rescue) => isParty(ctx, rescue.targetId) && (!rescue.sourceId || isParty(ctx, rescue.sourceId)))
    .slice(0, 4)
    .map((rescue) => {
      const target = nameOf(ctx, rescue.targetId, TARGET_FALLBACK);
      if (!rescue.sourceId) return roundLine(rescue.round, format("SCLS.Report.Rescue.Self", { target }));
      const action = actionOf(ctx, ...rescue.events);
      return roundLine(rescue.round, format(action ? "SCLS.Report.Rescue.With" : "SCLS.Report.Rescue.Plain", { source: nameOf(ctx, rescue.sourceId), target, action }));
    });
  const buffs = ctx.entries
    .filter((entry) => entry.event.type === EVENT_TYPES.ACTIVE_EFFECT_CREATED && !isControl(entry.event) && !isAutomaticEffect(entry.event) && effectName(entry.event))
    .filter((entry) => isParty(ctx, entry.sourceId) && isParty(ctx, entry.targetId))
    .slice(0, 4)
    .map((entry) => roundLine(entry.round, format("SCLS.Report.Buff.Named", {
      source: nameOf(ctx, entry.sourceId),
      target: nameOf(ctx, entry.targetId, TARGET_FALLBACK),
      effect: effectName(entry.event)
    })));
  return unique([...rescues, ...buffs]).slice(0, 6);
}

function aftermathLines(ctx) {
  const lines = [];
  if (ctx.summary.rounds > 0) lines.push(plural(ctx.summary.rounds, "SCLS.Report.Aftermath.RoundsOne", "SCLS.Report.Aftermath.RoundsOther"));
  const members = partyMembers(ctx);
  const down = members.filter((member) => isDownAtEnd(ctx, member.id));
  const standing = members.filter((member) => !down.includes(member));
  if (standing.length) lines.push(format("SCLS.Report.Aftermath.Standing", { names: joinList(standing.map((member) => member.name)) }));
  if (down.length) lines.push(format(term(ctx, "SCLS.Report.Aftermath.Down"), { names: joinList(down.map((member) => member.name)) }));
  if (ctx.includeEnemyStats) {
    const enemies = Array.from(ctx.participants.values()).filter((participant) => participant.side === SIDES.HOSTILE);
    if (enemies.length) lines.push(format("SCLS.Report.Aftermath.Enemies", { defeated: formatNumber(ctx.summary.defeatedEnemies), total: formatNumber(enemies.length) }));
  }
  return lines;
}

// Down at the end when no healing reached the participant after the last drop to 0 HP.
function isDownAtEnd(ctx, id) {
  const lastDown = Math.max(-1, ...ctx.downs.filter((down) => down.targetId === id).map((down) => down.index));
  if (lastDown < 0) return false;
  const lastHealing = Math.max(-1, ...ctx.entries.filter((entry) => entry.targetId === id && entry.amount > 0 && isHealingApplied(entry.event)).map((entry) => entry.index));
  return lastHealing < lastDown;
}

function hitLine(ctx, entry) {
  return roundLine(entry.round, damageSentence({
    source: entry.sourceId ? nameOf(ctx, entry.sourceId) : "",
    target: nameOf(ctx, entry.targetId, entry.sourceId ? TARGET_FALLBACK : SOMEONE_FALLBACK),
    amount: formatNumber(entry.amount),
    action: actionOf(ctx, entry.event),
    pool: isMoraleEvent(entry.event) ? "morale" : ""
  }));
}

function controlLine(ctx, entry) {
  return roundLine(entry.round, controlSentence({
    source: nameOf(ctx, entry.sourceId),
    target: nameOf(ctx, entry.targetId, TARGET_FALLBACK),
    effect: effectName(entry.event)
  }));
}

function downLine(ctx, down) {
  return roundLine(down.round, downSentence({
    source: down.sourceId ? nameOf(ctx, down.sourceId) : "",
    target: nameOf(ctx, down.targetId, TARGET_FALLBACK),
    action: down.sourceId ? actionOf(ctx, ...down.events) : "",
    state: down.events.map(downState).find(Boolean) ?? ""
  }));
}

// ---------------------------------------------------------------------------------------------
// Sentence builders, shared with the Markdown export.

export function roundLine(round, text) {
  const number = Number(round) || 0;
  return number > 0 ? format("SCLS.Report.RoundLine", { round: formatNumber(number), text }) : text;
}

// pool "morale" is Crucible's morale and madness. system picks the wording for hit points or health.
export function damageSentence({ source = "", target = "", amount = "", action = "", pool = "" } = {}) {
  if (pool === "morale") {
    if (!source) return format("SCLS.Crucible.Report.Morale.Taken", { target, amount });
    return format(action ? "SCLS.Crucible.Report.Morale.HitWith" : "SCLS.Crucible.Report.Morale.HitPlain", { source, target, amount, action });
  }
  if (!source) return format("SCLS.Report.Hit.Taken", { target, amount });
  return format(action ? "SCLS.Report.Hit.With" : "SCLS.Report.Hit.Plain", { source, target, amount, action });
}

export function healingSentence({ source = "", target = "", amount = "", action = "", pool = "", system = "" } = {}) {
  if (pool === "morale") {
    if (!source) return format(action ? "SCLS.Crucible.Report.Morale.HealSelfWith" : "SCLS.Crucible.Report.Morale.HealSelf", { target, amount, action });
    return format(action ? "SCLS.Crucible.Report.Morale.HealWith" : "SCLS.Crucible.Report.Morale.HealPlain", { source, target, amount, action });
  }
  if (!source) return format(termKey(system, action ? "SCLS.Report.Heal.SelfWith" : "SCLS.Report.Heal.Self"), { target, amount, action });
  return format(termKey(system, action ? "SCLS.Report.Heal.With" : "SCLS.Report.Heal.Plain"), { source, target, amount, action });
}

export function controlSentence({ source = "", target = "", effect = "" } = {}) {
  if (!source) return effect ? format("SCLS.Report.Control.Received", { target, effect }) : "";
  return format(effect ? "SCLS.Report.Control.Named" : "SCLS.Report.Control.Unnamed", { source, target, effect });
}

// state is the Crucible state reached (weakened, dead, broken, insane). Without it the sentence speaks of 0 HP.
export function downSentence({ source = "", target = "", action = "", state = "" } = {}) {
  if (state) {
    const data = { source, target, action, state: localize(`SCLS.Crucible.StateText.${state}`) };
    if (!source) return format("SCLS.Crucible.Report.Down.Plain", data);
    return format(action ? "SCLS.Crucible.Report.Down.BySourceWith" : "SCLS.Crucible.Report.Down.BySource", data);
  }
  if (!source) return format("SCLS.Report.Down.Plain", { target });
  return format(action ? "SCLS.Report.Down.BySourceWith" : "SCLS.Report.Down.BySource", { source, target, action });
}

export function formatNumber(value) {
  const number = Number(value) || 0;
  try {
    return new Intl.NumberFormat(activeLocale(), { maximumFractionDigits: 2 }).format(number);
  } catch {
    return String(Math.round(number * 100) / 100);
  }
}

function plural(count, oneKey, otherKey, data = {}) {
  return format(Number(count) === 1 ? oneKey : otherKey, { ...data, count: formatNumber(count) });
}

function joinList(items) {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} ${localize("SCLS.Report.ListAnd")} ${items.at(-1)}`;
}

// The biggest entries, told in the order they happened.
function topByAmount(entries, limit) {
  return entries
    .filter((entry) => entry.amount > 0)
    .sort((left, right) => (right.amount - left.amount) || (left.index - right.index))
    .slice(0, Math.max(0, limit))
    .sort((left, right) => left.index - right.index);
}

function sum(entries) {
  return entries.reduce((total, entry) => total + entry.amount, 0);
}

function unique(lines) {
  return Array.from(new Set(lines.filter(Boolean)));
}

function toNumber(value) {
  return Number(value) || 0;
}

// Escapes Discord formatting characters and keeps @everyone and @here from pinging, then bolds the marked names.
function discordText(value) {
  return String(value ?? "")
    .replace(/[\\*_~`|<>[\]]/g, "\\$&")
    .replace(/@(everyone|here)/gi, "@\u200b$1")
    .replaceAll(NAME_START, "**")
    .replaceAll(NAME_END, "**");
}

// Splits between sections first. A section longer than one message starts a new message and continues at a line
// break. Only a single line longer than the limit is cut.
export function splitDiscordMessage(text, limit = DISCORD_MESSAGE_LIMIT) {
  const messages = [];
  let current = "";
  const flush = () => {
    if (current) messages.push(current);
    current = "";
  };
  const add = (piece, separator) => {
    if (current && current.length + separator.length + piece.length > limit) flush();
    current = current ? current + separator + piece : piece;
  };
  for (const block of String(text ?? "").split(/\n{2,}/).filter((entry) => entry.trim())) {
    if (block.length <= limit) {
      add(block, "\n\n");
      continue;
    }
    flush();
    for (const piece of block.split("\n").flatMap((line) => splitLongLine(line, limit))) add(piece, "\n");
  }
  flush();
  return messages;
}

function splitLongLine(line, limit) {
  const pieces = [];
  let rest = line;
  while (rest.length > limit) {
    const space = rest.lastIndexOf(" ", limit);
    const cut = space > 0 ? space : limit;
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  pieces.push(rest);
  return pieces;
}

export const __test__ = { normalizeReportSections, reportContext, participantDirectory, shareableEvents, journalOwnership, rescueIncidents, isCorrectionEvent, discordText, splitDiscordMessage };
