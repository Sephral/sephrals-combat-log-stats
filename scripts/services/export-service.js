import { EVENT_TYPES, SIDES, SOURCE_KINDS } from "../constants.js";
import { downloadData, format, formatDateTime, localize } from "../utils.js";
import { actionName, eventAmount, isControl, isDamageApplied, isDowned, isHealingApplied } from "./event-insights.js";
import { controlSentence, damageSentence, downIncidents, downSentence, eventActors, formatNumber, healingSentence, roundLine } from "./player-report-service.js";

export class CombatLogExportService {
  exportJson(log) {
    const filename = `${log.id}.json`;
    const data = JSON.stringify(log, null, 2);
    downloadData(filename, data, "application/json");
    return data;
  }

  exportMarkdown(log) {
    const markdown = renderMarkdownExport(log);
    downloadData(`${log.id}.md`, markdown, "text/markdown");
    return markdown;
  }

  appendExportEvent(log, format) {
    log.events.push({
      id: `export-${Date.now()}`,
      type: EVENT_TYPES.EXPORT_CREATED,
      createdAt: new Date().toISOString(),
      sequence: (log.events?.length ?? 0) + 1,
      round: null,
      turn: null,
      combatantId: "",
      actorUuid: "",
      tokenUuid: "",
      sceneUuid: log.sceneUuid,
      userId: globalThis.game?.user?.id ?? "",
      visibility: "gm",
      source: { kind: SOURCE_KINDS.MANUAL, id: format },
      confidence: "manual",
      ignored: false,
      tags: ["export"],
      data: { format }
    });
  }
}

// Readable GM document: real names, hidden combatants marked, every recorded action.
function renderMarkdownExport(log) {
  const stats = log?.computed ?? {};
  const participants = new Map((log?.participants ?? []).filter((participant) => participant?.combatantId).map((participant) => [String(participant.combatantId), participant]));
  const events = (log?.events ?? []).filter((event) => event && !event.ignored);
  const downs = downIncidents(events);
  const sideOf = (id) => participants.get(id)?.side ?? SIDES.UNKNOWN;
  const startedAt = formatDateTime(log?.startedAt);

  const lines = [
    `# ${log?.title || localize("SCLS.Export.DefaultTitle")}`,
    "",
    `- ${format("SCLS.Export.Status", { status: labelFor("SCLS.Status", log?.status) })}`,
    `- ${format("SCLS.Export.Started", { date: startedAt || localize("SCLS.Export.Unknown") })}`,
    `- ${format("SCLS.Export.Ended", { date: log?.endedAt ? formatDateTime(log.endedAt) : localize("SCLS.Export.NotEnded") })}`,
    `- ${format("SCLS.Export.Rounds", { rounds: formatNumber(stats?.summary?.rounds) })}`
  ];

  if (participants.size) {
    lines.push("", `## ${localize("SCLS.Export.ParticipantsHeading")}`, "");
    for (const participant of participants.values()) {
      const data = { name: participant.name || localize("SCLS.Report.Fallback.Someone"), side: labelFor("SCLS.Side", participant.side ?? SIDES.UNKNOWN) };
      lines.push(`- ${format(participant.hidden ? "SCLS.Export.ParticipantHidden" : "SCLS.Export.Participant", data)}`);
    }
  }

  const unclear = Number(stats?.summary?.unclassifiedDeltas) || 0;
  lines.push(
    "",
    `## ${localize("SCLS.Export.SummaryHeading")}`,
    "",
    `- ${format("SCLS.Export.NetDamage", { value: formatNumber(stats?.summary?.netDamageApplied) })}`,
    `- ${format("SCLS.Export.NetHealing", { value: formatNumber(stats?.summary?.netHealingApplied) })}`,
    `- ${format("SCLS.Export.PartyDPR", { value: formatNumber(stats?.dpr?.partyDPR) })}`,
    `- ${format("SCLS.Export.EnemyDPR", { value: formatNumber(stats?.dpr?.enemyDPR) })}`,
    `- ${format("SCLS.Export.Defeated", { value: formatNumber(new Set(downs.filter((down) => sideOf(down.targetId) === SIDES.HOSTILE).map((down) => down.targetId)).size) })}`,
    `- ${format("SCLS.Export.PartyDown", { value: formatNumber(downs.filter((down) => sideOf(down.targetId) === SIDES.FRIENDLY).length) })}`
  );
  if (unclear > 0) lines.push(`- ${format("SCLS.Export.Unclear", { value: formatNumber(unclear) })}`);

  const actions = actionLines(events, participants);
  lines.push("", `## ${localize("SCLS.Export.ActionsHeading")}`, "");
  if (actions.length) lines.push(...actions.map((line) => `- ${line}`));
  else lines.push(localize("SCLS.Export.NoActions"));
  return `${lines.join("\n")}\n`;
}

// One line per damage, healing or control event, plus a line when someone drops to 0 HP.
function actionLines(events, participants) {
  const nameOf = (id, event, subject) => participants.get(id)?.name
    || (id && id === event?.data?.targetCombatantId ? event.data?.targetName : "")
    || localize(subject ? "SCLS.Report.Fallback.Someone" : "SCLS.Report.Fallback.Target");
  const seenDowns = new Set();
  const lines = [];
  for (const event of events) {
    const { sourceId, targetId } = eventActors(event);
    const source = sourceId ? nameOf(sourceId, event, true) : "";
    const amount = eventAmount(event);
    let text = "";
    if (isDamageApplied(event) && amount > 0) {
      text = damageSentence({ source, target: nameOf(targetId, event, !source), amount: formatNumber(amount), action: actionName(event) });
    } else if (isHealingApplied(event) && amount > 0) {
      text = healingSentence({ source, target: nameOf(targetId, event, !source), amount: formatNumber(amount), action: actionName(event) });
    } else if (isControl(event)) {
      text = controlSentence({ source, target: nameOf(targetId, event, !source), effect: String(event.data?.name ?? "").trim() || actionName(event) });
    }
    if (text) lines.push(roundLine(event.round, text));
    if (isDowned(event) && targetId) {
      const key = event.data?.duplicateOfEventId || event.id;
      if (key && seenDowns.has(key)) continue;
      if (key) seenDowns.add(key);
      lines.push(roundLine(event.round, downSentence({ target: nameOf(targetId, event, true) })));
    }
  }
  return lines;
}

function labelFor(prefix, value) {
  const key = `${prefix}.${value}`;
  const label = localize(key);
  return label === key ? String(value ?? "") : label;
}

export const __test__ = { renderMarkdownExport, actionLines };
