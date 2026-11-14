import { getSystemAdapter } from "../adapters/adapter-registry.js";
import { HOOKS, MODULE_ID, OFF_COMBAT_SCOPES, SETTINGS } from "../constants.js";
import { getSetting } from "../settings.js";
import { getProperty, isTrackingGM } from "../utils.js";
import { AUTOMATIC_STATUSES } from "./event-insights.js";
import { KINDS, isLifePool, poolChanges, poolOf, shortName } from "./offcombat-log.js";
import { countFeature } from "../usage.mjs";
import { OffCombatStore } from "./offcombat-store.js";

// The log outside fights. The recording GM turns hit point and condition changes, deaths and rests of actors that
// are not in a running fight into short entries of the current game night (offcombat-log.js, offcombat-store.js).
// Fights have their own log; an actor that takes part in one is left out here.

// Updates of one rest that come this close together belong to the same entry.
const REST_WINDOW_MS = 15000;
const DEATH_STATUSES = new Set(["dead", "defeated"]);

/** Scope check, pure: a player character, or any actor when the scope says so. */
export function inScope(actor, scope = OFF_COMBAT_SCOPES.PARTY) {
  if (!actor) return false;
  if (scope === OFF_COMBAT_SCOPES.ALL) return true;
  return Boolean(actor.hasPlayerOwner);
}

/** The condition shown for an effect: its name, or the status id when it has none. null for effects that are no condition. */
export function conditionOf(effect) {
  const statuses = Array.from(effect?.statuses ?? []).map(String);
  if (!statuses.length) return null;
  if (statuses.some((status) => DEATH_STATUSES.has(status))) return { death: true, name: String(effect?.name ?? statuses[0]) };
  // Statuses the game sets by itself (bloodied, concentrating, encumbered) would flood the log.
  if (statuses.every((status) => AUTOMATIC_STATUSES.includes(status))) return null;
  return { death: false, name: String(effect?.name ?? effect?.label ?? statuses[0]) };
}

export class OffCombatService {
  /**
   * @param {object} combatLogs  The CombatLogService (its persistence helpers and the running fights)
   */
  constructor(combatLogs) {
    this.combatLogs = combatLogs;
    this.store = new OffCombatStore(combatLogs.persistence);
    // Last known values of the tracked pools per actor. An update only carries the new values.
    this.snapshots = new Map();
  }

  get enabled() {
    return getSetting(SETTINGS.OFF_COMBAT_LOG, true) !== false;
  }

  get scope() {
    return getSetting(SETTINGS.OFF_COMBAT_SCOPE, OFF_COMBAT_SCOPES.PARTY);
  }

  get adapter() {
    return getSystemAdapter(globalThis.game?.system?.id ?? "generic");
  }

  // The tracked paths of the system: the pools with a current value.
  paths() {
    const configured = getSetting(SETTINGS.RESOURCE_PATHS, {})?.[globalThis.game?.system?.id];
    return (Array.isArray(configured) && configured.length ? configured : this.adapter.getResourcePaths()).filter((path) => String(path).endsWith(".value"));
  }

  read(actor) {
    const values = {};
    for (const path of this.paths()) {
      const value = Number(getProperty(actor, path));
      if (Number.isFinite(value)) values[path] = value;
    }
    return values;
  }

  /** Remembers the values of the actors, so the first change of each is not lost. */
  snapshotAll() {
    for (const actor of globalThis.game?.actors ?? []) this.snapshot(actor);
    for (const token of globalThis.canvas?.scene?.tokens ?? []) if (token.actor) this.snapshot(token.actor);
  }

  snapshot(actor) {
    if (actor?.uuid) this.snapshots.set(actor.uuid, this.read(actor));
  }

  // Actors in a running fight are in its log.
  inFight(actor) {
    return this.combatLogs.findLogsForActor?.(actor)?.length > 0;
  }

  base(actor, now) {
    return { t: now, i: actor.id ?? "", n: shortName(actor.name), ...(actor.hasPlayerOwner ? { p: 1 } : {}) };
  }

