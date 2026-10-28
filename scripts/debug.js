import { MODULE_ID, SETTINGS } from "./constants.js";
import { registerDebugMenu, registerDebugProvider } from "./debug-file.mjs";
import { getSetting } from "./settings.js";
import { format, isTrackingGM, localize } from "./utils.js";

// Combat Log & Stats in the shared debug file of Sephral's modules: a short summary of the logs and the log events a
// chat message led to. The detailed debug log of a fight (raw messages and hook calls) stays in the combat log window.
const COMBAT_DEBUG_LOG = "The detailed debug log of a fight is saved in the combat log window (GM).";
const INDEX_FIELDS = ["combatLogId", "combatId", "title", "status", "startedAt", "endedAt", "rounds", "participantCount", "isShared", "shareMode", "moduleVersion"];

function pick(source, keys) {
  return Object.fromEntries(keys.filter((key) => source?.[key] !== undefined).map((key) => [key, source[key]]));
}

// The stored logs as the index lists them, without the logs themselves.
export function storedLogs() {
  const logs = getSetting(SETTINGS.INDEX, { logs: [] })?.logs ?? [];
  return logs.map((entry) => ({ ...pick(entry, INDEX_FIELDS), inline: Boolean(entry.inlineLog), file: Boolean(entry.filePath) }));
}

export function activeLogs(service) {
  return (service?.listActiveLogs?.() ?? []).map((log) => ({
    id: log.id,
    combatId: log.combatId,
    status: log.status,
    events: log.events?.length ?? 0,
    participants: log.participants?.length ?? 0,
    startedAt: log.startedAt ?? null
  }));
}

// The events of the running logs that came from a chat message.
export function eventsForMessage(service, messageId) {
  const found = [];
  for (const log of service?.listActiveLogs?.() ?? []) {
    for (const event of log.events ?? []) {
      if (!messageId || event?.source?.id !== messageId) continue;
      found.push({
        logId: log.id,
        eventId: event.id,
        type: event.type,
        round: event.round ?? null,
        combatantId: event.combatantId || null,
        confidence: event.confidence ?? null,
        correlation: event.data?.correlation?.status ?? null,
        attribution: event.data?.attribution ?? null
      });
    }
  }
  return found;
}

export function describeRecent(service) {
  return {
    details: {
      combatDebugLog: COMBAT_DEBUG_LOG,
      trackingGM: isTrackingGM(),
      serviceReady: Boolean(service),
      activeLogs: activeLogs(service),
      storedLogs: storedLogs(),
      pendingSaves: service?.pendingSaves?.size ?? 0
    }
  };
}

// The service starts in "ready", the menu and the provider are registered in "init".
export function registerDebug(getService) {
  registerDebugMenu(MODULE_ID, { name: "SCLS.Debug.Title", label: "SCLS.Debug.Save", hint: "SCLS.Debug.Hint" });
  registerDebugProvider({
    moduleId: MODULE_ID,
    label: () => localize("SCLS.Debug.Entry"),
    notice: (file) => format("SCLS.Debug.Saved", { file }),
    applies: (message) => eventsForMessage(getService(), message?.id).length > 0,
    message: (message) => ({ combatDebugLog: COMBAT_DEBUG_LOG, events: eventsForMessage(getService(), message.id) }),
    recent: () => describeRecent(getService()),
    // The index holds whole logs, the summary above lists them
    omitSettings: [SETTINGS.INDEX]
  });
}
