import { CONFIDENCE, EVENT_TYPES, SETTINGS, SHARE_MODES, SIDES, SOURCE_KINDS, VISIBILITY } from "../constants.js";
import { getSetting } from "../settings.js";
import { escapeHtml, isoNow } from "../utils.js";

const PLAYER_VISIBLE_MODES = new Set([
  SHARE_MODES.SUMMARY_ONLY,
  SHARE_MODES.PARTY_DPR_ONLY,
  SHARE_MODES.FULL_VISIBLE_DPR,
  SHARE_MODES.FULL_VISIBLE_RECAP,
  SHARE_MODES.PUBLIC_REPORT
]);

export const REPORT_SECTIONS = Object.freeze([
  { key: "combatRecap", labelKey: "SCLS.ReportSection.CombatRecap" },
  { key: "partyContributions", labelKey: "SCLS.ReportSection.PartyContributions" },
  { key: "martialHighlights", labelKey: "SCLS.ReportSection.MartialHighlights" },
  { key: "spellwork", labelKey: "SCLS.ReportSection.Spellwork" },
  { key: "healingSupport", labelKey: "SCLS.ReportSection.HealingSupport" },
  { key: "controlPlays", labelKey: "SCLS.ReportSection.ControlPlays" },
  { key: "closeCalls", labelKey: "SCLS.ReportSection.CloseCalls" },
  { key: "damageSpotlight", labelKey: "SCLS.ReportSection.DamageSpotlight" },
  { key: "heroMoments", labelKey: "SCLS.ReportSection.HeroMoments", defaultSelected: false },
  { key: "enemyPressure", labelKey: "SCLS.ReportSection.EnemyPressure", defaultSelected: false },
  { key: "tacticalTurningPoints", labelKey: "SCLS.ReportSection.TacticalTurningPoints", defaultSelected: false },
  { key: "supportSaves", labelKey: "SCLS.ReportSection.SupportSaves", defaultSelected: false },
  { key: "aftermath", labelKey: "SCLS.ReportSection.Aftermath", defaultSelected: false }
]);

const DEFAULT_REPORT_SECTIONS = Object.freeze(Object.fromEntries(REPORT_SECTIONS.map((section) => [section.key, section.defaultSelected !== false])));

export class PlayerReportService {
  canShare(log) {
    if (!getSetting(SETTINGS.ENABLE_PLAYER_SHARING, true)) return false;
    if (!log?.shareSettings?.isShared) return false;
    if (!PLAYER_VISIBLE_MODES.has(log.shareSettings.shareMode)) return false;
    return true;
  }

