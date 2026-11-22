import { CONFIDENCE, END_CARD_MODES, MODULE_ID, RESOURCE_POOLS, SETTINGS, SHARE_MODES, SIDES } from "../constants.js";
import { getSetting } from "../settings.js";
import { escapeHtml, format, formatDuration, localize } from "../utils.js";
import { actionName, eventAmount, isDamageDealt, isDowned, isHealingApplied, isResourceDelta, isUndone, reversedCardMessageIds, sourceCombatantId, targetCombatantId } from "./event-insights.js";
import { fightSpan } from "./session-service.js";
import { ACTION_DETAIL_MODES, formatNumber } from "./player-report-service.js";
import { playerShareSettings, playerViewLog, SHAREABLE_MODES } from "./player-view-service.js";
import { termKey } from "./system-terms.js";
import { roundStories, storyHighlights } from "./round-story.js";
import { countRoundStory } from "./story-usage.js";

// The short card at the end of a fight: rounds, top damage, critical hits and fumbles, who went down, healing.
// The numbers come from the computed log. For everyone they come from the player view of the log, so the card tells
// what the player report of that fight would tell and nothing more (hidden combatants, enemy numbers, GM notes).

const MAX_NAMES = 4;
// A hero who stayed up counts as a close call below this share of the maximum hit points (when the maximum is known).
const CLOSE_CALL_RATIO = 0.35;
const HEALTH_PATH = /(^|\.)(hp|health)\.value$/;

/**
 * The two highlights that need single events: the biggest single hit of the party and the closest call of a hero.
 * Works on the events and participants of a log or of its player view, so hidden combatants and whispered actions
 * never get in. Every part may be missing (no attacker known, no hit point changes recorded).
 * @returns {{biggestHit: {name: string, amount: number, action: string}|null,
 *   closeCall: {name: string, kind: "back"|"low", hp?: number}|null}}
 */
export function endCardHighlights(events = [], participants = [], { maxHp = () => null } = {}) {
  const byId = new Map((participants ?? []).filter(Boolean).map((entry) => [String(entry.combatantId ?? ""), entry]));
  const isParty = (id) => byId.has(id) && byId.get(id).side !== SIDES.HOSTILE;
  const undone = reversedCardMessageIds(events ?? []);
  let biggest = null;
  const state = new Map();
  const entryOf = (id) => {
    if (!state.has(id)) state.set(id, { down: false, back: false, lowest: null });
    return state.get(id);
  };
  for (const event of events ?? []) {
    if (!event || event.ignored || event.data?.reversed) continue;
    const trusted = event.confidence !== CONFIDENCE.UNCLEAR;
    // Biggest single hit by a party member, health only (the morale part of a hit is the same hit).
    if (trusted && isDamageDealt(event) && !event.data?.secondary && !isUndone(event, undone) && event.data?.pool !== RESOURCE_POOLS.MORALE) {
      const source = sourceCombatantId(event);
      const amount = eventAmount(event);
      if (isParty(source) && amount > 0 && (!biggest || amount > biggest.amount)) {
        biggest = { name: String(byId.get(source).name ?? ""), amount: Math.round(amount * 100) / 100, action: actionName(event) };
      }
    }
    const target = targetCombatantId(event);
    if (!isParty(target)) continue;
    const hero = entryOf(target);
    const healthChange = isResourceDelta(event) && event.data?.pool !== RESOURCE_POOLS.MORALE && HEALTH_PATH.test(String(event.data?.resourcePath ?? ""));
    if (isDowned(event)) hero.down = true;
    else if (hero.down && (isHealingApplied(event) || (healthChange && Number(event.data?.delta) > 0))) hero.back = true;
    if (healthChange && Number(event.data?.delta) < 0) {
      const value = Number(event.data?.newValue);
      if (Number.isFinite(value) && value > 0 && (hero.lowest === null || value < hero.lowest)) hero.lowest = value;
    }
  }
  let closeCall = null;
  for (const [id, hero] of state) {
    const name = String(byId.get(id)?.name ?? "");
    if (!name) continue;
    if (hero.down && hero.back) {
      closeCall = { name, kind: "back" };
      break;
    }
    const max = Number(maxHp(id));
    if (hero.lowest !== null && max > 0 && hero.lowest / max <= CLOSE_CALL_RATIO && (!closeCall || hero.lowest < closeCall.hp)) {
      closeCall = { name, kind: "low", hp: hero.lowest };
    }
  }
  return { biggestHit: biggest, closeCall };
}