  async actorUpdated(actor, _changed = {}, options = {}, now = Date.now()) {
    if (!actor?.uuid) return null;
    const before = this.snapshots.get(actor.uuid);
    const after = this.read(actor);
    this.snapshots.set(actor.uuid, after);
    if (!this.enabled || !before) return null;
    if (!inScope(actor, this.scope) || this.inFight(actor)) return null;
    // A rest restores hit points and more. It is one entry, whatever it changed.
    if (options?.isRest) {
      const regained = poolChanges(before, after, this.paths()).filter((change) => isLifePool(change.pool) && change.delta > 0).reduce((total, change) => total + change.delta, 0);
      return this.restSeen(actor, regained, now);
    }
    const events = [];
    for (const change of poolChanges(before, after, this.paths())) {
      events.push({ ...this.base(actor, now), k: KINDS.HP, q: change.pool, d: change.delta, v: change.newValue, m: this.maxOf(actor, change.path) });
      if (isLifePool(change.pool) && change.oldValue > 0 && change.newValue <= 0) events.push({ ...this.base(actor, now), k: KINDS.DOWN, q: change.pool });
    }
    for (const event of events) await this.add(event);
    return events;
  }

  maxOf(actor, path) {
    const max = Number(getProperty(actor, path.replace(/\.value$/, ".max")));
    return Number.isFinite(max) ? max : undefined;
  }

  async effectChanged(effect, added, now = Date.now()) {
    const actor = effect?.parent?.documentName === "Actor" ? effect.parent : null;
    if (!actor || !this.enabled || !inScope(actor, this.scope) || this.inFight(actor)) return null;
    const condition = conditionOf(effect);
    if (!condition) return null;
    // A removed death status is a revival, which the hit points tell.
    if (condition.death && !added) return null;
    const event = condition.death
      ? { ...this.base(actor, now), k: KINDS.DEATH }
      : { ...this.base(actor, now), k: KINDS.COND, c: shortName(condition.name), s: added ? 1 : -1 };
    await this.add(event);
    return event;
  }

  // Updates made by a rest (update option isRest, which every client gets). Several updates of one rest are one entry.
  async restSeen(actor, regained = 0, now = Date.now()) {
    const night = (await this.store.load()).nights.at(-1);
    const last = night?.events.findLast((event) => event.k === KINDS.REST && event.i === actor.id && now - event.t <= REST_WINDOW_MS);
    if (last) {
      last.d += regained;
      this.store.dirty = true;
      this.store.schedule();
      return [last];
    }
    const event = { ...this.base(actor, now), k: KINDS.REST, r: "rest", d: regained };
    await this.add(event);
    return [event];
  }

  // dnd5e tells the kind of rest only to the client that rested (hook dnd5e.restCompleted): it names the entry.
  async restCompleted(actor, result = {}, now = Date.now()) {
    if (!actor || !this.enabled || !isTrackingGM()) return null;
    const night = (await this.store.load()).nights.at(-1);
    const last = night?.events.findLast((event) => event.k === KINDS.REST && event.i === actor.id && now - event.t <= REST_WINDOW_MS);
    const kind = result?.longRest || result?.type === "long" ? "long" : result?.type === "short" ? "short" : "rest";
    // A rest that changed nothing with the rest flag (a short rest whose hit dice were spent beforehand) has no entry yet.
    if (!last) {
      if (!inScope(actor, this.scope) || this.inFight(actor)) return null;
      const event = { ...this.base(actor, now), k: KINDS.REST, r: kind, d: 0 };
      await this.add(event);
      return event;
    }
    last.r = kind === "rest" ? last.r : kind;
    this.store.dirty = true;
    this.store.schedule();
    return last;
  }

  // Every GM keeps its snapshots, so a GM who takes over has the last values. Only the recording GM writes.
  async add(event) {
    if (!isTrackingGM()) return;
    const known = (await this.store.load()).nights.at(-1)?.id;
    await this.store.add(event, { retentionDays: Number(getSetting(SETTINGS.RETENTION_DAYS, 0)) || 0 });
    // One count per game night with a first entry.
    if ((await this.store.load()).nights.at(-1)?.id !== known) countFeature(MODULE_ID, "offCombatLogged");
    // An open window shows the new entry.
    globalThis.Hooks?.callAll?.(HOOKS.OFF_COMBAT_UPDATED);
  }

  async flush() {
    return this.store.flush({ retentionDays: Number(getSetting(SETTINGS.RETENTION_DAYS, 0)) || 0 });
  }

  /** The nights as stored. */
  async nights() {
    return (await this.store.load()).nights;
  }

  async snapshotState() {
    return this.store.snapshot();
  }
}

export const __test__ = { DEATH_STATUSES, MODULE_ID, poolOf };