  buildReport(log, options = {}) {
    const share = { ...(log?.shareSettings ?? {}), ...(options.shareSettings ?? {}) };
    const mode = share.shareMode ?? SHARE_MODES.GM_ONLY;
    const sections = normalizeReportSections(share.reportSections);
    const stats = log?.computed ?? {};
    const participants = visibleParticipants(log, share);
    const includeDPR = sections.damageSpotlight && mode !== SHARE_MODES.SUMMARY_ONLY;
    const includeEnemyStats = share.includeEnemyStats && [SHARE_MODES.FULL_VISIBLE_DPR, SHARE_MODES.FULL_VISIBLE_RECAP, SHARE_MODES.PUBLIC_REPORT].includes(mode);
    const includeTimeline = hasAnyHighlightSection(sections) && [SHARE_MODES.FULL_VISIBLE_RECAP, SHARE_MODES.PUBLIC_REPORT].includes(mode);
    const includeCorrections = false;

    return {
      title: log?.title ?? "Combat Report",
      status: log?.status ?? "unknown",
      generatedAt: isoNow(),
      startedAt: log?.startedAt ?? null,
      endedAt: log?.endedAt ?? null,
      rounds: stats?.summary?.rounds ?? 0,
      participants,
      summary: {
        netDamageApplied: stats?.summary?.netDamageApplied ?? 0,
        grossDamageApplied: stats?.summary?.grossDamageApplied ?? 0,
        netHealingApplied: stats?.summary?.netHealingApplied ?? 0,
        partyDPR: stats?.dpr?.partyDPR ?? 0,
        enemyDPR: includeEnemyStats ? (stats?.dpr?.enemyDPR ?? 0) : null,
        unclassifiedDeltas: share.includeUnclearEvents ? (stats?.summary?.unclassifiedDeltas ?? 0) : null
      },
      dpr: includeDPR ? visibleDprRows(log, share, includeEnemyStats) : [],
      timeline: includeTimeline ? visibleTimeline(log, share, includeCorrections) : [],
      highlights: includeTimeline ? buildHighlights(log, share, includeEnemyStats, includeCorrections) : [],
      martialHighlights: includeTimeline ? martialHighlights(log, share, includeEnemyStats, includeCorrections) : [],
      magicHighlights: includeTimeline ? magicHighlights(log, share, includeEnemyStats, includeCorrections) : [],
      healingHighlights: includeTimeline ? healingHighlightsForReport(log, share, includeEnemyStats, includeCorrections) : [],
      controlHighlights: includeTimeline ? controlHighlights(log, share, includeEnemyStats, includeCorrections) : [],
      downedHighlights: includeTimeline ? downedHighlights(log, share, includeEnemyStats, includeCorrections) : [],
      heroMoments: sections.heroMoments ? heroMoments(log, share, includeEnemyStats, includeCorrections) : [],
      enemyPressure: sections.enemyPressure ? enemyPressure(log, share, includeCorrections) : [],
      tacticalTurningPoints: sections.tacticalTurningPoints ? tacticalTurningPoints(log, share, includeEnemyStats, includeCorrections) : [],
      supportSaves: sections.supportSaves ? supportSaves(log, share, includeEnemyStats, includeCorrections) : [],
      aftermath: sections.aftermath ? aftermath(log, share, includeEnemyStats) : [],
      contributions: buildContributions(log, share),
      spotlight: includeDPR ? buildSpotlight(log, share, includeEnemyStats) : [],
      warnings: share.includeUnclearEvents ? (stats?.warnings ?? []) : (stats?.warnings ?? []).filter((warning) => !String(warning).toLowerCase().includes("unclear")),
      shareMode: mode,
      sections
    };
  }

  renderMarkdown(report) {
    const lines = [
      `# ${report.title}`
    ];

    if (sectionEnabled(report, "combatRecap")) {
      lines.push("", "## Combat Recap", "", `- The party dealt ${report.summary.netDamageApplied} total damage over ${report.rounds} rounds.`, `- The party recovered ${report.summary.netHealingApplied} hit points during the fight.`, `- Party pace: ${report.summary.partyDPR} damage per round.`);
      if (report.summary.enemyDPR !== null) lines.push(`- Enemy pressure: ${report.summary.enemyDPR} damage per round.`);
      if (report.summary.unclassifiedDeltas !== null && report.summary.unclassifiedDeltas > 0) lines.push(`- ${report.summary.unclassifiedDeltas} unclear events were included for GM transparency.`);
    }

    if (sectionEnabled(report, "partyContributions") && report.contributions.length) {
      lines.push("", "## Party Contributions", "");
      for (const contribution of report.contributions) lines.push(`- ${contribution}`);
    }

    if (sectionEnabled(report, "martialHighlights") && report.martialHighlights.length) {
      lines.push("", "## Blades, Bows, and Close Calls", "");
      for (const highlight of report.martialHighlights) lines.push(`- ${highlight}`);
    }

    if (sectionEnabled(report, "spellwork") && report.magicHighlights.length) {
      lines.push("", "## Spellwork", "");
      for (const highlight of report.magicHighlights) lines.push(`- ${highlight}`);
    }

    if (sectionEnabled(report, "healingSupport") && report.healingHighlights.length) {
      lines.push("", "## Healing and Support", "");
      for (const highlight of report.healingHighlights) lines.push(`- ${highlight}`);
    }

    if (sectionEnabled(report, "controlPlays") && report.controlHighlights.length) {
      lines.push("", "## Control Plays", "");
      for (const highlight of report.controlHighlights) lines.push(`- ${highlight}`);
    }

    if (sectionEnabled(report, "closeCalls") && report.downedHighlights.length) {
      lines.push("", "## Close Calls", "");
      for (const highlight of report.downedHighlights) lines.push(`- ${highlight}`);
    }

    if (sectionEnabled(report, "damageSpotlight") && report.spotlight.length) {
      lines.push("", "## Damage Spotlight", "");
      for (const row of report.spotlight) lines.push(`- ${row}`);
    }

    if (sectionEnabled(report, "heroMoments") && report.heroMoments.length) {
      lines.push("", "## Hero Moments", "");
      for (const highlight of report.heroMoments) lines.push(`- ${highlight}`);
    }

    if (sectionEnabled(report, "enemyPressure") && report.enemyPressure.length) {
      lines.push("", "## Enemy Pressure", "");
      for (const highlight of report.enemyPressure) lines.push(`- ${highlight}`);
    }

    if (sectionEnabled(report, "tacticalTurningPoints") && report.tacticalTurningPoints.length) {
      lines.push("", "## Tactical Turning Points", "");
      for (const highlight of report.tacticalTurningPoints) lines.push(`- ${highlight}`);
    }

    if (sectionEnabled(report, "supportSaves") && report.supportSaves.length) {
      lines.push("", "## Support and Saves", "");
      for (const highlight of report.supportSaves) lines.push(`- ${highlight}`);
    }

    if (sectionEnabled(report, "aftermath") && report.aftermath.length) {
      lines.push("", "## Aftermath", "");
      for (const highlight of report.aftermath) lines.push(`- ${highlight}`);
    }

    return `${lines.join("\n")}\n`;
  }

