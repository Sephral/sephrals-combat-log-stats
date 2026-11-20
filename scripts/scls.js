import { EVENT_TYPES, HOOKS, MODULE_ID, SETTINGS, TESTED_VERSIONS } from "./constants.js";
import { CombatLogApp } from "./apps/combat-log-app.js";
import { CombatLogService } from "./services/combat-log-service.js";
import { registerDebug } from "./debug.js";
import { saveDebugFile } from "./debug-file.mjs";
import { partnerHint, registerHubModule } from "./hub.mjs";
import { canViewCombatLogs } from "./services/player-view-service.js";
import { needsShareChoice, shareChoiceHtml, shareEndCard } from "./services/end-card-service.js";
import { PlayerReportService } from "./services/player-report-service.js";
import { sessionTotals } from "./services/session-service.js";
import { getSetting, registerSettings } from "./settings.js";
import { noticeNewVersions, runSelfTest } from "./selftest.js";
import { isGM, isTrackingGM, loadModuleTranslations, localize, registerTemplateHelpers } from "./utils.js";
import { countFeature, markUsed, registerUsage } from "./usage.mjs";
import { registerDangerBar } from "./danger-bar.js";

let combatLogService = null;
let combatLogApp = null;
const TOOL_NAME = "sclsCombatLog";

// GMs always, players read only while the setting "Players can view combat statistics" is on.
export function openCombatLog(logId = null, { tab = null, outside = false } = {}) {
  if (!canViewCombatLogs()) {
    ui.notifications.warn(localize("SCLS.Notification.PlayerAccessOff"));
    return null;
  }
  if (!combatLogService) return null;
  markUsed(MODULE_ID);
  // One window: reopening shows the requested log in the existing window.
  if (combatLogApp?.rendered) {
    combatLogApp.showLog(logId, { tab, outside });
    combatLogApp.bringToFront?.();
    return combatLogApp;
  }
  combatLogApp = new CombatLogApp(combatLogService, logId);
  if (tab) combatLogApp.activeTab = tab;
  combatLogApp.focusOutside = outside;
  void combatLogApp.render({ force: true });
  return combatLogApp;
}

function injectCombatTrackerButton(_app, html) {
  if (!canViewCombatLogs()) return;
  const root = html?.[0] ?? html;
  if (!root?.querySelector || root.querySelector(".scls-combat-tracker-button")) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "scls-combat-tracker-button";
  button.title = localize("SCLS.SceneTool.Open");
  button.innerHTML = `<i class="fa-solid fa-chart-line" inert></i> ${localize("SCLS.SceneTool.Open")}`;
  button.addEventListener("click", () => openCombatLog());
  const target = root.querySelector(".combat-tracker-footer, .directory-footer, footer, .combat-tracker-header") ?? root;
  target.appendChild(button);
}

// Hook handlers run before the service exists (init) and on every client; only the tracking GM records.
function track(handler) {
  return (...args) => {
    if (!combatLogService || !isTrackingGM()) return;
    void handler(...args);
  };
}