/**
 * The facts of the card, from the numbers of a log (log.computed) or of its player view. The card is about the party:
 * top damage, critical hits, fumbles and healing count the party's side, so the GM card and the player card read alike.
 * @returns {{rounds: number, durationMs: number, top: {name: string, amount: number}|null, crits: number, fumbles: number,
 *   downed: string[], downedCount: number, defeated: number, healing: number, quiet: boolean}}
 */
export function endCardData(computed = {}, { durationMs = 0, highlights = null, story = [] } = {}) {
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
    healing: Math.round(healing * 100) / 100,
    biggestHit: highlights?.biggestHit ?? null,
    closeCall: highlights?.closeCall ?? null,
    // The most notable rounds as sentences (see round-story.js), empty when the card does not tell the course
    story: Array.isArray(story) ? story : []
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
  if (data.biggestHit) {
    const hit = data.biggestHit;
    lines.push(format(hit.action ? "SCLS.EndCard.BiggestHitWith" : "SCLS.EndCard.BiggestHit", { name: hit.name, amount: formatNumber(hit.amount), action: hit.action }));
  }
  const luck = [];
  if (data.crits > 0) luck.push(plural(data.crits, "SCLS.EndCard.CritOne", "SCLS.EndCard.CritOther"));
  if (data.fumbles > 0) luck.push(plural(data.fumbles, "SCLS.EndCard.FumbleOne", "SCLS.EndCard.FumbleOther"));
  if (luck.length) lines.push(luck.join(", "));
  if (data.downed.length) {
    const shown = data.downed.slice(0, MAX_NAMES);
    const more = data.downed.length - shown.length;
    lines.push(format(termKey(systemId, "SCLS.EndCard.PartyDown"), { names: shown.join(", ") + (more > 0 ? format("SCLS.EndCard.More", { count: more }) : "") }));
  }
  if (data.closeCall) {
    const call = data.closeCall;
    lines.push(call.kind === "back"
      ? format(termKey(systemId, "SCLS.EndCard.CloseBack"), { name: call.name })
      : format(termKey(systemId, "SCLS.EndCard.CloseLow"), { name: call.name, hp: formatNumber(call.hp) }));
  }
  if (data.defeated > 0) lines.push(plural(data.defeated, "SCLS.EndCard.DefeatedOne", "SCLS.EndCard.DefeatedOther"));
  if (data.healing > 0) lines.push(format(termKey(systemId, "SCLS.EndCard.Healing"), { healing: formatNumber(data.healing) }));
  return lines;
}

/**
 * The chat card: title, the lines and a button that opens the full report (wired in scls.js). The GM card also
 * offers to share it with the players.
 */
export function renderEndCardHtml(data, { title = "", logId = "", systemId = "", shareable = false, shared = false, outside = 0 } = {}) {
  const lines = endCardLines(data, systemId).map((line) => `<li>${escapeHtml(line)}</li>`);
  // The log outside of combat is for the GM: only the whispered card tells about it, and opens it.
  const outsideCount = shareable ? Math.max(0, Math.floor(Number(outside) || 0)) : 0;
  if (outsideCount > 0) {
    const text = escapeHtml(plural(outsideCount, "SCLS.EndCard.OutsideOne", "SCLS.EndCard.OutsideOther"));
    lines.push(`<li class="scls-endcard__outside"><button type="button" class="scls-endcard__outside-open" data-scls-log-id="${escapeHtml(logId)}" title="${escapeHtml(localize("SCLS.EndCard.OutsideOpen"))}">${text} <i class="fa-solid fa-arrow-up-right-from-square" inert></i></button></li>`);
  }
  if (data.story?.length && !data.quiet) {
    const rows = data.story.map((entry) => `<li>${escapeHtml(entry.text)}</li>`).join("");
    lines.push(`<li class="scls-endcard__story"><strong>${escapeHtml(localize("SCLS.EndCard.Story"))}</strong><ul>${rows}</ul></li>`);
  }
  const items = lines.join("");
  const heading = escapeHtml(title ? format("SCLS.EndCard.Title", { title }) : localize("SCLS.EndCard.TitlePlain"));
  const open = logId
    ? `<button type="button" class="scls-endcard__open" data-scls-log-id="${escapeHtml(logId)}"><i class="fa-solid fa-chart-line" inert></i> ${escapeHtml(localize("SCLS.EndCard.Open"))}</button>`
    : "";
  const share = shareable && logId
    ? `<button type="button" class="scls-endcard__share" data-scls-log-id="${escapeHtml(logId)}"${shared ? " disabled" : ""}><i class="fa-solid fa-share-nodes" inert></i> ${escapeHtml(localize(shared ? "SCLS.EndCard.Shared" : "SCLS.EndCard.Share"))}</button>`
    : "";
  const buttons = open || share ? `<div class="scls-endcard__buttons">${open}${share}</div>` : "";
  return `<div class="scls-endcard"><h3 class="scls-endcard__title">${heading}</h3><ul>${items}</ul>${buttons}${logId ? shareImageButtonsHtml(logId) : ""}</div>`;
}

