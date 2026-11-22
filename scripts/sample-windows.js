// Sample windows (api.samples, contract in samples.mjs): the combat log window and the chat cards of the module filled
// with made-up fights, so translators and testers see every text in its place without playing a fight first. Nothing
// here writes: the sample store holds the fights in memory, every button that would change, post or export something
// only says that it does nothing, no usage counter counts.
import { CONFIDENCE, EVENT_TYPES, LOG_STATUS, MODULE_ID, RESOURCE_INTERPRETATIONS, SCHEMA_VERSION, SEGMENT_REASONS, SHARE_MODES, SIDES, TABS, VISIBILITY } from "./constants.js";
import { CombatLogApp } from "./apps/combat-log-app.js";
import { defaultShareSettings } from "./models/combat-log.js";
import { CombatStatsService } from "./services/stats-service.js";
import { CombatLogPersistenceService } from "./services/persistence-service.js";
import { buildEndCard, renderEndCardHtml, shareChoiceHtml } from "./services/end-card-service.js";
import { PlayerReportService } from "./services/player-report-service.js";
import { groupSessions, renderSessionHtml, sessionDiscordMessages, sessionReport, sessionTitle, summarizeFights } from "./services/session-service.js";
import { playerViewLog } from "./services/player-view-service.js";
import { renderMarkdownExport } from "./services/export-service.js";
import { renderShareImage } from "./services/share-image.js";
import { KINDS } from "./services/offcombat-log.js";
import { cloneData, escapeHtml, format, localize } from "./utils.js";
import { markSample, openSampleChat, openSampleDialog, openSampleHtml, openSampleText, sampleActions, sampleBlocked, sampleCast, sampleId, sampleText } from "./samples.mjs";

// Ids of the sample fights start with this; the round story counter skips them (story-usage.js).
export const SAMPLE_PREFIX = "scls-sample";
const HP = "system.attributes.hp.value";
const MINUTE = 60 * 1000;
// Actions of the log window that only look: switch a tab, open a fight or a session, sort, scroll.
const LOOKING = ["switchTab", "openLog", "selectSession", "sortDpr", "showOutside"];

/* -------------------------------------------- */
/*  The sample fights                           */
/* -------------------------------------------- */

/**
 * A fight from a compact script. Steps: [round, actor id, kind, target id, amount, action key, extra].
 * kind: hit (attack roll and damage), miss, crit, fumble, heal, spell (damage without attack roll), cond, uncond.
 */