function registerHooks() {
  Hooks.on(HOOKS.LANGUAGE_CHANGED, applyLanguageChange);
  Hooks.on(HOOKS.PLAYER_ACCESS_CHANGED, applyPlayerAccessChange);

  Hooks.on("createCombat", track((combat) => combatLogService.startCombat(combat)));
  Hooks.on("combatStart", track((combat) => combatLogService.startCombat(combat, { force: true })));
  Hooks.on("updateCombat", track((combat, changed) => combatLogService.updateCombat(combat, changed)));
  // Ending a combat deletes the Combat document; core has no separate "combat ended" hook.
  Hooks.on("deleteCombat", track(async (combat) => {
    const log = await combatLogService.deleteCombat(combat);
    if (log) countFeature(MODULE_ID, "combatLogged");
    if (log && getSetting(SETTINGS.SHOW_SUMMARY_ON_COMBAT_END, true)) openCombatLog(log.id);
  }));

  Hooks.on("createCombatant", track((combatant) => combatLogService.combatantCreated(combatant)));
  Hooks.on("updateCombatant", track((combatant, changed) => combatLogService.combatantUpdated(combatant, changed)));
  Hooks.on("deleteCombatant", track((combatant) => combatLogService.combatantRemoved(combatant)));
  Hooks.on("createChatMessage", track((message) => combatLogService.chatMessageCreated(message)));
  // Crucible applies an action card only when the GM confirms it, and can undo it again.
  Hooks.on("updateChatMessage", track((message, changed) => combatLogService.chatMessageUpdated(message, changed)));
  Hooks.on("deleteChatMessage", track((message) => combatLogService.chatMessageDeleted(message)));

  Hooks.on("preUpdateActor", (actor) => {
    if (!combatLogService || !isTrackingGM() || !actor?.uuid) return;
    if (!combatLogService.findLogsForActor(actor).length) return;
    combatLogService.actorSnapshots.set(actor.uuid, foundry.utils.deepClone(actor.toObject?.() ?? actor));
  });
  Hooks.on("updateActor", track((actor, changed, options, userId) => combatLogService.actorUpdated(actor, changed, options, userId)));

  // The log outside fights. Every GM keeps the last values of the actors; only the recording GM writes entries.
  const offCombat = (handler) => (...args) => {
    if (!combatLogService || !isGM()) return;
    void handler(combatLogService.offCombat, ...args);
  };
  Hooks.on("updateActor", offCombat((service, actor, changed, options) => service.actorUpdated(actor, changed, options)));
  Hooks.on("createActiveEffect", offCombat((service, effect) => service.effectChanged(effect, true)));
  Hooks.on("deleteActiveEffect", offCombat((service, effect) => service.effectChanged(effect, false)));
  Hooks.on("dnd5e.restCompleted", offCombat((service, actor, result) => service.restCompleted(actor, result)));
  Hooks.on("canvasReady", offCombat((service) => service.snapshotAll()));
  Hooks.on("createToken", offCombat((service, token) => token?.actor && service.snapshot(token.actor)));

  Hooks.on("createActiveEffect", track((effect) => combatLogService.activeEffectChanged(EVENT_TYPES.ACTIVE_EFFECT_CREATED, effect, {})));
  Hooks.on("updateActiveEffect", track((effect, changed) => combatLogService.activeEffectChanged(EVENT_TYPES.ACTIVE_EFFECT_UPDATED, effect, changed)));
  Hooks.on("deleteActiveEffect", track((effect) => combatLogService.activeEffectChanged(EVENT_TYPES.ACTIVE_EFFECT_DELETED, effect, {})));

  // Pathfinder 2e keeps conditions as items on the actor, not as effects. They go through the same paths as effects.
  const conditionItem = (handler) => (item) => {
    if (globalThis.game?.system?.id !== "pf2e" || item?.type !== "condition") return;
    handler(pf2eConditionAsEffect(item));
  };
  Hooks.on("createItem", offCombat((service, item) => conditionItem((effect) => service.effectChanged(effect, true))(item)));
  Hooks.on("deleteItem", offCombat((service, item) => conditionItem((effect) => service.effectChanged(effect, false))(item)));
  Hooks.on("createItem", track(conditionItem((effect) => combatLogService.activeEffectChanged(EVENT_TYPES.ACTIVE_EFFECT_CREATED, effect, {}))));
  Hooks.on("deleteItem", track(conditionItem((effect) => combatLogService.activeEffectChanged(EVENT_TYPES.ACTIVE_EFFECT_DELETED, effect, {}))));

  Hooks.on("getSceneControlButtons", (controls) => {
    if (!canViewCombatLogs()) return;
    const tool = {
      name: TOOL_NAME,
      title: localize("SCLS.SceneTool.Open"),
      icon: "fa-solid fa-chart-line",
      button: true,
      visible: true,
      onChange: () => openCombatLog()
    };
    // v13 and v14 pass a record of controls; the token controls are always there.
    const tokens = controls?.tokens ?? (Array.isArray(controls) ? controls.find((control) => control.name === "token" || control.name === "tokens") : null);
    if (!tokens) return;
    if (Array.isArray(tokens.tools)) tokens.tools.push({ ...tool, onClick: tool.onChange });
    else {
      tool.order = Object.keys(tokens.tools ?? {}).length;
      tokens.tools[TOOL_NAME] = tool;
    }
  });

  Hooks.on("renderCombatTracker", injectCombatTrackerButton);
  registerDangerBar();
  Hooks.on("renderChatMessageHTML", wireEndCard);
}

// The button of the card at the end of a fight opens the full report of that fight.
function wireEndCard(message, html) {
  const root = html?.[0] ?? html;
  wireEndCardShare(message, root);
  wireEndCardOutside(message, root);
  wireEndCardAlbumHint(root);
  const button = root?.querySelector?.(".scls-endcard__open");
  if (!button) return;
  // Without access to the log window the card still tells its numbers.
  if (!canViewCombatLogs()) {
    button.remove();
    return;
  }
  button.addEventListener("click", (event) => {
    event.preventDefault();
    countFeature(MODULE_ID, "endCardOpened");
    openCombatLog(button.dataset.sclsLogId || message?.getFlag?.(MODULE_ID, "endCard")?.logId || null);
  });
}

