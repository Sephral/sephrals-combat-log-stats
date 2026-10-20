import { MODULE_ID } from "../constants.js";

// A debug log for bug reports: the recorded combat, the raw chat messages of the fight and the hook calls the
// recording GM saw, in the order they arrived. Chat text is included, so the file is for the GM only.
const TRACE_LIMIT = 600;
const MESSAGE_LIMIT = 400;
const MESSAGE_MARGIN_MS = 60000;

export class DebugTrace {
  constructor(limit = TRACE_LIMIT) {
    this.limit = limit;
    this.entries = [];
  }

  add(hook, data = {}) {
    this.entries.push({ at: new Date().toISOString(), hook, ...data });
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit);
  }

  clear() {
    this.entries = [];
  }
}

export function messageTrace(message, changed = null) {
  return {
    messageId: message?.id ?? "",
    speaker: { actor: message?.speaker?.actor ?? "", token: message?.speaker?.token ?? "", alias: message?.speaker?.alias ?? "" },
    rollCount: Array.from(message?.rolls ?? []).length,
    flagScopes: Object.keys(message?.flags ?? {}),
    changedKeys: changed ? Object.keys(changed) : undefined
  };
}

// The option keys tell which automation applied the damage (dnd5e tray, midi-qol, a macro).
export function applicationTrace(actor, application = {}, options = {}) {
  return {
    actorUuid: actor?.uuid ?? "",
    amount: application.amount ?? null,
    messageId: application.message?.id ?? "",
    via: application.via || undefined,
    sourceActorUuid: application.sourceActorUuid ?? "",
    optionKeys: Object.keys(options ?? {}),
    midi: options?.midi ? pick(options.midi, ["sourceActorUuid", "targetUuid", "itemType", "isHit", "isCritical", "saved"]) : undefined,
    midiKeys: options?.midi ? Object.keys(options.midi) : undefined
  };
}

export function actorTrace(actor, changed = {}, options = {}, userId = "") {
  return {
    actorUuid: actor?.uuid ?? "",
    name: actor?.name ?? "",
    userId,
    changedSystem: changed?.system ?? null,
    optionKeys: Object.keys(options ?? {})
  };
}

// Messages from shortly before the start until shortly after the end of the combat.
export function messagesForLog(log, messages = [], { limit = MESSAGE_LIMIT, now = Date.now() } = {}) {
  const start = new Date(log?.startedAt ?? 0).getTime() - MESSAGE_MARGIN_MS;
  const end = (log?.endedAt ? new Date(log.endedAt).getTime() : now) + MESSAGE_MARGIN_MS;
  return Array.from(messages)
    .filter((message) => {
      const time = Number(message?.timestamp ?? message?._source?.timestamp ?? 0);
      return Number.isFinite(time) && time >= start && time <= end;
    })
    .slice(-limit)
    .map((message) => typeof message?.toObject === "function" ? message.toObject() : message);
}

export function buildDebugLog({ log, messages = [], trace = [], environment = {}, combat = null, now = Date.now() }) {
  return {
    createdAt: new Date(now).toISOString(),
    environment,
    combat,
    log,
    trace,
    messages: messagesForLog(log, messages, { now })
  };
}

export function collectEnvironment() {
  const game = globalThis.game;
  const activeModules = Array.from(game?.modules ?? []).filter((module) => module?.active).map((module) => `${module.id}@${module.version ?? ""}`);
  return {
    foundry: game?.version ?? game?.release?.version ?? "",
    system: `${game?.system?.id ?? ""}@${game?.system?.version ?? ""}`,
    module: game?.modules?.get?.(MODULE_ID)?.version ?? "",
    userId: game?.user?.id ?? "",
    activeGMs: Array.from(game?.users ?? []).filter((user) => user?.isGM && user?.active).map((user) => user.id),
    activeModules
  };
}

function pick(source, keys) {
  return Object.fromEntries(keys.filter((key) => source?.[key] !== undefined).map((key) => [key, source[key]]));
}

export const __test__ = { messagesForLog, buildDebugLog, DebugTrace };