function buildFight({ id, title, startedAt, castIds, steps, extra = [], share = {} }) {
  const cast = sampleCast().filter((member) => castIds.includes(member.id));
  const participants = cast.map((member, index) => ({
    combatantId: `${id}-${member.id}`,
    actorUuid: "",
    tokenUuid: "",
    actorId: member.id,
    tokenId: member.id,
    actorLink: member.side === "party",
    name: member.name,
    img: member.img,
    disposition: member.side === "party" ? 1 : -1,
    hidden: false,
    isPlayerOwned: member.side === "party",
    isNpc: member.side !== "party",
    initiative: 20 - index * 2,
    side: member.side === "party" ? SIDES.FRIENDLY : SIDES.HOSTILE,
    initialResources: { [HP]: member.hp, "system.attributes.hp.max": member.hp, "system.attributes.hp.temp": 0 },
    finalResources: null
  }));
  const cid = (member) => `${id}-${member}`;
  const hp = new Map(cast.map((member) => [member.id, member.hp]));
  const events = [];
  let clock = new Date(startedAt).getTime();
  const push = (type, data = {}, more = {}) => {
    clock += 20 * 1000;
    events.push({
      id: `${id}-e${events.length + 1}`,
      type,
      createdAt: new Date(clock).toISOString(),
      sequence: events.length + 1,
      round: more.round ?? null,
      turn: more.turn ?? null,
      combatantId: more.combatantId ?? "",
      actorUuid: "",
      tokenUuid: "",
      sceneUuid: "",
      userId: "",
      visibility: more.visibility ?? VISIBILITY.PUBLIC,
      source: { kind: more.kind ?? "systemAdapter", id: more.sourceId ?? "" },
      confidence: more.confidence ?? CONFIDENCE.SAFE,
      ignored: Boolean(more.ignored),
      tags: more.tags ?? [],
      data
    });
    return events.at(-1);
  };
  // A roll and the hit point change it led to: the change names the roll, so the log shows the action once.
  const roll = (type, data, more) => push(type, data, { ...more, kind: "roll", sourceId: `${id}-m${events.length + 1}` });
  push(EVENT_TYPES.COMBAT_STARTED, {}, { round: 0 });
  let round = 0;
  let turn = 0;
  const change = (step, actor, target, amount, interpretedAs, action, kind, rolled = null) => {
    const old = hp.get(target);
    const max = cast.find((member) => member.id === target)?.hp ?? old;
    const next = interpretedAs === RESOURCE_INTERPRETATIONS.DAMAGE ? Math.max(0, old - amount) : Math.min(max, old + amount);
    hp.set(target, next);
    push(EVENT_TYPES.RESOURCE_DELTA, {
      resourcePath: HP,
      oldValue: old,
      newValue: next,
      delta: next - old,
      interpretedAs,
      attribution: "systemApplied",
      sourceCombatantId: cid(actor),
      targetCombatantId: cid(target),
      actionName: action ? sampleText(action) : "",
      actionKind: kind,
      ...(rolled ? { correlation: { status: "correlated", confidence: CONFIDENCE.SAFE, rollEventId: rolled.id, messageId: rolled.source.id } } : {}),
      ...(interpretedAs === RESOURCE_INTERPRETATIONS.DAMAGE ? { targetDowned: old > 0 && next === 0 } : {})
    }, { round: step, combatantId: cid(actor) });
  };
  for (const [step, actor, kind, target, amount = 0, action = "", more = {}] of steps) {
    if (step !== round) {
      round = step;
      turn = 0;
      push(EVENT_TYPES.ROUND_CHANGED, { oldValue: round - 1, newValue: round }, { round });
    }
    if (more.turn !== false) push(EVENT_TYPES.TURN_CHANGED, { oldValue: turn, newValue: turn + 1, combatantId: cid(actor) }, { round, turn: turn++, combatantId: cid(actor) });
    const actionKind = more.actionKind ?? (["fireBolt", "cureWounds", "sacredFlame"].includes(action) ? "spell" : action === "shortbow" ? "ranged" : "melee");
    const actionName = action ? sampleText(action) : "";
    if (["hit", "miss", "crit", "fumble"].includes(kind)) {
      const natural = kind === "crit" ? 20 : kind === "fumble" ? 1 : kind === "miss" ? 6 : more.natural ?? 14;
      roll(EVENT_TYPES.ROLL_ATTACK, { actionName, actionKind, formula: "1d20 + 6", total: natural + 6, isCritical: kind === "crit", isFumble: kind === "fumble", dice: [{ faces: 20, results: [natural] }], targetCombatantIds: [cid(target)] }, { round, combatantId: cid(actor) });
      if (kind === "hit" || kind === "crit") {
        const rolled = roll(EVENT_TYPES.ROLL_DAMAGE, { actionName, actionKind, formula: kind === "crit" ? "2d8 + 4" : "1d8 + 4", total: amount, dice: [{ faces: 8, results: [Math.max(1, amount - 4)] }] }, { round, combatantId: cid(actor) });
        change(round, actor, target, amount, RESOURCE_INTERPRETATIONS.DAMAGE, action, actionKind, rolled);
      }
    } else if (kind === "spell") {
      roll(EVENT_TYPES.ROLL_DAMAGE, { actionName, actionKind, formula: "2d10", total: amount, dice: [{ faces: 10, results: [Math.ceil(amount / 2), Math.floor(amount / 2)] }] }, { round, combatantId: cid(actor) });
      change(round, actor, target, amount, RESOURCE_INTERPRETATIONS.DAMAGE, action, actionKind);
    } else if (kind === "heal") {
      const rolled = roll(EVENT_TYPES.ROLL_HEALING, { actionName, actionKind, formula: "1d8 + 4", total: amount, dice: [{ faces: 8, results: [Math.max(1, amount - 4)] }] }, { round, combatantId: cid(actor) });
      change(round, actor, target, amount, RESOURCE_INTERPRETATIONS.HEALING, action, actionKind, rolled);
    } else if (kind === "cond" || kind === "uncond") {
      push(kind === "cond" ? EVENT_TYPES.ACTIVE_EFFECT_CREATED : EVENT_TYPES.ACTIVE_EFFECT_DELETED, {
        name: sampleText("prone"), statuses: ["prone"], control: kind === "cond", automatic: false,
        sourceCombatantId: cid(actor), targetCombatantId: cid(target), actionName
      }, { round, combatantId: cid(target) });
    }
  }
  for (const make of extra) make({ push, cid, hp, round });
  push(EVENT_TYPES.COMBAT_ENDED, { reason: SEGMENT_REASONS.COMBAT_ENDED }, { round });
  const endedAt = new Date(clock + MINUTE).toISOString();
  for (const participant of participants) participant.finalResources = { ...participant.initialResources, [HP]: hp.get(participant.actorId) };
  const initialSnapshots = Object.fromEntries(participants.map((participant) => [participant.combatantId, cloneData(participant.initialResources)]));
  return {
    schemaVersion: SCHEMA_VERSION,
    moduleVersion: game.modules.get(MODULE_ID)?.version ?? "0.0.0",
    id,
    worldId: game.world?.id ?? "",
    systemId: "dnd5e",
    foundryVersion: game.version ?? "",
    combatId: id,
    combatUuid: "",
    sceneUuid: "",
    title,
    status: LOG_STATUS.ENDED,
    createdAt: startedAt,
    startedAt,
    endedAt,
    lastSeenAt: endedAt,
    sessionSegments: [{ id: `${id}-s1`, startedAt, endedAt, reason: SEGMENT_REASONS.COMBAT_STARTED, endReason: SEGMENT_REASONS.COMBAT_ENDED }],
    participants,
    initialSnapshots,
    latestSnapshots: Object.fromEntries(participants.map((participant) => [participant.combatantId, cloneData(participant.finalResources)])),
    events,
    manualOverrides: [],
    shareSettings: { ...defaultShareSettings(), ...share },
    computed: null
  };
}