// Copy, save and post the fight as a picture (wired in scls.js). The picture follows the sharing choices of the fight,
// whoever clicks: it never tells more than the card for everyone.
export function shareImageButtonsHtml(logId) {
  const id = escapeHtml(logId);
  const button = (kind, icon, key) => `<button type="button" class="scls-endcard__image scls-endcard__image--${kind}" data-scls-image="${kind}" data-scls-log-id="${id}" title="${escapeHtml(localize(`${key}Hint`))}"><i class="fa-solid ${icon}" inert></i> ${escapeHtml(localize(key))}</button>`;
  return `<div class="scls-endcard__images">${button("copy", "fa-copy", "SCLS.ShareImage.Copy")}${button("save", "fa-download", "SCLS.ShareImage.Save")}${button("post", "fa-image", "SCLS.ShareImage.Post")}</div>`;
}

/**
 * What the card tells, for the GM (the whole log) or for everyone (the player view of the log: the sharing choices of
 * that fight, nothing the player report would hide).
 */
export function buildEndCard(log, { statsOptions = {}, everyone = false, countStory = true } = {}) {
  const share = everyone ? playerShareSettings(log) : null;
  const source = everyone ? playerViewLog(log, { statsOptions, share }) : log;
  const span = fightSpan(log);
  // Single events (biggest hit, close call) are action detail: players get them where their report names single actions.
  const detail = !everyone || ACTION_DETAIL_MODES.has(share.shareMode);
  const maxOf = new Map((log.participants ?? []).map((entry) => [String(entry.combatantId ?? ""), Number(entry.finalResources?.["system.attributes.hp.max"])]));
  const highlights = detail ? endCardHighlights(source?.events ?? [], source?.participants ?? [], { maxHp: (id) => maxOf.get(id) ?? null }) : null;
  // The course of the fight: sentences by the same rules as the player view of this fight (single actions only where
  // the share mode names them, enemy numbers only where they are shared).
  let story = [];
  if (getSetting(SETTINGS.ROUND_STORY, true) !== false && getSetting(SETTINGS.ROUND_STORY_CARD, true) !== false) {
    story = storyHighlights(roundStories(source?.events ?? [], source?.participants ?? [], { detail, enemyAmounts: !everyone || share.enemyStats, seed: log.id }));
    if (story.length && countStory) countRoundStory(log.id);
  }
  return endCardData(source?.computed ?? {}, { durationMs: span?.durationMs ?? 0, highlights, story });
}

function playersMayBeTold() {
  return getSetting(SETTINGS.ENABLE_PLAYER_SHARING, true) !== false;
}

function speaker() {
  return { alias: globalThis.game?.modules?.get?.(MODULE_ID)?.title ?? "Combat Log & Stats" };
}

/**
 * Posts the card for an ended fight. The audience follows the setting; "everyone" falls back to a GM whisper while
 * player reports are off. The GM card carries a button to share it. Returns the chat message, or null when no card is due.
 * @param {object} log        The ended combat log (with computed numbers)
 * @param {object} [options]  statsOptions for the player view; outside: entries of the log outside combat tonight (GM card only)
 */
export async function postEndCard(log, { statsOptions = {}, outside = 0, mode = getSetting(SETTINGS.END_CARD_MODE, END_CARD_MODES.GM) } = {}) {
  const ChatMessageClass = globalThis.ChatMessage;
  if (!log || mode === END_CARD_MODES.OFF || typeof ChatMessageClass?.create !== "function") return null;
  const everyone = mode === END_CARD_MODES.EVERYONE && playersMayBeTold();
  const data = buildEndCard(log, { statsOptions, everyone });
  if (!worthACard(data)) return null;
  const whisper = everyone ? [] : (ChatMessageClass.getWhisperRecipients?.("GM") ?? []).map((user) => user.id);
  return ChatMessageClass.create({
    content: renderEndCardHtml(data, { title: log.title, logId: log.id, systemId: log.systemId, shareable: !everyone, outside }),
    speaker: speaker(),
    whisper,
    flags: { [MODULE_ID]: { endCard: { logId: log.id, audience: everyone ? "everyone" : "gm" } } }
  });
}

/** What the GM may share of a fight whose sharing was never chosen: a summary or the full recap. */
export const SHARE_CHOICES = Object.freeze({ SUMMARY: "summary", RECAP: "recap" });
const CHOICE_MODES = Object.freeze({ [SHARE_CHOICES.SUMMARY]: SHARE_MODES.SUMMARY_ONLY, [SHARE_CHOICES.RECAP]: SHARE_MODES.FULL_VISIBLE_RECAP });

