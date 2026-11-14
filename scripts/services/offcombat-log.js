import { format, formatDateRange, formatDateTime, localize } from "../utils.js";
import { SESSION_GAP_MS } from "./session-service.js";

// The log outside fights: hit point and condition changes, deaths and rests between the fights, grouped into game
// nights. It is kept lean on purpose. An event is a handful of short fields, changes of the same pool made in quick
// succession are one entry, a night keeps at most MAX_EVENTS entries and only the latest MAX_NIGHTS nights are kept.
//
// Event fields: t time (ms), k kind, i actor id, n actor name, p 1 for a player character, and by kind
//   hp    q pool (hp, health, wounds ...), d change, v value afterwards, m maximum, c count of merged changes
//   down  q pool (the pool dropped to 0)
//   cond  c condition name, s 1 added or -1 removed
//   death (an effect with the status dead or defeated was added)
//   rest  r short, long or rest, d hit points regained

export const KINDS = Object.freeze({ HP: "hp", DOWN: "down", COND: "cond", DEATH: "death", REST: "rest" });
export const MAX_NIGHTS = 20;
export const MAX_EVENTS = 200;
// Changes of one actor and pool in the same direction within this time are one entry (a typed number, three hits in a row).
export const MERGE_WINDOW_MS = 30 * 1000;
const NAME_LENGTH = 40;
export const NIGHT_PREFIX = "night-";

export function emptyState() {
  return { v: 1, nights: [] };
}

/** A state read from storage: a clean list of nights, oldest first. Anything unknown is dropped. */
export function normalizeState(raw) {
  const nights = (Array.isArray(raw?.nights) ? raw.nights : [])
    .filter((night) => night && Array.isArray(night.events))
    .map((night) => {
      const events = night.events.filter((event) => event && Number.isFinite(Number(event.t)) && event.k).map((event) => ({ ...event, t: Number(event.t) }));
      if (!events.length) return null;
      const times = events.map((event) => event.t);
      return { id: String(night.id ?? `n${Math.min(...times).toString(36)}`), from: Math.min(...times), to: Math.max(...times), dropped: Number(night.dropped) || 0, events };
    })
    .filter(Boolean)
    .sort((left, right) => left.from - right.from);
  return { v: 1, nights };
}

export function shortName(name) {
  const text = String(name ?? "").trim();
  return text.length > NAME_LENGTH ? `${text.slice(0, NAME_LENGTH - 1)}…` : text;
}

/** The pool a resource path belongs to: system.attributes.hp.value is "hp", system.resources.health.value is "health". */
export function poolOf(path) {
  const parts = String(path ?? "").split(".");
  return parts.length > 1 ? parts.at(-2) : parts[0] ?? "";
}

/**
 * The changes between two snapshots of resource values ({ path: number }), for the paths that end in .value.
 * @returns {{path: string, pool: string, oldValue: number, newValue: number, delta: number}[]}
 */
export function poolChanges(before = {}, after = {}, paths = []) {
  const changes = [];
  for (const path of paths) {
    if (!String(path).endsWith(".value")) continue;
    const oldValue = Number(before?.[path]);
    const newValue = Number(after?.[path]);
    if (!Number.isFinite(oldValue) || !Number.isFinite(newValue) || oldValue === newValue) continue;
    changes.push({ path, pool: poolOf(path), oldValue, newValue, delta: newValue - oldValue });
  }
  return changes;
}

/**
 * Adds an event to the state: to the night it belongs to (the last one unless the pause is longer than gapMs),
 * merged with the previous change of the same actor and pool when it came right after. Then trims the state.
 * @returns {object} the same state
 */
export function appendEvent(state, event, { gapMs = SESSION_GAP_MS, maxEvents = MAX_EVENTS, maxNights = MAX_NIGHTS, retentionDays = 0, now = event?.t } = {}) {
  if (!event || !Number.isFinite(Number(event.t)) || !event.k) return state;
  const entry = { ...event, t: Number(event.t), n: shortName(event.n) };
  // The night this time falls into (the latest first: entries come in order, a late one may belong to an older night).
  let night = state.nights.findLast((candidate) => entry.t >= candidate.from - gapMs && entry.t <= candidate.to + gapMs);
  if (!night) {
    night = { id: `n${entry.t.toString(36)}`, from: entry.t, to: entry.t, dropped: 0, events: [] };
    state.nights.push(night);
    state.nights.sort((left, right) => left.from - right.from);
  }
  const last = night.events.at(-1);
  if (last && last.t <= entry.t && entry.k === KINDS.HP && last.k === KINDS.HP && last.i === entry.i && last.q === entry.q
    && Math.sign(last.d) === Math.sign(entry.d) && entry.t - last.t <= MERGE_WINDOW_MS) {
    last.d += entry.d;
    last.v = entry.v;
    last.m = entry.m ?? last.m;
    last.c = (last.c ?? 1) + 1;
    last.t = entry.t;
  } else night.events.push(entry);
  night.from = Math.min(night.from, entry.t);
  night.to = Math.max(night.to, entry.t);
  if (night.events.length > maxEvents) {
    const overflow = night.events.length - maxEvents;
    night.events.splice(0, overflow);
    night.dropped += overflow;
  }
  trim(state, { maxNights, retentionDays, now });
  return state;
}