  renderHtml(report) {
    const markdown = this.renderMarkdown(report);
    return markdownToHtml(markdown);
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
      userId: game?.user?.id ?? "",
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
    return JournalEntryClass.create({ name: report.title, pages: [page] });
  }
}

function visibleParticipants(log, share) {
  let enemyIndex = 0;
  return (log?.participants ?? [])
    .filter((participant) => share.includeHiddenCombatants || !participant.hidden)
    .filter((participant) => participant.side !== SIDES.HOSTILE || share.includeEnemyStats || share.includeNpcNames)
    .map((participant) => ({
      id: participant.combatantId,
      name: publicParticipantName(participant, share, () => ++enemyIndex),
      side: participant.side ?? SIDES.UNKNOWN,
      isPlayerOwned: Boolean(participant.isPlayerOwned)
    }));
}

function visibleDprRows(log, share, includeEnemyStats) {
  let enemyIndex = 0;
  return (log?.computed?.dpr?.byCombatant ?? [])
    .filter((row) => row.side !== SIDES.HOSTILE || includeEnemyStats)
    .map((row) => ({
      name: row.side === SIDES.HOSTILE ? publicEnemyName(row, share, () => ++enemyIndex) : row.name,
      side: row.side,
      damageAppliedNet: row.damageAppliedNet,
      netDPR: row.netDPR,
      unclearEvents: share.includeUnclearEvents ? row.unclearEvents : null
    }));
}

function visibleTimeline(log, share, includeCorrections) {
  return (log?.events ?? [])
    .filter((event) => !event.ignored)
    .filter((event) => event.visibility !== VISIBILITY.GM || canExposeGmOnlyEvent(event, share, includeCorrections))
    .filter((event) => ![EVENT_TYPES.GM_NOTE, EVENT_TYPES.GM_MARKER].includes(event.type))
    .filter((event) => share.includeUnclearEvents || event.confidence !== CONFIDENCE.UNCLEAR)
    .filter((event) => includeCorrections || !isCorrectionEvent(event))
    .map((event) => ({ id: event.id, label: `${event.round ? `Round ${event.round}: ` : ""}${event.type} (${event.confidence})` }));
}

function buildSpotlight(log, share, includeEnemyStats) {
  const rows = visibleDprRows(log, share, includeEnemyStats)
    .filter((row) => Number(row.damageAppliedNet) > 0)
    .sort((left, right) => Number(right.damageAppliedNet) - Number(left.damageAppliedNet))
    .slice(0, 5);
  return rows.map((row, index) => `${index + 1}. ${row.name}: ${row.damageAppliedNet} damage (${row.netDPR} DPR)`);
}