/** Changes the GM may look at in Corrections: no known source, unclear, set aside, added by hand. */
function correctionEvents({ push, cid, hp }) {
  const old = hp.get("troll");
  hp.set("troll", old - 4);
  push(EVENT_TYPES.RESOURCE_DELTA, { resourcePath: HP, oldValue: old, newValue: old - 4, delta: -4, interpretedAs: RESOURCE_INTERPRETATIONS.DAMAGE, targetCombatantId: cid("troll") }, { round: 2, combatantId: cid("troll"), confidence: CONFIDENCE.PROBABLE, kind: "actorUpdate" });
  push(EVENT_TYPES.RESOURCE_DELTA, { resourcePath: "system.attributes.hp.temp", oldValue: 0, newValue: 5, delta: 5, interpretedAs: RESOURCE_INTERPRETATIONS.UNKNOWN }, { round: 3, combatantId: cid("tovin"), confidence: CONFIDENCE.UNCLEAR, kind: "actorUpdate" });
  push(EVENT_TYPES.RESOURCE_DELTA, { resourcePath: HP, oldValue: 30, newValue: 26, delta: -4, interpretedAs: RESOURCE_INTERPRETATIONS.DAMAGE, targetCombatantId: cid("ari"), notes: "Counted twice" }, { round: 1, combatantId: cid("ari"), confidence: CONFIDENCE.PROBABLE, ignored: true, kind: "actorUpdate" });
  push(EVENT_TYPES.DAMAGE_MANUAL_ADDED, { amount: 3, targetCombatantId: cid("troll"), note: sampleText("longsword"), manualCorrection: true }, { round: 3, combatantId: cid("ari"), confidence: CONFIDENCE.MANUAL, kind: "manual", visibility: VISIBILITY.GM });
}

