import { MODULE_ID, SETTINGS, TESTED_VERSIONS } from "./constants.js";
import { getSystemAdapter } from "./adapters/adapter-registry.js";
import { escapeHtml, format, getProperty, localize } from "./utils.js";
import { countFeature } from "./usage.mjs";

// Self-test: checks what the module relies on in Foundry and the game system. Meant to be run after every update of
// Foundry or the system; the GM also gets a notice once when a newer version than the verified one is installed.

const SUPPORTED_SYSTEMS = ["dnd5e", "crucible"];

// A character a player owns, to read its resources.
function playerCharacter() {
  const actors = Array.from(game.actors ?? []);
  return actors.find((actor) => actor.hasPlayerOwner && ["character", "hero"].includes(actor.type)) ?? actors.find((actor) => actor.hasPlayerOwner) ?? null;
}

async function checkIntegrations(service) {
  const problems = [];
  let checks = 0;
  const check = (ok, key, data) => {
    checks++;
    if (!ok) problems.push(format(`SCLS.SelfTest.${key}`, data));
  };

  check(!!game.users.activeGM, "NoGM");
  check(game.i18n.has("SCLS.App.Title"), "Texts");

  const adapter = getSystemAdapter();
  if (SUPPORTED_SYSTEMS.includes(game.system.id)) check(adapter.id === game.system.id, "Adapter", { system: game.system.title });

  const actor = playerCharacter();
  if (actor) {
    const paths = adapter.getResourcePaths();
    check(paths.some((path) => Number.isFinite(Number(getProperty(actor, path)))), "Resources", { name: actor.name, paths: paths.join(", ") });
  }
  if (game.system.id === "dnd5e") check(typeof CONFIG.Actor.documentClass?.prototype?.applyDamage === "function", "Dnd5eDamage");

  let index = null;
  try {
    index = await service?.persistence?.loadIndex();
  } catch (error) {
    console.warn(`${MODULE_ID} | Self-test could not read the combat logs`, error);
  }
  check(Array.isArray(index?.logs), "Storage");

  if (ui.combat?.rendered && ui.combat.viewed) check(!!ui.combat.element?.querySelector?.(".scls-combat-tracker-button"), "Tracker");
  return { problems, checks, actor };
}

// The installed versions next to the tested ones.
function versionLine() {
  const current = { core: game.version, [game.system.id]: game.system.version };
  return Object.entries(TESTED_VERSIONS)
    .filter(([id]) => id === "core" || id === game.system.id)
    .map(([id, tested]) => format("SCLS.SelfTest.Version", { id, current: current[id] ?? "–", tested }))
    .join(", ");
}

// Runs the self-test and reports the result as a notification and a whispered chat message.
export async function runSelfTest(service, { report = true } = {}) {
  countFeature(MODULE_ID, "selfTestRun");
  const { problems, checks, actor } = await checkIntegrations(service);
  const adapter = getSystemAdapter();
  const support = SUPPORTED_SYSTEMS.includes(adapter.id) ? game.system.title : localize("SCLS.SelfTest.Generic");
  const summary = problems.length
    ? format("SCLS.SelfTest.Problems", { problems: problems.length, checks })
    : format("SCLS.SelfTest.Passed", { checks, system: support });

  if (problems.length) ui.notifications.warn(summary, { permanent: true });
  else ui.notifications.info(summary);

  if (report) {
    let content = `<h3>${escapeHtml(localize("SCLS.SelfTest.Title"))}</h3><p>${escapeHtml(summary)}</p><p><small>${escapeHtml(versionLine())}</small></p>`;
    if (problems.length) content += `<ul>${problems.map((problem) => `<li>${escapeHtml(problem)}</li>`).join("")}</ul>`;
    if (!actor) content += `<p><small>${escapeHtml(localize("SCLS.SelfTest.NoCharacter"))}</small></p>`;
    const cls = foundry.documents.ChatMessage.implementation;
    await cls.create({ content, whisper: [game.user.id], speaker: { alias: game.modules.get(MODULE_ID).title } });
  }
  return { problems, checks };
}

// Tells the GM once when Foundry or the system is newer than the versions the module was verified against.
export function noticeNewVersions() {
  if (!game.user.isGM) return;
  const current = { core: game.version, [game.system.id]: game.system.version };
  const newer = Object.entries(current)
    .filter(([id, version]) => version && TESTED_VERSIONS[id] && foundry.utils.isNewerVersion(version, TESTED_VERSIONS[id]))
    .map(([id, version]) => `${id} ${version}`);
  if (!newer.length) return;
  const signature = newer.join(",");
  if (game.settings.get(MODULE_ID, SETTINGS.ACKNOWLEDGED_VERSIONS) === signature) return;
  game.settings.set(MODULE_ID, SETTINGS.ACKNOWLEDGED_VERSIONS, signature);
  ui.notifications.info(format("SCLS.SelfTest.NewVersions", { versions: newer.join(", ") }), { permanent: true });
}

// The menu button which runs the self-test. Foundry only accepts application classes as menus; this one runs the test
// instead of opening a window. Built on demand, so the unit tests can load the settings without Foundry.
export function selfTestMenuClass(getService) {
  return class CombatLogSelfTestMenu extends foundry.applications.api.ApplicationV2 {
    async render() {
      if (game.user.isGM) await runSelfTest(getService());
      return this;
    }
  };
}