function buildHighlights(log, share, includeEnemyStats, includeCorrections) {
  const participants = participantNameMaps(log, share);
  const visibleEvents = visibleReportEvents(log, share, includeEnemyStats, includeCorrections, participants);

  const highlights = [];
  highlights.push(...aoeHighlights(visibleEvents, participants));
  highlights.push(...singleHitHighlights(visibleEvents, participants));
  highlights.push(...healingHighlights(visibleEvents, participants));
  highlights.push(...effectHighlights(visibleEvents, participants));
  return uniqueLines(highlights).slice(0, 8);
}

function buildContributions(log, share) {
  const participants = participantNameMaps(log, share);
  const dprRows = new Map((log?.computed?.dpr?.byCombatant ?? []).map((row) => [row.id, row]));
  return (log?.participants ?? [])
    .filter((participant) => participant.side === SIDES.FRIENDLY || participant.isPlayerOwned)
    .map((participant) => contributionLine(participant, participants, dprRows, log?.events ?? []));
}

function contributionLine(participant, participants, dprRows, events) {
  const row = dprRows.get(participant.combatantId) ?? {};
  const ownEvents = events.filter((event) => !event.ignored && event.combatantId === participant.combatantId);
  const damage = Number(row.damageAppliedNet ?? 0) || ownEvents.filter(isDamageEvent).reduce((total, event) => total + eventAmount(event), 0);
  const healing = ownEvents.filter(isHealingEvent).reduce((total, event) => total + eventAmount(event), 0);
  const martial = ownEvents.filter((event) => isDamageEvent(event) && isMartialAction(event)).length;
  const magic = ownEvents.filter((event) => isDamageEvent(event) && isMagicAction(event)).length;
  const control = ownEvents.filter(isControlEvent).length;
  const details = [];
  if (damage > 0) details.push(`${damage} damage`);
  if (healing > 0) details.push(`${healing} healing`);
  if (martial > 0) details.push(`${martial} martial moments`);
  if (magic > 0) details.push(`${magic} spell moments`);
  if (control > 0) details.push(`${control} control plays`);
  const publicName = participants.byCombatantId.get(participant.combatantId)?.publicName ?? participant.name;
  if (!details.length) return `${publicName} stayed in the fight and helped hold the line.`;
  return `${publicName}: ${details.join(", ")}.`;
}

function martialHighlights(log, share, includeEnemyStats, includeCorrections) {
  const participants = participantNameMaps(log, share);
  return visibleReportEvents(log, share, includeEnemyStats, includeCorrections, participants)
    .filter((event) => isDamageEvent(event) && isMartialAction(event))
    .map((event) => ({ event, amount: eventAmount(event), source: participantForEvent(event, participants), target: targetForEvent(event, participants) }))
    .filter((entry) => entry.amount > 0)
    .sort((left, right) => right.amount - left.amount)
    .slice(0, 3)
    .map((entry) => `Round ${entry.event.round}: ${entry.source?.publicName ?? "Someone"} pressured ${entry.target?.publicName ?? entry.event.data?.targetName ?? "a target"} with ${eventActionName(entry.event) || "a weapon attack"} for ${entry.amount} damage.`);
}

function magicHighlights(log, share, includeEnemyStats, includeCorrections) {
  const participants = participantNameMaps(log, share);
  const visibleEvents = visibleReportEvents(log, share, includeEnemyStats, includeCorrections, participants).filter((event) => isDamageEvent(event) && isMagicAction(event));
  return uniqueLines([...aoeHighlights(visibleEvents, participants), ...singleHitHighlights(visibleEvents, participants)]).slice(0, 5);
}

function healingHighlightsForReport(log, share, includeEnemyStats, includeCorrections) {
  const participants = participantNameMaps(log, share);
  return healingHighlights(visibleReportEvents(log, share, includeEnemyStats, includeCorrections, participants), participants).slice(0, 4);
}

function controlHighlights(log, share, includeEnemyStats, includeCorrections) {
  const participants = participantNameMaps(log, share);
  return visibleReportEvents(log, share, includeEnemyStats, includeCorrections, participants)
    .filter(isControlEvent)
    .slice(0, 5)
    .map((event) => `Round ${event.round}: ${participantForEvent(event, participants)?.publicName ?? "Someone"} shaped the battlefield with ${event.data?.name || eventActionName(event) || "control"}.`);
}