/** The fights: tonight at the old mill (the full one), earlier tonight on the road, and one from last week. */
export function sampleFights(now = Date.now()) {
  const tonight = now - 150 * MINUTE;
  const mill = buildFight({
    id: `${SAMPLE_PREFIX}-mill`,
    title: sampleText("place"),
    startedAt: new Date(tonight + 70 * MINUTE).toISOString(),
    castIds: ["ari", "mira", "tovin", "sela", "troll", "bandit1", "bandit2", "wolf"],
    share: { isShared: true, shareMode: SHARE_MODES.FULL_VISIBLE_RECAP, includeTimeline: true, allowPlayersToOpenReport: true, shareStartedAt: new Date(now).toISOString(), shareUpdatedAt: new Date(now).toISOString() },
    steps: [
      [1, "ari", "hit", "bandit1", 11, "longsword"],
      [1, "bandit1", "miss", "ari", 0, "club"],
      [1, "mira", "crit", "troll", 18, "fireBolt"],
      [1, "troll", "hit", "ari", 14, "club"],
      [1, "tovin", "heal", "ari", 9, "cureWounds"],
      [1, "wolf", "hit", "sela", 7, "bite"],
      [1, "wolf", "cond", "sela", 0, "bite", { turn: false }],
      [1, "sela", "fumble", "wolf", 0, "shortbow"],
      [1, "bandit2", "hit", "mira", 6, "club"],
      [2, "ari", "hit", "bandit1", 9, "longsword"],
      [2, "mira", "hit", "troll", 10, "fireBolt"],
      [2, "troll", "crit", "ari", 25, "club"],
      [2, "tovin", "spell", "wolf", 8, "sacredFlame"],
      [2, "wolf", "hit", "sela", 6, "bite"],
      [2, "sela", "hit", "wolf", 9, "shortbow"],
      [2, "sela", "uncond", "sela", 0, "", { turn: false }],
      [2, "bandit2", "hit", "mira", 7, "club"],
      [3, "ari", "hit", "troll", 13, "longsword"],
      [3, "mira", "hit", "bandit2", 12, "fireBolt"],
      [3, "troll", "hit", "mira", 17, "club"],
      [3, "tovin", "heal", "mira", 8, "cureWounds"],
      [3, "wolf", "hit", "ari", 5, "bite"],
      [3, "sela", "hit", "wolf", 7, "shortbow"],
      [3, "bandit2", "miss", "ari", 0, "club"],
      [4, "ari", "crit", "troll", 22, "longsword"],
      [4, "mira", "hit", "troll", 11, "fireBolt"],
      [4, "troll", "hit", "tovin", 12, "club"],
      [4, "tovin", "spell", "bandit2", 6, "sacredFlame"],
      [4, "sela", "hit", "troll", 10, "shortbow"]
    ],
    extra: [correctionEvents]
  });
  const road = buildFight({
    id: `${SAMPLE_PREFIX}-road`,
    title: `${sampleText("place")} (2)`,
    startedAt: new Date(tonight).toISOString(),
    castIds: ["ari", "mira", "tovin", "sela", "wolf", "bandit1"],
    share: { isShared: true, shareMode: SHARE_MODES.SUMMARY_ONLY },
    steps: [
      [1, "sela", "hit", "wolf", 9, "shortbow"],
      [1, "wolf", "hit", "ari", 6, "bite"],
      [1, "ari", "hit", "wolf", 12, "longsword"],
      [1, "bandit1", "miss", "mira", 0, "club"],
      [1, "mira", "hit", "bandit1", 10, "fireBolt"],
      [2, "tovin", "heal", "ari", 6, "cureWounds"],
      [2, "wolf", "miss", "sela", 0, "bite"],
      [2, "sela", "hit", "wolf", 8, "shortbow"],
      [2, "ari", "hit", "bandit1", 9, "longsword"]
    ]
  });
  const lastWeek = buildFight({
    id: `${SAMPLE_PREFIX}-week`,
    title: `${sampleText("place")} (1)`,
    startedAt: new Date(now - 7 * 24 * 60 * MINUTE).toISOString(),
    castIds: ["ari", "mira", "tovin", "sela", "bandit1", "bandit2"],
    steps: [
      [1, "ari", "hit", "bandit1", 10, "longsword"],
      [1, "bandit1", "hit", "ari", 5, "club"],
      [1, "mira", "hit", "bandit2", 11, "fireBolt"],
      [1, "bandit2", "miss", "sela", 0, "club"],
      [2, "sela", "crit", "bandit1", 14, "shortbow"],
      [2, "tovin", "spell", "bandit2", 9, "sacredFlame"]
    ]
  });
  return [mill, road, lastWeek];
}

