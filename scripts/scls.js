import { EVENT_TYPES, HOOKS, MODULE_ID, SETTINGS } from "./constants.js";
import { CombatLogApp } from "./apps/combat-log-app.js";
import { CombatLogService } from "./services/combat-log-service.js?v=20260519f";
import { getSetting, registerSettings } from "./settings.js";
import { isGM, loadModuleTranslations, localize, registerTemplateHelpers } from "./utils.js";

let combatLogService = null;
let combatLogApp = null;
let lastSceneControlOpenAt = 0;
const CONTROL_NAME = "combatLogStats";
const TOOL_NAME = "open-combat-log-stats";

export function openCombatLog(logId = null) {
  if (!isGM()) {
    ui.notifications.warn(localize("SCLS.Notification.GMOnly"));
    return null;
  }
  combatLogApp = new CombatLogApp(combatLogService, logId);
  void combatLogApp.render({ force: true });
  return combatLogApp;
}

function installSceneControlFallback() {
  Hooks.on("renderSceneControls", () => {
    if (!isGM()) return;
    setTimeout(() => {
      const buttons = document.querySelectorAll(`[data-control='${CONTROL_NAME}'], [data-tool='${TOOL_NAME}']`);
      for (const button of buttons) {
        if (button.dataset.sclsBound) continue;
        button.dataset.sclsBound = "true";
        const handler = (event) => openCombatLogFromSceneControl(event, true);
        button.addEventListener("pointerdown", handler, { capture: true });
        button.addEventListener("mousedown", handler, { capture: true });
        button.addEventListener("click", handler, { capture: true });
      }
    }, 0);
  });
}

function openCombatLogFromSceneControl(event, dedupe = false) {
  if (event) {
    event.preventDefault?.();
    event.stopPropagation?.();
    event.stopImmediatePropagation?.();
  }
  const now = Date.now();
  if (dedupe && now - lastSceneControlOpenAt < 500) return;
  lastSceneControlOpenAt = now;
  openCombatLog();
}

function injectCombatTrackerButton(_app, html) {
  if (!isGM()) return;
  const root = html?.[0] ?? html;
  if (!root?.querySelector || root.querySelector(".scls-combat-tracker-button")) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "scls-combat-tracker-button";
  button.title = localize("SCLS.SceneTool.Open");
  button.innerHTML = `<i class="fa-solid fa-chart-line"></i> ${localize("SCLS.SceneTool.Open")}`;
  button.addEventListener("click", () => openCombatLog());
  const target = root.querySelector(".directory-footer, footer, .combat-tracker-header") ?? root;
  target.appendChild(button);
}

function registerHooks() {
  Hooks.on(HOOKS.LANGUAGE_CHANGED, applyLanguageChange);

  Hooks.on("createCombat", (combat) => {
    if (!isGM()) return;
    void combatLogService.startCombat(combat);
  });

  Hooks.on("updateCombat", (combat, changed) => {
    if (!isGM()) return;
    void combatLogService.updateCombat(combat, changed);
  });

  Hooks.on("deleteCombat", (combat) => {
    if (!isGM()) return;
    void combatLogService.deleteCombat(combat);
  });

  Hooks.on("combatStart", (combat) => {
    if (!isGM()) return;
    void combatLogService.startCombat(combat);
  });

  Hooks.on("combatEnd", (combat) => {
    if (!isGM()) return;
    void combatLogService.endCombat(combat).then((log) => {
      if (log && getSetting(SETTINGS.SHOW_SUMMARY_ON_COMBAT_END, true)) openCombatLog(log.id);
    });
  });

  Hooks.on("createCombatant", (combatant) => {
    if (!isGM()) return;
    void combatLogService.combatantCreated(combatant);
  });

  Hooks.on("updateCombatant", (combatant, changed) => {
    if (!isGM()) return;
    void combatLogService.combatantUpdated(combatant, changed);
  });

  Hooks.on("deleteCombatant", (combatant) => {
    if (!isGM()) return;
    void combatLogService.combatantRemoved(combatant);
  });

  Hooks.on("createChatMessage", (message) => {
    if (!isGM()) return;
    void combatLogService.chatMessageCreated(message);
  });

  Hooks.on("preUpdateActor", (actor) => {
    if (!isGM() || !combatLogService) return;
    if (actor?.uuid) combatLogService.actorSnapshots.set(actor.uuid, foundry.utils.deepClone(actor.toObject?.() ?? actor));
  });

  Hooks.on("updateActor", (actor, changed, options, userId) => {
    if (!isGM()) return;
    void combatLogService.actorUpdated(actor, changed, options, userId);
  });

  Hooks.on("createActiveEffect", (effect) => trackActiveEffect(EVENT_TYPES.ACTIVE_EFFECT_CREATED, effect, {}));
  Hooks.on("updateActiveEffect", (effect, changed) => trackActiveEffect(EVENT_TYPES.ACTIVE_EFFECT_UPDATED, effect, changed));
  Hooks.on("deleteActiveEffect", (effect) => trackActiveEffect(EVENT_TYPES.ACTIVE_EFFECT_DELETED, effect, {}));

  Hooks.on("createMeasuredTemplate", (template) => trackTemplate(EVENT_TYPES.TEMPLATE_CREATED, template));
  Hooks.on("deleteMeasuredTemplate", (template) => trackTemplate(EVENT_TYPES.TEMPLATE_DELETED, template));
  Hooks.on("updateToken", (token, changed) => trackToken(EVENT_TYPES.TOKEN_UPDATED, token, changed));
  Hooks.on("createToken", (token) => trackToken(EVENT_TYPES.TOKEN_CREATED, token, {}));
  Hooks.on("deleteToken", (token) => trackToken(EVENT_TYPES.TOKEN_DELETED, token, {}));

  Hooks.on("getSceneControlButtons", (controls) => {
    if (!isGM()) return;
    const control = {
      name: CONTROL_NAME,
      title: localize("SCLS.SceneTool.Open"),
      icon: "fas fa-chart-line",
      layer: "controls",
      tools: [{
        name: TOOL_NAME,
        title: localize("SCLS.SceneTool.Open"),
        icon: "fas fa-chart-line",
        button: true,
        onClick: openCombatLogFromSceneControl
      }]
    };
    if (Array.isArray(controls)) controls.push(control);
    else controls[CONTROL_NAME] = control;
  });

  Hooks.on("renderCombatTracker", injectCombatTrackerButton);
}

