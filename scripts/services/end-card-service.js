import { END_CARD_MODES, MODULE_ID, SETTINGS, SIDES } from "../constants.js";
import { getSetting } from "../settings.js";
import { escapeHtml, format, formatDuration, localize } from "../utils.js";
import { fightSpan } from "./session-service.js";
import { formatNumber } from "./player-report-service.js";
import { playerViewLog } from "./player-view-service.js";
import { termKey } from "./system-terms.js";

// The short card at the end of a fight: rounds, top damage, critical hits and fumbles, who went down, healing.
// The numbers come from the computed log. For everyone they come from the player view of the log, so the card tells
// what the player report of that fight would tell and nothing more (hidden combatants, enemy numbers, GM notes).

const MAX_NAMES = 4;

/**
 * The facts of the card, from the numbers of a log (log.computed) or of its player view. The card is about the party:
 * top damage, critical hits, fumbles and healing count the party's side, so the GM card and the player card read alike.
 * @returns {{rounds: number, durationMs: number, top: {name: string, amount: number}|null, crits: number, fumbles: number,
 *   downed: string[], downedCount: number, defeated: number, healing: number, quiet: boolean}}
 */
export function endCardData(computed = {}, { durationMs = 0 } = {}) {
  const rows = (computed.byCombatant ?? []).filter((row) => row && row.side !== SIDES.HOSTILE);
  const summary = computed.summary ?? {};
  const damaging = rows.filter((row) => Number(row.damageAppliedNet) > 0)
    .sort((left, right) => (Number(right.damageAppliedNet) - Number(left.damageAppliedNet)) || String(left.name).localeCompare(String(right.name)));
  const top = damaging[0] ? { name: String(damaging[0].name ?? ""), amount: Math.round(Number(damaging[0].damageAppliedNet) * 100) / 100 } : null;
  const sum = (field) => rows.reduce((total, row) => total + (Number(row[field]) || 0), 0);
  // Everyone who is not an enemy: combatants without a token have no disposition and count with the party.
  const party = rows.filter((row) => Number(row.downed) > 0);
  // The side rows credit healing without a known source to the side that must have given it.
  const healing = (computed.bySide ?? []).filter((row) => row && row.id !== SIDES.HOSTILE).reduce((total, row) => total + (Number(row.healingNet) || 0), 0);
  const data = {
    rounds: Math.max(1, Number(summary.rounds) || 1),
    durationMs: Number(durationMs) || 0,
    top,
    crits: sum("crits"),
    fumbles: sum("fumbles"),
    downed: party.map((row) => String(row.name ?? "")).filter(Boolean),
    downedCount: party.reduce((total, row) => total + Number(row.downed), 0),
    defeated: Number(summary.enemiesDefeated) || 0,
    healing: Math.round(healing * 100) / 100
  };
  data.quiet = !data.top && !data.crits && !data.fumbles && !data.downedCount && !data.defeated && !data.healing;
  return data;
}

// A fight nobody played (a combat started and ended at once) gets no card.
export function worthACard(data) {
  return !(data.quiet && data.rounds <= 1);
}

/** The lines of the card as plain texts, in reading order. */
export function endCardLines(data, systemId = "") {
  const lines = [];
  lines.push(format(data.durationMs > 0 ? "SCLS.EndCard.RoundsTime" : "SCLS.EndCard.Rounds", { rounds: countText("SCLS.Count.Rounds", data.rounds), time: formatDuration(data.durationMs) }));
  if (data.quiet) {
    lines.push(localize("SCLS.EndCard.Quiet"));
    return lines;
  }
  if (data.top) lines.push(format("SCLS.EndCard.TopDamage", { name: data.top.name, amount: formatNumber(data.top.amount) }));
  const luck = [];
  if (data.crits > 0) luck.push(plural(data.crits, "SCLS.EndCard.CritOne", "SCLS.EndCard.CritOther"));
  if (data.fumbles > 0) luck.push(plural(data.fumbles, "SCLS.EndCard.FumbleOne", "SCLS.EndCard.FumbleOther"));
  if (luck.length) lines.push(luck.join(", "));
  if (data.downed.length) {
    const shown = data.downed.slice(0, MAX_NAMES);
    const more = data.downed.length - shown.length;
    lines.push(format(termKey(systemId, "SCLS.EndCard.PartyDown"), { names: shown.join(", ") + (more > 0 ? format("SCLS.EndCard.More", { count: more }) : "") }));
  }
  if (data.defeated > 0) lines.push(plural(data.defeated, "SCLS.EndCard.DefeatedOne", "SCLS.EndCard.DefeatedOther"));
  if (data.healing > 0) lines.push(format(termKey(systemId, "SCLS.EndCard.Healing"), { healing: formatNumber(data.healing) }));
  return lines;
}

/** The chat card: title, the lines and a button that opens the full report (wired in scls.js). */
export function renderEndCardHtml(data, { title = "", logId = "", systemId = "" } = {}) {
  const items = endCardLines(data, systemId).map((line) => `<li>${escapeHtml(line)}</li>`).join("");
  const heading = escapeHtml(title ? format("SCLS.EndCard.Title", { title }) : localize("SCLS.EndCard.TitlePlain"));
  const button = logId
    ? `<button type="button" class="scls-endcard__open" data-scls-log-id="${escapeHtml(logId)}"><i class="fa-solid fa-chart-line" inert></i> ${escapeHtml(localize("SCLS.EndCard.Open"))}</button>`
    : "";
  return `<div class="scls-endcard"><h3 class="scls-endcard__title">${heading}</h3><ul>${items}</ul>${button}</div>`;
}

/**
 * Posts the card for an ended fight. The audience follows the setting; "everyone" falls back to a GM whisper while
 * player reports are off. Returns the chat message, or null when no card is due.
 * @param {object} log        The ended combat log (with computed numbers)
 * @param {object} [options]  statsOptions for the player view
 */
export async function postEndCard(log, { statsOptions = {}, mode = getSetting(SETTINGS.END_CARD_MODE, END_CARD_MODES.GM) } = {}) {
  const ChatMessageClass = globalThis.ChatMessage;
  if (!log || mode === END_CARD_MODES.OFF || typeof ChatMessageClass?.create !== "function") return null;
  const everyone = mode === END_CARD_MODES.EVERYONE && getSetting(SETTINGS.ENABLE_PLAYER_SHARING, true) !== false;
  const source = everyone ? playerViewLog(log, { statsOptions }) : log;
  const span = fightSpan(log);
  const data = endCardData(source?.computed ?? {}, { durationMs: span?.durationMs ?? 0 });
  if (!worthACard(data)) return null;
  const whisper = everyone ? [] : (ChatMessageClass.getWhisperRecipients?.("GM") ?? []).map((user) => user.id);
  return ChatMessageClass.create({
    content: renderEndCardHtml(data, { title: log.title, logId: log.id, systemId: log.systemId }),
    speaker: { alias: globalThis.game?.modules?.get?.(MODULE_ID)?.title ?? "Combat Log & Stats" },
    whisper,
    flags: { [MODULE_ID]: { endCard: { logId: log.id, audience: everyone ? "everyone" : "gm" } } }
  });
}

function countText(key, count) {
  return Number(count) === 1 ? localize(`${key}One`) : format(`${key}Other`, { count: formatNumber(count) });
}

function plural(count, oneKey, otherKey) {
  return format(Number(count) === 1 ? oneKey : otherKey, { count: formatNumber(count) });
}

export const __test__ = { MAX_NAMES };