/** Keeps the latest maxNights nights and, with retentionDays, no night older than that. */
export function trim(state, { maxNights = MAX_NIGHTS, retentionDays = 0, now = Date.now() } = {}) {
  if (retentionDays > 0) {
    const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
    state.nights = state.nights.filter((night) => night.to >= cutoff);
  }
  if (state.nights.length > maxNights) state.nights.splice(0, state.nights.length - maxNights);
  return state;
}

/** All events of the state, oldest first. */
export function allEvents(state) {
  return (state?.nights ?? []).flatMap((night) => night.events);
}

/**
 * Sorts events into the game sessions of the fights: an event belongs to the nearest session when it lies inside it or
 * less than gapMs outside. The rest is loose: nights without a fight.
 * @param {{id: string, startedAt: string, endedAt: string}[]} sessions  As groupSessions returns them
 * @returns {{bySession: Map<string, object[]>, loose: object[]}}
 */
export function assignToSessions(sessions = [], events = [], { gapMs = SESSION_GAP_MS } = {}) {
  const bySession = new Map(sessions.map((session) => [session.id, []]));
  const loose = [];
  const bounds = sessions.map((session) => ({ id: session.id, from: new Date(session.startedAt).getTime(), to: new Date(session.endedAt).getTime() }))
    .filter((entry) => Number.isFinite(entry.from) && Number.isFinite(entry.to));
  for (const event of events) {
    let best = null;
    for (const entry of bounds) {
      const distance = event.t < entry.from ? entry.from - event.t : event.t > entry.to ? event.t - entry.to : 0;
      if (distance <= gapMs && (!best || distance < best.distance)) best = { id: entry.id, distance };
    }
    if (best) bySession.get(best.id).push(event);
    else loose.push(event);
  }
  return { bySession, loose };
}

/** Events without a fight, grouped into nights, the latest first. */
export function looseNights(events = [], { gapMs = SESSION_GAP_MS } = {}) {
  const sorted = [...events].sort((left, right) => left.t - right.t);
  const nights = [];
  for (const event of sorted) {
    const night = nights.at(-1);
    if (night && event.t - night.to <= gapMs) {
      night.events.push(event);
      night.to = event.t;
    } else nights.push({ id: `${NIGHT_PREFIX}${event.t.toString(36)}`, from: event.t, to: event.t, events: [event] });
  }
  return nights.reverse().map((night) => ({ ...night, startedAt: new Date(night.from).toISOString(), endedAt: new Date(night.to).toISOString() }));
}

/** What the events add up to, overall and per actor, for the cards and the rows of a night. */
export function nightTotals(events = []) {
  const totals = { events: events.length, lost: 0, regained: 0, downs: 0, conditions: 0, deaths: 0, rests: 0 };
  const actors = new Map();
  const row = (event) => {
    const key = event.i || event.n || "?";
    if (!actors.has(key)) actors.set(key, { id: key, name: event.n || "", party: Boolean(event.p), lost: 0, regained: 0, downs: 0, conditions: 0, deaths: 0, rests: 0 });
    return actors.get(key);
  };
  for (const event of events) {
    const actor = row(event);
    if (event.k === KINDS.HP && isLifePool(event.q)) {
      if (event.d < 0) {
        totals.lost -= event.d;
        actor.lost -= event.d;
      } else {
        totals.regained += event.d;
        actor.regained += event.d;
      }
    } else if (event.k === KINDS.DOWN) {
      totals.downs += 1;
      actor.downs += 1;
    } else if (event.k === KINDS.COND && event.s > 0) {
      totals.conditions += 1;
      actor.conditions += 1;
    } else if (event.k === KINDS.DEATH) {
      totals.deaths += 1;
      actor.deaths += 1;
    } else if (event.k === KINDS.REST) {
      totals.rests += 1;
      actor.rests += 1;
    }
  }
  return { totals, actors: Array.from(actors.values()).sort((left, right) => (right.lost - left.lost) || left.name.localeCompare(right.name)) };
}