function downedHighlights(log, share, includeEnemyStats, includeCorrections) {
  const participants = participantNameMaps(log, share);
  return visibleReportEvents(log, share, includeEnemyStats, includeCorrections, participants)
    .filter(targetFellToZero)
    .map((event) => ({ event, target: targetForEvent(event, participants), source: participantForEvent(event, participants) }))
    .filter((entry) => entry.target?.side === SIDES.FRIENDLY || entry.target?.isPlayerOwned)
    .slice(0, 5)
    .map((entry) => `Round ${entry.event.round}: ${entry.target?.publicName ?? entry.event.data?.targetName ?? "A hero"} dropped to 0 HP after ${entry.source?.publicName ?? "the enemy"}'s ${eventActionName(entry.event) || "attack"}.`);
}

function heroMoments(log, share, includeEnemyStats, includeCorrections) {
  const participants = participantNameMaps(log, share);
  return visibleReportEvents(log, share, includeEnemyStats, includeCorrections, participants)
    .filter((event) => participantForEvent(event, participants)?.side === SIDES.FRIENDLY)
    .filter((event) => isDamageEvent(event) || isHealingEvent(event) || isControlEvent(event))
    .map((event) => heroMomentLine(event, participants))
    .filter(Boolean)
    .slice(0, 6);
}

function heroMomentLine(event, participants) {
  const source = participantForEvent(event, participants)?.publicName ?? "A hero";
  const target = targetForEvent(event, participants)?.publicName ?? event.data?.targetName ?? "the fight";
  const action = eventActionName(event) || event.data?.name || "a decisive action";
  const amount = eventAmount(event);
  if (isHealingEvent(event)) return `Round ${event.round}: ${source} kept ${target} standing with ${action}${amount ? ` for ${amount} HP` : ""}.`;
  if (isControlEvent(event)) return `Round ${event.round}: ${source} changed the board with ${action}.`;
  return `Round ${event.round}: ${source} landed ${action} against ${target}${amount ? ` for ${amount} damage` : ""}.`;
}

function enemyPressure(log, share, includeCorrections) {
  const enemyShare = { ...share, includeEnemyStats: true, includeNpcNames: true, anonymizeEnemies: false };
  const participants = participantNameMaps(log, enemyShare);
  return visibleReportEvents(log, enemyShare, true, includeCorrections, participants)
    .filter((event) => participantForEvent(event, participants)?.side === SIDES.HOSTILE)
    .filter((event) => isDamageEvent(event) || isControlEvent(event) || targetFellToZero(event))
    .map((event) => enemyPressureLine(event, participants))
    .filter(Boolean)
    .slice(0, 6);
}

function enemyPressureLine(event, participants) {
  const source = participantForEvent(event, participants)?.publicName ?? "The opposition";
  const target = targetForEvent(event, participants)?.publicName ?? event.data?.targetName ?? "the party";
  const action = eventActionName(event) || event.data?.name || "pressure";
  const amount = eventAmount(event);
  if (targetFellToZero(event)) return `Round ${event.round}: ${source} nearly swung the fight by dropping ${target} with ${action}.`;
  if (isControlEvent(event)) return `Round ${event.round}: ${source} disrupted the party with ${action}.`;
  return `Round ${event.round}: ${source} pressured ${target}${amount ? ` for ${amount} damage` : ""}.`;
}

function tacticalTurningPoints(log, share, includeEnemyStats, includeCorrections) {
  const participants = participantNameMaps(log, share);
  const events = visibleReportEvents(log, share, includeEnemyStats, includeCorrections, participants);
  const turns = [];
  turns.push(...events.filter(targetFellToZero).map((event) => ({ weight: 5, line: turningPointLine(event, participants, "downed") })));
  turns.push(...events.filter(isControlEvent).map((event) => ({ weight: 4, line: turningPointLine(event, participants, "control") })));
  turns.push(...events.filter(isHealingEvent).map((event) => ({ weight: 3, line: turningPointLine(event, participants, "healing") })));
  turns.push(...events.filter(isDamageEvent).filter((event) => eventAmount(event) > 0).map((event) => ({ weight: eventAmount(event), line: turningPointLine(event, participants, "damage") })));
  return uniqueLines(turns.sort((left, right) => right.weight - left.weight).map((entry) => entry.line)).slice(0, 6);
}

