import { EVENT_TYPES, SOURCE_KINDS } from "../constants.js";
import { downloadData, formatDateTime } from "../utils.js";

export class CombatLogExportService {
  exportJson(log) {
    const filename = `${log.id}.json`;
    const data = JSON.stringify(log, null, 2);
    downloadData(filename, data, "application/json");
    return data;
  }

  exportMarkdown(log) {
    const stats = log.computed;
    const lines = [
      `# ${log.title}`,
      "",
      `Status: ${log.status}`,
      `Started: ${formatDateTime(log.startedAt)}`,
      log.endedAt ? `Ended: ${formatDateTime(log.endedAt)}` : "Ended: -",
      `Rounds: ${stats?.summary?.rounds ?? 0}`,
      `Participants: ${log.participants?.length ?? 0}`,
      "",
      "## Summary",
      "",
      `- Gross damage rolled: ${stats?.summary?.grossDamageRolled ?? 0}`,
      `- Gross damage applied: ${stats?.summary?.grossDamageApplied ?? 0}`,
      `- Net damage applied: ${stats?.summary?.netDamageApplied ?? 0}`,
      `- Damage corrections up: ${stats?.summary?.damageCorrectionsUp ?? 0}`,
      `- Damage corrections down: ${stats?.summary?.damageCorrectionsDown ?? 0}`,
      `- Net healing applied: ${stats?.summary?.netHealingApplied ?? 0}`,
      `- Party DPR: ${stats?.dpr?.partyDPR ?? 0}`,
      `- Enemy DPR: ${stats?.dpr?.enemyDPR ?? 0}`,
      "",
      "## Timeline",
      ""
    ];

    for (const event of log.events ?? []) lines.push(`- ${event.round ? `Round ${event.round}` : "Combat"}: ${event.type} (${event.confidence})`);
    const markdown = lines.join("\n");
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
      userId: game?.user?.id ?? "",
      visibility: "gm",
      source: { kind: SOURCE_KINDS.MANUAL, id: format },
      confidence: "manual",
      ignored: false,
      tags: ["export"],
      data: { format }
    });
  }
}
