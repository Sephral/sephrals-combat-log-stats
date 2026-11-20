import { CrucibleSystemAdapter } from "./crucible-adapter.js";
import { Dnd5eSystemAdapter } from "./dnd5e-adapter.js";
import { Pf2eSystemAdapter } from "./pf2e-adapter.js";
import { GenericSystemAdapter } from "./generic-adapter.js";

const genericAdapter = new GenericSystemAdapter();
const adapters = new Map([
  [genericAdapter.id, genericAdapter],
  ["dnd5e", new Dnd5eSystemAdapter()],
  ["crucible", new CrucibleSystemAdapter()],
  ["pf2e", new Pf2eSystemAdapter()]
]);

export function getSystemAdapter(systemId = game?.system?.id ?? "generic") {
  return adapters.get(systemId) ?? genericAdapter;
}

export function getGenericAdapter() {
  return genericAdapter;
}