function turningPointLine(event, participants, kind) {
  const source = participantForEvent(event, participants)?.publicName ?? "Someone";
  const target = targetForEvent(event, participants)?.publicName ?? event.data?.targetName ?? "a target";
  const action = eventActionName(event) || event.data?.name || event.type;
  const amount = eventAmount(event);
  if (kind === "downed") return `Round ${event.round}: ${target} hit 0 HP after ${source}'s ${action}.`;
  if (kind === "control") return `Round ${event.round}: ${source}'s ${action} changed the tactical shape of the fight.`;
  if (kind === "healing") return `Round ${event.round}: ${source} restored momentum with ${amount} healing from ${action}.`;
  return `Round ${event.round}: ${source}'s ${action} created a ${amount}-damage swing against ${target}.`;
}

function supportSaves(log, share, includeEnemyStats, includeCorrections) {
  const participants = participantNameMaps(log, share);
  return visibleReportEvents(log, share, includeEnemyStats, includeCorrections, participants)
    .filter((event) => isHealingEvent(event) || isControlEvent(event))
    .map((event) => supportSaveLine(event, participants))
    .filter(Boolean)
    .slice(0, 6);
}

function supportSaveLine(event, participants) {
  const source = participantForEvent(event, participants)?.publicName ?? "Someone";
  const target = targetForEvent(event, participants)?.publicName ?? event.data?.targetName ?? "the party";
  const action = eventActionName(event) || event.data?.name || "support";
  const amount = eventAmount(event);
  if (isHealingEvent(event)) return `Round ${event.round}: ${source} supported ${target} with ${action}${amount ? ` for ${amount} HP` : ""}.`;
  return `Round ${event.round}: ${source} protected the party's tempo with ${action}.`;
}

function aftermath(log, share, includeEnemyStats) {
  const stats = log?.computed ?? {};
  const participants = visibleParticipants(log, { ...share, includeEnemyStats, includeNpcNames: includeEnemyStats });
  const lines = [];
  lines.push(`${participants.filter((participant) => participant.side === SIDES.FRIENDLY || participant.isPlayerOwned).length} player-side combatants were tracked in the report.`);
  lines.push(`The fight closed after ${stats?.summary?.rounds ?? 0} rounds with ${stats?.summary?.netDamageApplied ?? 0} net damage and ${stats?.summary?.netHealingApplied ?? 0} healing recorded.`);
  if (includeEnemyStats) lines.push(`${participants.filter((participant) => participant.side === SIDES.HOSTILE).length} hostile combatants are visible in this report.`);
  return lines;
}

function visibleReportEvents(log, share, includeEnemyStats, includeCorrections, participants = participantNameMaps(log, share)) {
  return (log?.events ?? [])
    .filter((event) => !event.ignored)
    .filter((event) => event.visibility !== VISIBILITY.GM || canExposeGmOnlyEvent(event, share, includeCorrections))
    .filter((event) => ![EVENT_TYPES.GM_NOTE, EVENT_TYPES.GM_MARKER].includes(event.type))
    .filter((event) => share.includeUnclearEvents || event.confidence !== CONFIDENCE.UNCLEAR)
    .filter((event) => includeCorrections || !isCorrectionEvent(event))
    .filter((event) => includeEnemyStats || eventSide(event, participants) !== SIDES.HOSTILE);
}

function participantNameMaps(log, share) {
  const byCombatantId = new Map();
  const byActorUuid = new Map();
  const byTokenUuid = new Map();
  let enemyIndex = 0;
  for (const participant of log?.participants ?? []) {
    const publicName = publicParticipantName(participant, share, () => ++enemyIndex);
    const row = { ...participant, publicName };
    if (participant.combatantId) byCombatantId.set(participant.combatantId, row);
    if (participant.actorUuid) byActorUuid.set(participant.actorUuid, row);
    if (participant.tokenUuid) byTokenUuid.set(participant.tokenUuid, row);
  }
  return { byCombatantId, byActorUuid, byTokenUuid };
}

