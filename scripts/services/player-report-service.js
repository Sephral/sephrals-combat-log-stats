import { CONFIDENCE, EVENT_TYPES, SETTINGS, SHARE_MODES, SIDES, SOURCE_KINDS, VISIBILITY } from "../constants.js";
import { getSetting } from "../settings.js";
import { escapeHtml, formatDateTime, isoNow } from "../utils.js";

const PLAYER_VISIBLE_MODES = new Set([
  SHARE_MODES.SUMMARY_ONLY,
  SHARE_MODES.PARTY_DPR_ONLY,
  SHARE_MODES.FULL_VISIBLE_DPR,
  SHARE_MODES.FULL_VISIBLE_RECAP,
  SHARE_MODES.PUBLIC_REPORT
]);

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
    const stats = log?.computed ?? {};
    const participants = visibleParticipants(log, share);
    const includeDPR = share.includeDPR && mode !== SHARE_MODES.SUMMARY_ONLY;
    const includeEnemyStats = share.includeEnemyStats && [SHARE_MODES.FULL_VISIBLE_DPR, SHARE_MODES.FULL_VISIBLE_RECAP, SHARE_MODES.PUBLIC_REPORT].includes(mode);
    const includeTimeline = share.includeTimeline && [SHARE_MODES.FULL_VISIBLE_RECAP, SHARE_MODES.PUBLIC_REPORT].includes(mode);
    const includeCorrections = share.includeCorrections && [SHARE_MODES.FULL_VISIBLE_RECAP, SHARE_MODES.PUBLIC_REPORT].includes(mode);

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
      warnings: share.includeUnclearEvents ? (stats?.warnings ?? []) : (stats?.warnings ?? []).filter((warning) => !String(warning).toLowerCase().includes("unclear")),
      shareMode: mode
    };
  }

  renderMarkdown(report) {
    const lines = [
      `# ${report.title}`,
      "",
      `Status: ${report.status}`,
      `Started: ${formatDateTime(report.startedAt)}`,
      `Ended: ${report.endedAt ? formatDateTime(report.endedAt) : "-"}`,
      `Rounds: ${report.rounds}`,
      "",
      "## Summary",
      "",
      `- Net damage applied: ${report.summary.netDamageApplied}`,
      `- Gross damage applied: ${report.summary.grossDamageApplied}`,
      `- Net healing applied: ${report.summary.netHealingApplied}`,
      `- Party DPR: ${report.summary.partyDPR}`
    ];

    if (report.summary.enemyDPR !== null) lines.push(`- Enemy DPR: ${report.summary.enemyDPR}`);
    if (report.summary.unclassifiedDeltas !== null) lines.push(`- Unclear deltas: ${report.summary.unclassifiedDeltas}`);

    if (report.participants.length) {
      lines.push("", "## Participants", "");
      for (const participant of report.participants) lines.push(`- ${participant.name} (${participant.side})`);
    }

    if (report.dpr.length) {
      lines.push("", "## DPR", "");
      for (const row of report.dpr) lines.push(`- ${row.name}: ${row.damageAppliedNet} net damage, ${row.netDPR} DPR`);
    }

    if (report.timeline.length) {
      lines.push("", "## Timeline", "");
      for (const event of report.timeline) lines.push(`- ${event.label}`);
    }

    if (report.warnings.length) {
      lines.push("", "## Notes", "");
      for (const warning of report.warnings) lines.push(`- ${warning}`);
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
    .filter((event) => share.includeGMNotes || ![EVENT_TYPES.GM_NOTE, EVENT_TYPES.GM_MARKER].includes(event.type))
    .filter((event) => share.includeUnclearEvents || event.confidence !== CONFIDENCE.UNCLEAR)
    .filter((event) => includeCorrections || !isCorrectionEvent(event))
    .map((event) => ({ id: event.id, label: `${event.round ? `Round ${event.round}: ` : ""}${event.type} (${event.confidence})` }));
}

function canExposeGmOnlyEvent(event, share, includeCorrections) {
  if (isRollEvent(event)) return Boolean(share.includePrivateRolls);
  if (isCorrectionEvent(event)) return Boolean(includeCorrections && share.includeGMNotes);
  return Boolean(share.includeGMNotes);
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

export const __test__ = { visibleParticipants, visibleDprRows, visibleTimeline, isCorrectionEvent };