/** What happened between the fights tonight (the log outside combat): hit points, a condition, a rest. */
export function sampleOffCombat(now = Date.now()) {
  const cast = new Map(sampleCast().map((member) => [member.id, member]));
  const at = (minutes) => now - minutes * MINUTE;
  const hero = (id) => ({ i: id, n: cast.get(id).name, p: 1 });
  const events = [
    { t: at(140), k: KINDS.HP, ...hero("sela"), q: "hp", d: -5, v: 27, m: 32 },
    { t: at(110), k: KINDS.COND, ...hero("mira"), c: sampleText("prone"), s: 1 },
    { t: at(105), k: KINDS.COND, ...hero("mira"), c: sampleText("prone"), s: -1 },
    { t: at(100), k: KINDS.REST, ...hero("ari"), r: "short", d: 11 },
    { t: at(95), k: KINDS.HP, ...hero("tovin"), q: "hp", d: 6, v: 36, m: 36, c: 2 },
    { t: at(20), k: KINDS.DOWN, ...hero("mira"), q: "hp" },
    { t: at(10), k: KINDS.REST, ...hero("mira"), r: "long", d: 28 }
  ];
  return { v: 1, nights: [{ id: `n${at(150).toString(36)}`, from: at(140), to: at(10), dropped: 0, events }] };
}

/* -------------------------------------------- */
/*  A store that only reads                     */
/* -------------------------------------------- */

class SamplePersistence extends CombatLogPersistenceService {
  constructor(logs) {
    super();
    this.storeCache = { schemaVersion: SCHEMA_VERSION, updatedAt: new Date().toISOString(), logs: cloneData(logs) };
  }

  invalidate() {}

  async loadStore() {
    return cloneData(this.storeCache);
  }

  async pruneIndexByRetention(index) {
    return index;
  }

  async saveIndex() {
    sampleBlocked();
    return null;
  }

  async saveStore() {
    sampleBlocked();
    return false;
  }

  async saveLog() {
    sampleBlocked();
    return null;
  }

  async deleteLog() {
    sampleBlocked();
    return false;
  }
}

