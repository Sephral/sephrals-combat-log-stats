import { EVENT_TYPES, HOOKS, MODULE_ID, SETTINGS } from "./constants.js";
import { CombatLogApp } from "./apps/combat-log-app.js";
import { CombatLogService } from "./services/combat-log-service.js";
import { getSetting, registerSettings } from "./settings.js";
import { isGM, isTrackingGM, loadModuleTranslations, localize, registerTemplateHelpers } from "./utils.js";

let combatLogService = null;
let combatLogApp = null;
const TOOL_NAME = "sclsCombatLog";

export function openCombatLog(logId = null) {
  if (!isGM()) {
    ui.notifications.warn(localize("SCLS.Notification.GMOnly"));
    return null;
  }
  if (!combatLogService) return null;
  // One window: reopening shows the requested log in the existing window.
  if (combatLogApp?.rendered) {
    combatLogApp.showLog(logId);
    combatLogApp.bringToFront?.();
    return combatLogApp;
  }
  combatLogApp = new CombatLogApp(combatLogService, logId);
  void combatLogApp.render({ force: true });
  return combatLogApp;
}

function injectCombatTrackerButton(_app, html) {
  if (!isGM()) return;
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

  Hooks.on("createCombat", track((combat) => combatLogService.startCombat(combat)));
  Hooks.on("combatStart", track((combat) => combatLogService.startCombat(combat, { force: true })));
  Hooks.on("updateCombat", track((combat, changed) => combatLogService.updateCombat(combat, changed)));
  // Ending a combat deletes the Combat document; core has no separate "combat ended" hook.
  Hooks.on("deleteCombat", track(async (combat) => {
    const log = await combatLogService.deleteCombat(combat);
    if (log && getSetting(SETTINGS.SHOW_SUMMARY_ON_COMBAT_END, true)) openCombatLog(log.id);
  }));

  Hooks.on("createCombatant", track((combatant) => combatLogService.combatantCreated(combatant)));
  Hooks.on("updateCombatant", track((combatant, changed) => combatLogService.combatantUpdated(combatant, changed)));
  Hooks.on("deleteCombatant", track((combatant) => combatLogService.combatantRemoved(combatant)));
  Hooks.on("createChatMessage", track((message) => combatLogService.chatMessageCreated(message)));

  Hooks.on("preUpdateActor", (actor) => {
    if (!combatLogService || !isTrackingGM() || !actor?.uuid) return;
    if (!combatLogService.findLogsForActor(actor).length) return;
    combatLogService.actorSnapshots.set(actor.uuid, foundry.utils.deepClone(actor.toObject?.() ?? actor));
  });
  Hooks.on("updateActor", track((actor, changed, options, userId) => combatLogService.actorUpdated(actor, changed, options, userId)));

  Hooks.on("createActiveEffect", track((effect) => combatLogService.activeEffectChanged(EVENT_TYPES.ACTIVE_EFFECT_CREATED, effect, {})));
  Hooks.on("updateActiveEffect", track((effect, changed) => combatLogService.activeEffectChanged(EVENT_TYPES.ACTIVE_EFFECT_UPDATED, effect, changed)));
  Hooks.on("deleteActiveEffect", track((effect) => combatLogService.activeEffectChanged(EVENT_TYPES.ACTIVE_EFFECT_DELETED, effect, {})));

  Hooks.on("getSceneControlButtons", (controls) => {
    if (!isGM()) return;
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
}

function applyLanguageChange() {
  combatLogApp?.render?.({ force: true });
  for (const button of document.querySelectorAll(".scls-combat-tracker-button")) {
    button.title = localize("SCLS.SceneTool.Open");
    button.innerHTML = `<i class="fa-solid fa-chart-line" inert></i> ${localize("SCLS.SceneTool.Open")}`;
  }
  ui.controls?.render?.();
}

Hooks.once("init", () => {
  registerSettings();
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
  else await combatLogService.releaseLogs();
}

Hooks.once("ready", async () => {
  await loadModuleTranslations();
  combatLogService = new CombatLogService();
  recording = isTrackingGM();
  await combatLogService.ready();
  Hooks.on("userConnected", () => void syncRecordingGM());
  // The index setting changes whenever a GM saves logs. Changes from another client make the local copy stale.
  const indexKey = `${MODULE_ID}.${SETTINGS.INDEX}`;
  const onIndexChanged = (setting, userId) => {
    if (setting?.key === indexKey && userId !== game.user.id) combatLogService?.persistence?.invalidate();
  };
  Hooks.on("createSetting", (setting, _options, userId) => onIndexChanged(setting, userId));
  Hooks.on("updateSetting", (setting, _changes, _options, userId) => onIndexChanged(setting, userId));
  // Writes are batched; a reload or closing the tab should not lose the last burst.
  globalThis.addEventListener?.("beforeunload", () => void combatLogService?.flushPendingSaves());
  game.modules.get(MODULE_ID).api = { openCombatLog, service: combatLogService };
});