// Hit points and health lose and regain. Wounds, morale and madness change in either direction without a verdict.
export function isLifePool(pool) {
  return pool === "hp" || pool === "health";
}

/** One line of the log as a text. */
export function describeEvent(event) {
  const name = event.n || localize("SCLS.Report.Fallback.Someone");
  switch (event.k) {
    case KINDS.HP: {
      const pool = poolLabel(event.q);
      const amount = Math.abs(event.d);
      if (!isLifePool(event.q)) return format("SCLS.OffCombat.Change", { name, pool, change: `${event.d > 0 ? "+" : "−"}${amount}`, value: event.v });
      return format(event.d < 0 ? "SCLS.OffCombat.Lost" : "SCLS.OffCombat.Regained", { name, amount, pool, value: event.v, max: event.m ?? "?" });
    }
    case KINDS.DOWN: return format("SCLS.OffCombat.Down", { name, pool: poolLabel(event.q) });
    case KINDS.COND: return format(event.s > 0 ? "SCLS.OffCombat.ConditionAdded" : "SCLS.OffCombat.ConditionRemoved", { name, condition: event.c ?? "" });
    case KINDS.DEATH: return format("SCLS.OffCombat.Death", { name });
    case KINDS.REST: {
      const text = format(event.r === "long" ? "SCLS.OffCombat.LongRest" : event.r === "short" ? "SCLS.OffCombat.ShortRest" : "SCLS.OffCombat.Rest", { name });
      const amount = Math.max(0, Number(event.d) || 0);
      return amount > 0 ? `${text} (${format("SCLS.OffCombat.RestRegained", { amount })})` : text;
    }
    default: return name;
  }
}

function poolLabel(pool) {
  const key = `SCLS.OffCombat.Pool.${pool}`;
  const text = localize(key);
  return text === key ? String(pool ?? "") : text;
}

/** How an event looks in the list: tone and icon. */
export function eventLook(event) {
  switch (event.k) {
    case KINDS.HP: return isLifePool(event.q) ? { tone: event.d < 0 ? "damage" : "healing", icon: event.d < 0 ? "fa-solid fa-heart-crack" : "fa-solid fa-heart-pulse" } : { tone: "", icon: "fa-solid fa-droplet" };
    case KINDS.DOWN: return { tone: "damage", icon: "fa-solid fa-arrow-down" };
    case KINDS.COND: return { tone: "", icon: event.s > 0 ? "fa-solid fa-circle-plus" : "fa-solid fa-circle-minus" };
    case KINDS.DEATH: return { tone: "damage", icon: "fa-solid fa-skull" };
    case KINDS.REST: return { tone: "healing", icon: "fa-solid fa-bed" };
    default: return { tone: "", icon: "fa-solid fa-circle" };
  }
}

/**
 * The block of the Sessions tab for the events of one session or night: cards, a row per actor and the lines, newest
 * last like a journal. limit: lines shown, the rest counted.
 */
export function betweenFightsPanel(events = [], { dropped = 0, limit = 120 } = {}) {
  const sorted = [...events].sort((left, right) => left.t - right.t);
  const { totals, actors } = nightTotals(sorted);
  const shown = sorted.slice(-limit);
  return {
    has: sorted.length > 0,
    count: sorted.length,
    cards: [
      { tone: "damage", label: localize("SCLS.OffCombat.Label.Lost"), value: String(totals.lost) },
      { tone: "healing", label: localize("SCLS.OffCombat.Label.Regained"), value: String(totals.regained) },
      { tone: "hostile", label: localize("SCLS.OffCombat.Label.Downs"), value: String(totals.downs + totals.deaths) },
      { tone: "", label: localize("SCLS.OffCombat.Label.Conditions"), value: String(totals.conditions) },
      { tone: "", label: localize("SCLS.OffCombat.Label.Rests"), value: String(totals.rests) }
    ],
    actors: actors.map((actor) => ({ name: actor.name || localize("SCLS.Report.Fallback.Someone"), lost: actor.lost, regained: actor.regained, downs: actor.downs + actor.deaths, conditions: actor.conditions, rests: actor.rests })),
    lines: shown.map((event) => ({ time: formatDateTime(event.t), text: describeEvent(event), ...eventLook(event) })),
    hiddenCount: sorted.length - shown.length,
    dropped,
    note: dropped > 0 ? format("SCLS.OffCombat.Dropped", { count: dropped }) : ""
  };
}

export function nightLabel(night) {
  return format("SCLS.OffCombat.NightOption", { date: formatDateRange(night.startedAt, night.endedAt), count: night.events.length });
}

export const __test__ = { NAME_LENGTH };