// GM cards only, and only while the Campaign Album is off: a small info icon beside the title. Added when the card
// is drawn, never stored in the message, so it disappears as soon as the album is active.
function wireEndCardAlbumHint(root) {
  const title = root?.querySelector?.(".scls-endcard__title");
  if (!title || !root.querySelector(".scls-endcard__share") || title.querySelector(".sephrals-partner-hint")) return;
  const hint = partnerHint(MODULE_ID, "sephrals-campaign-album");
  if (hint) title.insertAdjacentHTML("beforeend", hint);
}

// The line about the log outside of combat opens the Sessions tab at that block. GMs only, like the log itself.
function wireEndCardOutside(message, root) {
  const button = root?.querySelector?.(".scls-endcard__outside-open");
  if (!button) return;
  if (!isGM() || !canViewCombatLogs()) {
    button.closest("li")?.remove();
    return;
  }
  button.addEventListener("click", (event) => {
    event.preventDefault();
    countFeature(MODULE_ID, "offCombatOpened");
    openCombatLog(button.dataset.sclsLogId || message?.getFlag?.(MODULE_ID, "endCard")?.logId || null, { tab: "sessions", outside: true });
  });
}

// A fight whose sharing was never chosen asks first: a summary or the full recap. Null when the GM cancels.
async function askShareChoice() {
  const dialog = foundry.applications.api.DialogV2;
  countFeature(MODULE_ID, "endCardShareAsked");
  return dialog.wait({
    window: { title: localize("SCLS.EndCard.ChoiceTitle") },
    content: shareChoiceHtml(),
    rejectClose: false,
    buttons: [
      { action: "share", label: localize("SCLS.EndCard.ChoiceConfirm"), icon: "fa-solid fa-share-nodes", default: true, callback: (_event, button) => new FormData(button.form).get("choice") || "summary" },
      { action: "cancel", label: localize("SCLS.Button.Cancel"), callback: () => null }
    ]
  });
}

// The GM's whispered card offers to post the same card for everyone. Once shared (stored on the card, so every GM
// and every reload sees it) the button stays disabled. Only GMs see the card at all; players never get the button.
function wireEndCardShare(message, root) {
  const button = root?.querySelector?.(".scls-endcard__share");
  if (!button) return;
  if (!isGM() || getSetting(SETTINGS.ENABLE_PLAYER_SHARING, true) === false) {
    button.remove();
    return;
  }
  const markShared = () => {
    button.disabled = true;
    button.innerHTML = `<i class="fa-solid fa-share-nodes" inert></i> ${localize("SCLS.EndCard.Shared")}`;
  };
  if (message?.getFlag?.(MODULE_ID, "endCard")?.shared) {
    markShared();
    return;
  }
  button.addEventListener("click", async (event) => {
    event.preventDefault();
    if (button.disabled || !combatLogService) return;
    button.disabled = true;
    try {
      const logId = button.dataset.sclsLogId || message?.getFlag?.(MODULE_ID, "endCard")?.logId;
      const log = logId ? await combatLogService.getLog(logId) : null;
      // Sharing was never set up for this fight: the GM chooses, and the choice is saved with the fight.
      const asks = Boolean(log) && needsShareChoice(log);
      const choice = asks ? await askShareChoice() : null;
      if (asks && !choice) {
        button.disabled = false;
        return;
      }
      const posted = log ? await shareEndCard(log, { statsOptions: combatLogService.statsOptions(), choice }) : null;
      if (posted && choice) {
        new PlayerReportService().appendShareEvent(log, "created", { shareMode: log.shareSettings.shareMode, source: "endCard" });
        await combatLogService.saveAndCompute(log, { immediate: true });
      }
      if (!posted) {
        button.disabled = false;
        ui.notifications.warn(localize("SCLS.Notification.EndCardShareOff"));
        return;
      }
      countFeature(MODULE_ID, "endCardShared");
      markShared();
      await message?.setFlag?.(MODULE_ID, "endCard.shared", true);
      ui.notifications.info(localize("SCLS.Notification.EndCardShared"));
    } catch (error) {
      button.disabled = false;
      console.warn(`${MODULE_ID} | Could not share the end of combat card`, error);
    }
  });
}

// A pf2e condition item seen as an effect with a status: name, icon, the actor it sits on.
export function pf2eConditionAsEffect(item) {
  const slug = String(item?.slug ?? item?.system?.slug ?? "").trim();
  return { id: item?.id ?? "", uuid: item?.uuid ?? "", name: item?.name ?? slug, img: item?.img ?? "", disabled: false, statuses: slug ? [slug] : [], parent: item?.parent };
}