/** The parts of the combat log service the window reads, over the sample fights. Writes say that they do nothing. */
export function sampleService(real = null, now = Date.now()) {
  const persistence = new SamplePersistence(sampleFights(now));
  const offState = sampleOffCombat(now);
  const statsOptions = () => real?.statsOptions?.() ?? {};
  const getLog = async (logId) => {
    const log = await persistence.loadLog(logId);
    if (log) log.computed = CombatStatsService.compute(log, statsOptions());
    return log;
  };
  return {
    isSample: true,
    persistence,
    offCombat: { snapshotState: async () => cloneData(offState), store: { invalidate() {} }, flush: async () => {} },
    getLog,
    statsOptions,
    listActiveLogs: () => [],
    flushPendingSaves: async () => {},
    saveAndCompute: async () => sampleBlocked(),
    setEventSource: () => null,
    addManualAdjustment: () => null,
    deleteLog: async () => {
      sampleBlocked();
      return false;
    },
    debugLog: (log) => ({ log })
  };
}

/* -------------------------------------------- */
/*  The windows                                 */
/* -------------------------------------------- */

/** The combat log window over the sample store. A player view shows what players see of the shared fight. */
class SampleCombatLogApp extends CombatLogApp {
  constructor(service, logId, { player = false, tab = null, key = "log" } = {}) {
    super(service, logId, { id: sampleId(MODULE_ID, key), actions: sampleActions(CombatLogApp, LOOKING) });
    this.player = player;
    if (tab) this.activeTab = tab;
    markSample(this);
  }

  get readOnly() {
    return this.player;
  }

  // Nothing here is changed: corrections, sides and sources say so.
  canEdit() {
    sampleBlocked();
    return false;
  }
}

async function openLogWindow(real, { tab, player = false, logId = `${SAMPLE_PREFIX}-mill` }) {
  const key = `${player ? "player" : "gm"}-${tab}`;
  const appId = sampleId(MODULE_ID, key);
  await foundry.applications.instances.get(appId)?.close({ animate: false });
  const app = new SampleCombatLogApp(sampleService(real), ["history", "sessions"].includes(tab) ? null : logId, { player, tab, key });
  await app.render({ force: true });
  return app;
}

async function sampleLog(real, id = `${SAMPLE_PREFIX}-mill`) {
  return sampleService(real).getLog(id);
}

function tabLabel(tab) {
  const key = `SCLS.Tab.${tab}`;
  const text = localize(key);
  return text === key ? tab : text;
}

/**
 * The sample windows of the module (api.samples).
 * @param {object|null} real   the combat log service, for the current stats settings
 * @returns {{id: string, label: string, group: string, open: () => Promise<object>}[]}
 */