function participantForEvent(event, participants) {
  return participants.byCombatantId.get(event.combatantId) ?? participants.byActorUuid.get(event.actorUuid) ?? participants.byTokenUuid.get(event.tokenUuid) ?? null;
}

function targetForEvent(event, participants) {
  return participants.byCombatantId.get(event.data?.targetCombatantId) ?? participants.byActorUuid.get(event.data?.targetActorUuid) ?? participants.byTokenUuid.get(event.data?.targetTokenUuid) ?? null;
}

function eventSide(event, participants) {
  return participantForEvent(event, participants)?.side ?? SIDES.UNKNOWN;
}

function aoeHighlights(events, participants) {
  const grouped = new Map();
  for (const event of events.filter((entry) => isDamageEvent(entry))) {
    const actionName = eventActionName(event);
    const key = `${event.round ?? ""}|${event.combatantId ?? ""}|${actionName}`;
    const group = grouped.get(key) ?? { round: event.round, source: participantForEvent(event, participants), actionName, total: 0, targets: new Set() };
    group.total += eventAmount(event);
    group.targets.add(targetForEvent(event, participants)?.publicName ?? event.data?.targetName ?? "a target");
    grouped.set(key, group);
  }
  return Array.from(grouped.values())
    .filter((group) => group.total > 0)
    .filter((group) => group.targets.size > 1 || /aoe|burst|wave|cone|ball|storm|cloud|guardians|sphere|blast|pulse/i.test(group.actionName))
    .sort((left, right) => right.total - left.total)
    .slice(0, 3)
    .map((group) => `Round ${group.round}: ${group.source?.publicName ?? "Someone"} hit ${group.targets.size} targets with ${group.actionName || "an area attack"} for ${group.total} total damage.`);
}

function singleHitHighlights(events, participants) {
  return events
    .filter((event) => isDamageEvent(event))
    .map((event) => ({ event, amount: eventAmount(event), source: participantForEvent(event, participants), target: targetForEvent(event, participants) }))
    .filter((entry) => entry.amount > 0)
    .sort((left, right) => right.amount - left.amount)
    .slice(0, 3)
    .map((entry) => `Round ${entry.event.round}: ${entry.source?.publicName ?? "Someone"} struck ${entry.target?.publicName ?? entry.event.data?.targetName ?? "a target"} with ${eventActionName(entry.event) || "an attack"} for ${entry.amount} damage.`);
}

function healingHighlights(events, participants) {
  return events
    .filter((event) => isHealingEvent(event))
    .map((event) => ({ event, amount: eventAmount(event), source: participantForEvent(event, participants), target: targetForEvent(event, participants) }))
    .filter((entry) => entry.amount > 0)
    .sort((left, right) => right.amount - left.amount)
    .slice(0, 2)
    .map((entry) => `Round ${entry.event.round}: ${entry.source?.publicName ?? "Someone"} restored ${entry.amount} HP to ${entry.target?.publicName ?? entry.event.data?.targetName ?? "an ally"} with ${eventActionName(entry.event) || "healing"}.`);
}

function effectHighlights(events, participants) {
  return events
    .filter((event) => [EVENT_TYPES.ACTIVE_EFFECT_CREATED, EVENT_TYPES.ACTIVE_EFFECT_DELETED].includes(event.type))
    .slice(0, 3)
    .map((event) => `Round ${event.round}: ${participantForEvent(event, participants)?.publicName ?? "Someone"} changed ${targetForEvent(event, participants)?.publicName ?? event.data?.targetName ?? "the battlefield"} with ${event.data?.name || eventActionName(event) || "an effect"}.`);
}

function uniqueLines(lines) {
  return Array.from(new Set(lines.filter(Boolean)));
}

function isDamageEvent(event) {
  return [EVENT_TYPES.DAMAGE_APPLIED, EVENT_TYPES.DAMAGE_MANUAL_ADDED, EVENT_TYPES.ROLL_DAMAGE].includes(event.type) || event.data?.interpretedAs === "damage";
}

