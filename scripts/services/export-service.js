import { EVENT_TYPES, SIDES, SOURCE_KINDS } from "../constants.js";
import { downloadData, format, formatDateTime, localize } from "../utils.js";
import { actionName, downState, eventAmount, isControl, isDamageApplied, isDowned, isHealingApplied, isMoraleEvent } from "./event-insights.js";
import { controlSentence, damageSentence, downIncidents, downSentence, eventActors, formatNumber, healingSentence, roundLine } from "./player-report-service.js";
import { CombatStatsService } from "./stats-service.js";
import { isCrucibleLog, termKey } from "./system-terms.js";

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

  exportCsv(log) {
    const csv = renderCsvExport(log);
    downloadData(`${log.id}.csv`, csv, "text/csv");
    return csv;
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
  const system = String(log?.systemId ?? "");

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
    `- ${format(termKey(system, "SCLS.Export.PartyDown"), { value: formatNumber(downs.filter((down) => sideOf(down.targetId) === SIDES.FRIENDLY).length) })}`
  );
  if (isCrucibleLog(system)) lines.push(`- ${format("SCLS.Export.MoraleDamage", { value: formatNumber(stats?.summary?.moraleDamageApplied) })}`);
  if (unclear > 0) lines.push(`- ${format(termKey(system, "SCLS.Export.Unclear"), { value: formatNumber(unclear) })}`);

  const rounds = roundRows(log);
  if (rounds.length) {
    lines.push("", `## ${localize("SCLS.Export.RoundsHeading")}`, "", localize("SCLS.Export.RoundsTable"), "| ---: | ---: | ---: |");
    for (const row of rounds) lines.push(`| ${formatNumber(row.round)} | ${formatNumber(row.partyDamage)} | ${formatNumber(row.enemyDamage)} |`);
  }

  const actions = actionLines(events, participants, system);
  lines.push("", `## ${localize("SCLS.Export.ActionsHeading")}`, "");
  if (actions.length) lines.push(...actions.map((line) => `- ${line}`));
  else lines.push(localize("SCLS.Export.NoActions"));
  return `${lines.join("\n")}\n`;
}

// Damage per round of the party and the enemies. Logs saved before 1.1 have no per round numbers stored.
function roundRows(log) {
  const stored = log?.computed?.byRound;
  const rows = Array.isArray(stored) ? stored : CombatStatsService.compute(log ?? {}, { defaultDprMethod: log?.computed?.dpr?.method }).byRound;
  return rows.some((row) => Number(row.partyDamage) || Number(row.enemyDamage)) ? rows : [];
}

// One line per damage, healing or control event, plus a line when someone drops to 0 HP (Crucible: a new state).
function actionLines(events, participants, system = "") {
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
    const pool = isMoraleEvent(event) ? "morale" : "";
    if (isDamageApplied(event) && amount > 0) {
      text = damageSentence({ source, target: nameOf(targetId, event, !source), amount: formatNumber(amount), action: actionName(event), pool });
    } else if (isHealingApplied(event) && amount > 0) {
      text = healingSentence({ source, target: nameOf(targetId, event, !source), amount: formatNumber(amount), action: actionName(event), pool, system });
    } else if (isControl(event)) {
      text = controlSentence({ source, target: nameOf(targetId, event, !source), effect: String(event.data?.name ?? "").trim() || actionName(event) });
    }
    if (text) lines.push(roundLine(event.round, text));
    if (isDowned(event) && targetId) {
      const key = event.data?.duplicateOfEventId || event.id;
      if (key && seenDowns.has(key)) continue;
      if (key) seenDowns.add(key);
      lines.push(roundLine(event.round, downSentence({ target: nameOf(targetId, event, true), state: downState(event) })));
    }
  }
  return lines;
}

// Columns of the CSV export, read from the computed per combatant statistics.
const CSV_COLUMNS = Object.freeze([
  { labelKey: "SCLS.Export.Csv.Name", text: (row) => row.name },
  { labelKey: "SCLS.Export.Csv.Side", text: (row) => labelFor("SCLS.Side", row.side ?? SIDES.UNKNOWN) },
  { labelKey: "SCLS.Export.Csv.DamageDealt", key: "damageAppliedNet" },
  { labelKey: "SCLS.Export.Csv.DamageRolled", key: "damageRolled" },
  { labelKey: "SCLS.Export.Csv.DamageTaken", key: "damageTakenNet" },
  { labelKey: "SCLS.Export.Csv.HealingDone", key: "healingNet" },
  { labelKey: "SCLS.Export.Csv.HealingReceived", key: "healingReceived" },
  { labelKey: "SCLS.Export.Csv.MeleeHits", key: "martial" },
  { labelKey: "SCLS.Export.Csv.RangedHits", key: "ranged" },
  { labelKey: "SCLS.Export.Csv.SpellHits", key: "magic" },
  { labelKey: "SCLS.Export.Csv.Control", key: "control" },
  { labelKey: "SCLS.Export.Csv.Crits", key: "crits" },
  { labelKey: "SCLS.Export.Csv.Fumbles", key: "fumbles" },
  { labelKey: "SCLS.Export.Csv.Downed", key: "downed" },
  { labelKey: "SCLS.Export.Csv.Takedowns", key: "takedowns" },
  { labelKey: "SCLS.Export.Csv.DPR", key: "netDPR" }
]);

// Crucible logs add the morale numbers after the damage columns.
const CRUCIBLE_CSV_COLUMNS = Object.freeze([
  { labelKey: "SCLS.Export.Csv.MoraleDealt", key: "moraleDamageDealt" },
  { labelKey: "SCLS.Export.Csv.MoraleTaken", key: "moraleDamageTaken" }
]);

function csvColumns(log) {
  if (!isCrucibleLog(log)) return CSV_COLUMNS;
  const index = CSV_COLUMNS.findIndex((column) => column.key === "damageTakenNet") + 1;
  return [...CSV_COLUMNS.slice(0, index), ...CRUCIBLE_CSV_COLUMNS, ...CSV_COLUMNS.slice(index)];
}

// One row per combatant for spreadsheets: comma separated, CRLF line ends and a byte order mark, so Excel reads umlauts as UTF-8.
function renderCsvExport(log) {
  const participants = new Map((log?.participants ?? []).map((participant) => [String(participant?.combatantId ?? ""), participant]));
  const rows = (log?.computed?.byCombatant ?? log?.computed?.dpr?.byCombatant ?? []).map((row) => ({
    ...row,
    name: row.name || participants.get(String(row.id))?.name || String(row.id ?? ""),
    side: row.side ?? participants.get(String(row.id))?.side
  }));
  const columns = csvColumns(log);
  const lines = [
    columns.map((column) => csvCell(localize(column.labelKey))),
    ...rows.map((row) => columns.map((column) => (column.text ? csvCell(String(column.text(row) ?? "")) : String(Number(row[column.key]) || 0))))
  ];
  return `\uFEFF${lines.map((cells) => cells.join(",")).join("\r\n")}\r\n`;
}

// Quotes text cells that need it. Spreadsheets run cells starting with = + - @ as formulas, and names come from players.
function csvCell(text) {
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) || safe !== safe.trim() ? `"${safe.replaceAll("\"", "\"\"")}"` : safe;
}

function labelFor(prefix, value) {
  const key = `${prefix}.${value}`;
  const label = localize(key);
  return label === key ? String(value ?? "") : label;
}

export const __test__ = { renderMarkdownExport, actionLines, renderCsvExport, csvCell };