export function sampleWindows(real = null) {
  const title = localize("SCLS.App.Title");
  const reports = new PlayerReportService();
  const entries = TABS.map((tab) => ({
    id: `gm-${tab}`,
    group: title,
    label: `${title}: ${tabLabel(tab)}`,
    open: () => openLogWindow(real, { tab })
  }));
  for (const tab of ["history", "summary", "timeline", "statistics"]) {
    entries.push({
      id: `player-${tab}`,
      group: title,
      label: `${title}: ${tabLabel(tab)} (${localize("SCLS.Sample.PlayerView")})`,
      open: () => openLogWindow(real, { tab, player: true })
    });
  }
  // Cards, texts and questions are built again on every render, so they follow the translations while one types.
  const chat = (id, label, content, options = {}) => entries.push({
    id, label, group: localize("SCLS.Sample.Chat"),
    open: () => openSampleChat({ moduleId: MODULE_ID, id, title: label, content, ...options })
  });
  const text = (id, label, build) => entries.push({
    id, label, group: localize("SCLS.Sample.Texts"),
    open: () => openSampleText({ moduleId: MODULE_ID, id, title: label, text: build })
  });
  // questions as the real dialogs, their buttons only say that they do nothing
  const question = (id, label, content, buttons, width = 440) => entries.push({
    id, label, group: localize("SCLS.Sample.Questions"),
    open: () => openSampleDialog({ moduleId: MODULE_ID, id, title: label, content, buttons: buttons(), width })
  });
  chat("end-card-gm", localize("SCLS.Sample.EndCardGm"), async () => {
    const log = await sampleLog(real);
    return renderEndCardHtml(buildEndCard(log, { statsOptions: real?.statsOptions?.() ?? {}, countStory: false }), { title: log.title, logId: log.id, systemId: log.systemId, shareable: true, outside: 4 });
  }, { whisper: [game.user.id] });
  chat("end-card-everyone", localize("SCLS.Sample.EndCardEveryone"), async () => {
    const log = await sampleLog(real);
    return renderEndCardHtml(buildEndCard(log, { statsOptions: real?.statsOptions?.() ?? {}, everyone: true, countStory: false }), { title: log.title, logId: log.id, systemId: log.systemId });
  });
  chat("player-report", localize("SCLS.Sample.PlayerReport"), async () => reports.renderHtml(reports.buildReport(await sampleLog(real))));
  chat("session-report", localize("SCLS.Sample.SessionReport"), async () => renderSessionHtml(await sessionReportFor(real)));
  text("discord-report", localize("SCLS.Sample.DiscordReport"), async () => reports.discordMessages(await sampleLog(real)).join("\n\n"));
  text("discord-session", localize("SCLS.Sample.DiscordSession"), async () => sessionDiscordMessages(await sessionReportFor(real, { markNames: true })).join("\n\n"));
  text("markdown", localize("SCLS.Sample.Markdown"), async () => renderMarkdownExport(await sampleLog(real)));
  question("share-choice", localize("SCLS.EndCard.ChoiceTitle"), () => shareChoiceHtml(), () => [
    { label: localize("SCLS.EndCard.ChoiceConfirm"), icon: "fa-solid fa-share-nodes", default: true },
    { label: localize("SCLS.Button.Cancel"), icon: "fa-solid fa-xmark" }
  ], 460);
  question("delete-confirm", localize("SCLS.Confirm.DeleteCombatTitle"), () => `<div class="scls-delete-confirm"><p>${escapeHtml(localize("SCLS.Confirm.DeleteCombat"))}</p><p><strong>${escapeHtml(sampleText("place"))}</strong></p></div>`, () => [
    { label: localize("SCLS.Button.Delete"), icon: "fa-solid fa-trash" },
    { label: localize("SCLS.Button.Cancel"), icon: "fa-solid fa-xmark", default: true }
  ], 400);
  entries.push({
    id: "share-image",
    group: localize("SCLS.Sample.Texts"),
    label: localize("SCLS.Sample.ShareImage"),
    open: async () => {
      const log = await sampleLog(real);
      const blob = await renderShareImage(playerViewLog(log, { statsOptions: real?.statsOptions?.() ?? {} }), { statsOptions: real?.statsOptions?.() ?? {} });
      const img = document.createElement("img");
      img.src = URL.createObjectURL(blob);
      img.alt = log.title;
      img.style.cssText = "display:block;width:100%;height:auto;";
      return openSampleHtml({ moduleId: MODULE_ID, id: "share-image", title: localize("SCLS.Sample.ShareImage"), body: img, width: 560 });
    }
  });
  return entries;
}

/** The session report of tonight's sample fights, as players may see it. */
async function sessionReportFor(real, { markNames = false } = {}) {
  const service = sampleService(real);
  const options = { statsOptions: service.statsOptions() };
  const logs = [];
  for (const entry of await service.persistence.loadHistoryEntries()) logs.push(await service.getLog(entry.combatLogId));
  const sessions = groupSessions(logs);
  const selected = sessions[0];
  const ids = new Set(selected.logs.map((log) => log.id));
  const summary = summarizeFights(logs.filter((log) => ids.has(log.id)).map((log) => playerViewLog(log, options)), options);
  return sessionReport(summary, { title: sessionTitle(selected), markNames });
}

export const __test__ = { buildFight, sampleFights, sampleOffCombat, sampleService, format };