/**
 * A fight that still is on "GM only" (no report detail saved and none as the module default) has no sharing choice
 * the card could follow. The GM is asked what to share. Every other fight shares with the detail it already has.
 */
export function needsShareChoice(log) {
  if (SHAREABLE_MODES.includes(log?.shareSettings?.shareMode)) return false;
  return !SHAREABLE_MODES.includes(getSetting(SETTINGS.DEFAULT_SHARE_MODE));
}

/**
 * Writes the GM's choice into the sharing settings of the fight, so the player view, the player reports and the cards
 * of that fight tell what was shared and nothing more. Enemy numbers, enemy names and hidden combatants keep what the
 * fight had (by default: no numbers, anonymous, no hidden ones). Changes the log, saving it is up to the caller.
 * @returns {object|null} the new share settings, null for an unknown choice
 */
export function applyShareChoice(log, choice, now = new Date().toISOString()) {
  const shareMode = CHOICE_MODES[choice];
  if (!log || !shareMode) return null;
  const share = log.shareSettings ?? {};
  const anonymizeEnemies = typeof share.anonymizeEnemies === "boolean" ? share.anonymizeEnemies : getSetting(SETTINGS.DEFAULT_ANONYMIZE_ENEMIES, true) !== false;
  log.shareSettings = {
    ...share,
    isShared: true,
    shareMode,
    includePartyStats: true,
    includeEnemyStats: Boolean(share.includeEnemyStats),
    anonymizeEnemies,
    includeNpcNames: !anonymizeEnemies,
    includeHiddenCombatants: Boolean(share.includeHiddenCombatants),
    includePrivateRolls: false,
    includeGMNotes: false,
    includeUnclearEvents: false,
    includeDPR: true,
    includeTimeline: true,
    includeCorrections: false,
    allowPlayersToOpenReport: true,
    shareStartedAt: share.shareStartedAt ?? now,
    shareUpdatedAt: now
  };
  return log.shareSettings;
}

/** The two lines of the choice dialog: value, label key and hint key, the summary first (preselected). */
export function shareChoiceOptions() {
  return [
    { value: SHARE_CHOICES.SUMMARY, label: "SCLS.EndCard.ChoiceSummary", hint: "SCLS.EndCard.ChoiceSummaryHint" },
    { value: SHARE_CHOICES.RECAP, label: "SCLS.EndCard.ChoiceRecap", hint: "SCLS.EndCard.ChoiceRecapHint" }
  ];
}

export function shareChoiceHtml() {
  const rows = shareChoiceOptions().map((option, index) => `<label class="scls-share-choice"><input type="radio" name="choice" value="${option.value}"${index === 0 ? " checked" : ""}><span><strong>${escapeHtml(localize(option.label))}</strong><br><small>${escapeHtml(localize(option.hint))}</small></span></label>`).join("");
  // A div: DialogV2 wraps the content in its own form, and a form inside a form is dropped by the browser.
  return `<div class="scls-share-choices"><p>${escapeHtml(localize("SCLS.EndCard.ChoiceIntro"))}</p>${rows}</div>`;
}

/**
 * The GM shares a whispered card: the same card, public, with the numbers of the player view. Null while player
 * reports are off. choice (summary or recap) is for a fight with no sharing chosen yet: it is written to the sharing
 * settings of the log first (the caller saves the log), so the card and every later report of the fight agree.
 */
export async function shareEndCard(log, { statsOptions = {}, choice = null } = {}) {
  const ChatMessageClass = globalThis.ChatMessage;
  if (!log || !playersMayBeTold() || typeof ChatMessageClass?.create !== "function") return null;
  if (choice && !applyShareChoice(log, choice)) return null;
  const data = buildEndCard(log, { statsOptions, everyone: true });
  return ChatMessageClass.create({
    content: renderEndCardHtml(data, { title: log.title, logId: log.id, systemId: log.systemId }),
    speaker: speaker(),
    whisper: [],
    flags: { [MODULE_ID]: { endCard: { logId: log.id, audience: "everyone", sharedByGm: true, ...(choice ? { choice } : {}) } } }
  });
}

function countText(key, count) {
  return Number(count) === 1 ? localize(`${key}One`) : format(`${key}Other`, { count: formatNumber(count) });
}

function plural(count, oneKey, otherKey) {
  return format(Number(count) === 1 ? oneKey : otherKey, { count: formatNumber(count) });
}

export const __test__ = { MAX_NAMES };
