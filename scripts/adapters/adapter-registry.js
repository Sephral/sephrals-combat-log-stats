import { Dnd5eSystemAdapter } from "./dnd5e-adapter.js";
import { GenericSystemAdapter } from "./generic-adapter.js";

const genericAdapter = new GenericSystemAdapter();
const adapters = new Map([
  [genericAdapter.id, genericAdapter],
  ["dnd5e", new Dnd5eSystemAdapter()]
]);

export function getSystemAdapter(systemId = game?.system?.id ?? "generic") {
  return adapters.get(systemId) ?? genericAdapter;
}

export function getGenericAdapter() {
  return genericAdapter;
}