function isHealingEvent(event) {
  return [EVENT_TYPES.HEALING_APPLIED, EVENT_TYPES.HEALING_MANUAL_ADDED, EVENT_TYPES.ROLL_HEALING].includes(event.type) || event.data?.interpretedAs === "healing";
}

function isControlEvent(event) {
  if ([EVENT_TYPES.ACTIVE_EFFECT_CREATED, EVENT_TYPES.ACTIVE_EFFECT_UPDATED, EVENT_TYPES.ACTIVE_EFFECT_DELETED].includes(event.type)) return true;
  return /control|stun|slow|prone|restrain|fear|fright|hex|pin|blind|charm|silence|web|hold|banish|bless|bane|paraly/i.test(`${eventActionName(event)} ${event?.data?.name ?? ""}`);
}

function isMagicAction(event) {
  if (isHealingEvent(event) || isControlEvent(event)) return false;
  return /spell|magic|fireball|bolt|shatter|cone|wave|burst|cloud|storm|spirit|sacred|radiant|necrotic|shadow|arcane|thunder|lightning|orb|missile|ray|hex|blight|guiding|burning|scorching|vitriolic|sphere|guardians/i.test(eventActionName(event));
}

function isMartialAction(event) {
  if (isMagicAction(event)) return false;
  return /sword|slash|strike|bow|crossbow|dagger|scimitar|bite|claw|bash|slam|charge|lunge|shot|cut|stab|rake|spear|pommel|shield|flourish|riposte|attack|weapon/i.test(eventActionName(event));
}

function eventAmount(event) {
  return Math.abs(Number(event?.data?.amount ?? event?.data?.delta ?? event?.data?.total ?? 0)) || 0;
}

function eventActionName(event) {
  return String(event?.data?.actionName ?? event?.data?.spellName ?? event?.data?.itemName ?? "").trim();
}

function targetFellToZero(event) {
  const values = [event?.data?.targetHpAfter, event?.data?.targetRemainingHp, event?.data?.newValue];
  return values.some((value) => Number(value) === 0) || Boolean(event?.data?.targetDowned);
}

function canExposeGmOnlyEvent(event, share, includeCorrections) {
  if (isRollEvent(event)) return Boolean(share.includePrivateRolls);
  if (isCorrectionEvent(event)) return Boolean(includeCorrections);
  return false;
}

export function normalizeReportSections(sections = null) {
  return { ...DEFAULT_REPORT_SECTIONS, ...(sections ?? {}) };
}

function hasAnyHighlightSection(sections) {
  return Boolean(sections.martialHighlights || sections.spellwork || sections.healingSupport || sections.controlPlays || sections.closeCalls || sections.heroMoments || sections.enemyPressure || sections.tacticalTurningPoints || sections.supportSaves);
}

function sectionEnabled(report, key) {
  return normalizeReportSections(report.sections)[key] !== false;
}

function isRollEvent(event) {
  return String(event.type).startsWith("roll.");
}

function isCorrectionEvent(event) {
  return String(event.type).includes("correct") || String(event.type).includes("manual");
}

function publicParticipantName(participant, share, nextEnemyIndex) {
  if (participant.side === SIDES.HOSTILE) return publicEnemyName(participant, share, nextEnemyIndex);
  return participant.name;
}

function publicEnemyName(row, share, nextEnemyIndex) {
  if (share.includeNpcNames || !share.anonymizeEnemies) return row.name;
  return `Enemy ${nextEnemyIndex()}`;
}

function markdownToHtml(markdown) {
  return markdown.split("\n").map((line) => {
    if (line.startsWith("# ")) return `<h1>${escapeHtml(line.slice(2))}</h1>`;
    if (line.startsWith("## ")) return `<h2>${escapeHtml(line.slice(3))}</h2>`;
    if (line.startsWith("- ")) return `<p>&bull; ${escapeHtml(line.slice(2))}</p>`;
    if (!line.trim()) return "";
    return `<p>${escapeHtml(line)}</p>`;
  }).join("\n");
}

export const __test__ = { normalizeReportSections, visibleParticipants, visibleDprRows, visibleTimeline, isCorrectionEvent };