function applyLanguageChange() {
  combatLogApp?.render?.({ force: true });
  for (const button of document.querySelectorAll(".scls-combat-tracker-button")) {
    button.title = localize("SCLS.SceneTool.Open");
    button.innerHTML = `<i class="fa-solid fa-chart-line"></i> ${localize("SCLS.SceneTool.Open")}`;
  }
  ui.controls?.render?.();
}

function trackActiveEffect(type, effect, changed = {}) {
  if (!isGM()) return;
  void combatLogService.activeEffectChanged(type, effect, changed);
}

function trackTemplate(type, template) {
  if (!isGM() || !getSetting(SETTINGS.TRACK_TEMPLATES, true)) return;
  const log = combatLogService.activeLogs.get(game?.combat?.id);
  if (!log) return;
  log.events.push({
    id: foundry.utils.randomID(),
    type,
    createdAt: new Date().toISOString(),
    sequence: (log.events?.length ?? 0) + 1,
    round: game.combat?.round ?? null,
    turn: game.combat?.turn ?? null,
    combatantId: "",
    actorUuid: "",
    tokenUuid: "",
    sceneUuid: canvas?.scene?.uuid ?? log.sceneUuid,
    userId: game.user?.id ?? "",
    visibility: "gm",
    source: { kind: "templateUpdate", id: template.id },
    confidence: "probable",
    ignored: false,
    tags: [],
    data: { templateId: template.id }
  });
  void combatLogService.saveAndCompute(log);
}

function trackToken(type, token, changed) {
  if (!isGM() || !getSetting(SETTINGS.TRACK_TOKEN_UPDATES, true)) return;
  const log = combatLogService.activeLogs.get(game?.combat?.id);
  if (!log) return;
  log.events.push({
    id: foundry.utils.randomID(),
    type,
    createdAt: new Date().toISOString(),
    sequence: (log.events?.length ?? 0) + 1,
    round: game.combat?.round ?? null,
    turn: game.combat?.turn ?? null,
    combatantId: "",
    actorUuid: token.actor?.uuid ?? "",
    tokenUuid: token.uuid ?? "",
    sceneUuid: canvas?.scene?.uuid ?? log.sceneUuid,
    userId: game.user?.id ?? "",
    visibility: "gm",
    source: { kind: "tokenUpdate", id: token.id },
    confidence: "probable",
    ignored: false,
    tags: [],
    data: { changed }
  });
  void combatLogService.saveAndCompute(log);
}

Hooks.once("init", () => {
  registerSettings();
  registerTemplateHelpers();
  installSceneControlFallback();
  registerHooks();
});

Hooks.once("ready", async () => {
  await loadModuleTranslations();
  combatLogService = new CombatLogService();
  await combatLogService.ready();
  game.modules.get(MODULE_ID).api = { openCombatLog, service: combatLogService };
});
