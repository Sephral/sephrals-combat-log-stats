import { LANGUAGE_MODES, MODULE_ID, SETTINGS } from "./constants.js";

let moduleTranslations = {};
let translationsPromise = null;

export function isoNow() {
  return new Date().toISOString();
}

export function generateId(prefix = "scls") {
  if (globalThis.foundry?.utils?.randomID) return `${prefix}-${globalThis.foundry.utils.randomID()}`;
  if (globalThis.crypto?.randomUUID) return `${prefix}-${globalThis.crypto.randomUUID()}`;
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function cloneData(value) {
  if (typeof globalThis.structuredClone === "function") return globalThis.structuredClone(value);
  if (globalThis.foundry?.utils?.deepClone) return globalThis.foundry.utils.deepClone(value);
  return JSON.parse(JSON.stringify(value));
}

export function getProperty(source, path) {
  if (!source || !path) return undefined;
  if (globalThis.foundry?.utils?.getProperty) return globalThis.foundry.utils.getProperty(source, path);
  return String(path).split(".").reduce((current, part) => current?.[part], source);
}

export function setProperty(target, path, value) {
  if (globalThis.foundry?.utils?.setProperty) return globalThis.foundry.utils.setProperty(target, path, value);
  const parts = String(path).split(".");
  let current = target;
  while (parts.length > 1) {
    const part = parts.shift();
    current[part] ??= {};
    current = current[part];
  }
  current[parts[0]] = value;
  return true;
}

export function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function formatDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  try {
    return new Intl.DateTimeFormat(activeLocale(), { dateStyle: "medium", timeStyle: "short" }).format(date);
  } catch {
    return date.toLocaleString();
  }
}

export function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(Number(ms ?? 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export async function loadModuleTranslations() {
  if (translationsPromise) return translationsPromise;
  translationsPromise = Promise.all(["en", "de"].map(async (language) => {
    try {
      const response = await fetch(`modules/${MODULE_ID}/lang/${language}.json`);
      if (!response.ok) return [language, {}];
      return [language, await response.json()];
    } catch (error) {
      console.warn(`${MODULE_ID} | Failed to load ${language} translations`, error);
      return [language, {}];
    }
  })).then((entries) => {
    moduleTranslations = Object.fromEntries(entries);
    return moduleTranslations;
  });
  return translationsPromise;
}

export function localize(key) {
  // Only an explicit language choice overrides with the bundled file. "Follow Foundry" reads game.i18n alone,
  // which already holds this module's strings for the Foundry language, English fallback and community translations.
  const language = explicitLanguage();
  const override = language ? moduleTranslations?.[language]?.[key] : undefined;
  return override ?? globalThis.game?.i18n?.localize?.(key) ?? key;
}

export function activeLanguage() {
  return explicitLanguage() ?? (String(globalThis.game?.i18n?.lang ?? "en").toLowerCase().startsWith("de") ? LANGUAGE_MODES.DE : LANGUAGE_MODES.EN);
}

// Locale for dates and numbers: the explicit choice, otherwise the Foundry language as is (e.g. "fr").
export function activeLocale() {
  return explicitLanguage() ?? String(globalThis.game?.i18n?.lang || "en");
}

function explicitLanguage() {
  const configured = selectedLanguageMode();
  return configured === LANGUAGE_MODES.DE || configured === LANGUAGE_MODES.EN ? configured : null;
}

function selectedLanguageMode() {
  try {
    return globalThis.game?.settings?.get(MODULE_ID, SETTINGS.LANGUAGE) ?? LANGUAGE_MODES.FOLLOW_FOUNDRY;
  } catch {
    return LANGUAGE_MODES.FOLLOW_FOUNDRY;
  }
}

export function format(key, data = {}) {
  const template = localize(key);
  return Object.entries(data).reduce((text, [property, value]) => text.replaceAll(`{${property}}`, String(value ?? "")), template);
}

export function registerTemplateHelpers() {
  const handlebars = globalThis.Handlebars ?? foundry?.applications?.handlebars?.handlebars;
  handlebars?.registerHelper?.("sclsLocalize", (key) => localize(String(key ?? "")));
}

export async function renderAppTemplate(path, context) {
  const renderer = foundry?.applications?.handlebars?.renderTemplate ?? globalThis.renderTemplate;
  if (typeof renderer !== "function") throw new Error(`No template renderer available for ${path}`);
  return renderer(path, context);
}

export function isGM() {
  return Boolean(globalThis.game?.user?.isGM);
}

// Only one client records combats: the active GM. A second GM or an assistant would otherwise
// write every event a second time.
export function isTrackingGM() {
  if (!globalThis.game?.user?.isGM) return false;
  const activeGM = globalThis.game?.users?.activeGM;
  return activeGM ? activeGM.id === globalThis.game.user.id : true;
}

export function debugLog(...args) {
  try {
    if (!game?.settings?.get(MODULE_ID, "debugMode")) return;
  } catch {
    return;
  }
  console.debug(`${MODULE_ID} |`, ...args);
}

export function downloadData(filename, data, mimeType = "application/json") {
  const saveFile = foundry?.utils?.saveDataToFile;
  if (typeof saveFile === "function") {
    saveFile(data, mimeType, filename);
    return;
  }
  if (typeof globalThis.saveDataToFile === "function") {
    globalThis.saveDataToFile(data, mimeType, filename);
    return;
  }
  const blob = new Blob([data], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

// Opens Foundry's settings on the tab of this module.
export async function openModuleSettings() {
  const sheet = game.settings.sheet;
  await sheet.render({ force: true });
  try {
    sheet.changeTab(MODULE_ID, "categories");
  } catch (error) {
    console.warn(`${MODULE_ID} | The settings have no tab for this module`, error);
  }
  sheet.bringToFront?.();
}

// Puts a gear into the title bar of a window that opens the module settings. Players only get it when the module
// has settings for them.
export function addSettingsGear(frame) {
  const header = frame?.querySelector(".window-header");
  if (!header || header.querySelector(".scls-settings")) return;
  const own = (setting) => setting.namespace === MODULE_ID && setting.config && setting.scope !== "world";
  if (!isGM() && ![...game.settings.settings.values()].some(own)) return;
  const label = localize("SCLS.App.Settings");
  const gear = document.createElement("button");
  gear.type = "button";
  gear.className = "header-control icon fa-solid fa-gear scls-settings";
  gear.dataset.tooltip = label;
  gear.setAttribute("aria-label", label);
  gear.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    openModuleSettings();
  });
  const anchor = header.querySelector("[data-action=toggleControls]") ?? header.querySelector("[data-action=close]");
  if (anchor) anchor.before(gear);
  else header.append(gear);
}