function applyLanguageChange() {
  combatLogApp?.render?.({ force: true });
  for (const button of document.querySelectorAll(".scls-combat-tracker-button")) {
    button.title = localize("SCLS.SceneTool.Open");
    button.innerHTML = `<i class="fa-solid fa-chart-line" inert></i> ${localize("SCLS.SceneTool.Open")}`;
  }
  // reset: the tool titles are read again from getSceneControlButtons.
  ui.controls?.render?.({ reset: true })?.catch?.(() => {});
}

// The GM turned player access on or off: players get or lose the tool and the button at once, an open window closes.
function applyPlayerAccessChange() {
  if (isGM()) return;
  if (!canViewCombatLogs()) {
    void combatLogApp?.close?.();
    combatLogApp = null;
    for (const button of document.querySelectorAll(".scls-combat-tracker-button")) button.remove();
  } else ui.combat?.render?.();
  ui.controls?.render?.({ reset: true })?.catch?.(() => {});
}

Hooks.once("init", () => {
  registerHubModule({ moduleId: MODULE_ID, tested: TESTED_VERSIONS });
  registerSettings();
  registerDebug(() => combatLogService);
  registerUsage(MODULE_ID, {
    features: ["endCardPosted", "endCardOpened", "endCardShared", "endCardShareAsked", "offCombatOpened", "offCombatLogged", "offCombatViewed", "combatLogged", "logCorrected", "sharingSaved", "reportPosted", "journalReport", "discordCopied", "logExported", "sessionShared", "selfTestRun", "roundStoryShown", "dangerShown"],
    settings: [SETTINGS.END_CARD_MODE, SETTINGS.OFF_COMBAT_LOG, SETTINGS.OFF_COMBAT_SCOPE, SETTINGS.DEFAULT_SHARE_MODE, SETTINGS.DEFAULT_DPR_METHOD, SETTINGS.PLAYER_STATS_ACCESS, SETTINGS.ROUND_STORY, SETTINGS.ROUND_STORY_CARD, SETTINGS.DANGER_BAR]
  });
  registerTemplateHelpers();
  registerHooks();
});

// When GMs join or leave, the recording GM can change. The new one picks up the running logs,
// the previous one writes its pending changes and lets go.
let recording = false;
async function syncRecordingGM() {
  if (!combatLogService) return;
  const now = isTrackingGM();
  if (now === recording) return;
  recording = now;
  if (now) await combatLogService.ready();
  else {
    await combatLogService.offCombat.flush();
    await combatLogService.releaseLogs();
  }
}

Hooks.once("ready", async () => {
  await loadModuleTranslations();
  combatLogService = new CombatLogService();
  recording = isTrackingGM();
  await combatLogService.ready();
  if (isGM()) combatLogService.offCombat.snapshotAll();
  Hooks.on("userConnected", () => void syncRecordingGM());
  // The index setting changes whenever a GM saves logs. Changes from another client make the local copy stale.
  const indexKey = `${MODULE_ID}.${SETTINGS.INDEX}`;
  const offCombatKey = `${MODULE_ID}.${SETTINGS.OFF_COMBAT_DATA}`;
  const onIndexChanged = (setting, userId) => {
    if (setting?.key === offCombatKey && userId !== game.user.id) combatLogService?.offCombat?.store.invalidate();
    if (setting?.key !== indexKey || userId === game.user.id) return;
    combatLogService?.persistence?.invalidate();
    // Players hold no live log: their open window shows the fight again as the GM just saved it.
    if (!isGM()) combatLogApp?.scheduleRefresh?.();
  };
  Hooks.on("createSetting", (setting, _options, userId) => onIndexChanged(setting, userId));
  Hooks.on("updateSetting", (setting, _changes, _options, userId) => onIndexChanged(setting, userId));
  // Writes are batched; a reload or closing the tab should not lose the last burst. The upload cannot finish
  // while the page unloads, so the waiting logs are also kept in the browser until the next start.
  globalThis.addEventListener?.("beforeunload", () => {
    void combatLogService?.offCombat?.flush();
    combatLogService?.stashPendingSaves();
    void combatLogService?.flushPendingSaves();
  });
  game.modules.get(MODULE_ID).api = {
    openCombatLog,
    service: combatLogService,
    runSelfTest: (options) => runSelfTest(combatLogService, options),
    // Combat totals of the game sessions in a time span, as players may see them (other modules, e.g. Campaign Album)
    sessionTotals: (spans) => sessionTotals(combatLogService, spans),
    // One file for all of Sephral's modules, without a message id about their latest picture
    saveDebugFile: (messageId) => saveDebugFile(messageId ?? null, { moduleId: MODULE_ID })
  };
  noticeNewVersions();
});
