import { MODULE_ID, SETTINGS } from "./constants.js";
import { dangerInput, dangerLabel, dangerState, dangerTooltip } from "./services/danger-service.js";
import { getSetting } from "./settings.js";
import { isGM } from "./utils.js";
import { countFeature } from "./usage.mjs";

// The danger bar of the GM on the combat tracker. The tracker draws it when it renders (turn changes, new rounds);
// between renders hit point changes update it in place, a few times per second at most.

const REFRESH_MS = 150;
const counted = new Set();
let timer = null;

function viewedCombat() {
  return globalThis.ui?.combat?.viewed ?? globalThis.game?.combat ?? null;
}

function barWanted() {
  return isGM() && getSetting(SETTINGS.DANGER_BAR, true) !== false;
}

function stateOf(combat) {
  if (!combat?.started) return null;
  try {
    return dangerState(dangerInput(combat));
  } catch (error) {
    console.warn(`${MODULE_ID} | Could not read the danger bar`, error);
    return null;
  }
}

function paint(element, state) {
  element.className = `scls-danger scls-danger--${state.level}`;
  element.title = dangerTooltip(state, globalThis.game?.system?.id ?? "");
  element.setAttribute("aria-label", `${dangerLabel(state)}. ${element.title}`);
  element.dataset.score = String(state.score);
  element.querySelector(".scls-danger__fill").style.width = `${Math.max(4, Math.round(state.score * 100))}%`;
  element.querySelector(".scls-danger__label").textContent = dangerLabel(state);
}

function build() {
  const element = document.createElement("div");
  element.innerHTML = `<div class="scls-danger__track"><div class="scls-danger__fill"></div></div><span class="scls-danger__label"></span>`;
  element.setAttribute("role", "img");
  return element;
}

function injectDangerBar(app, html) {
  const root = html?.[0] ?? html;
  if (!root?.querySelector) return;
  const existing = root.querySelector(".scls-danger");
  const combat = app?.viewed ?? viewedCombat();
  const state = barWanted() ? stateOf(combat) : null;
  if (!state) {
    existing?.remove();
    return;
  }
  const element = existing ?? build();
  paint(element, state);
  if (!existing) {
    const header = root.querySelector(".combat-tracker-header, header");
    if (header) header.insertAdjacentElement("afterend", element);
    else root.prepend(element);
  }
  if (combat?.id && !counted.has(combat.id)) {
    counted.add(combat.id);
    countFeature(MODULE_ID, "dangerShown");
  }
}

function refresh() {
  timer = null;
  const bars = document.querySelectorAll?.(".scls-danger");
  if (!bars?.length) return;
  const state = barWanted() ? stateOf(viewedCombat()) : null;
  for (const bar of bars) {
    if (state) paint(bar, state);
    else bar.remove();
  }
}

function scheduleRefresh() {
  if (timer !== null || !isGM()) return;
  timer = setTimeout(refresh, REFRESH_MS);
}

export function registerDangerBar() {
  Hooks.on("renderCombatTracker", injectDangerBar);
  for (const name of ["updateActor", "updateToken", "updateCombatant", "deleteCombatant", "createCombatant", "updateCombat"]) Hooks.on(name, scheduleRefresh);
}
