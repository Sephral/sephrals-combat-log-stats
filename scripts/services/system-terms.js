// Texts that speak of hit points get their own wording in systems without hit points.
// Crucible has health, wounds, morale and madness: "SCLS.Report.Heal.With" becomes "SCLS.Crucible.Report.Heal.With".
const CRUCIBLE_KEYS = new Set([
  "SCLS.Report.Recap.Healing",
  "SCLS.Report.Recap.PartyDownOne",
  "SCLS.Report.Recap.PartyDownOther",
  "SCLS.Report.Recap.UnclearOne",
  "SCLS.Report.Recap.UnclearOther",
  "SCLS.Report.Count.DownOne",
  "SCLS.Report.Count.DownOther",
  "SCLS.Report.Count.PartyHealing",
  "SCLS.Report.Heal.With",
  "SCLS.Report.Heal.Plain",
  "SCLS.Report.Heal.SelfWith",
  "SCLS.Report.Heal.Self",
  "SCLS.Report.Aftermath.Down",
  "SCLS.Export.PartyDown",
  "SCLS.Export.Unclear",
  "SCLS.Warning.UnclearExcludedOne",
  "SCLS.Warning.UnclearExcludedOther",
  "SCLS.Warning.ManualIncludedOne",
  "SCLS.Warning.ManualIncludedOther",
  "SCLS.Label.NoCorrections",
  "SCLS.Label.AutomaticCorrections"
]);

export const CRUCIBLE_SYSTEM_ID = "crucible";

export function isCrucibleLog(logOrSystemId) {
  const systemId = typeof logOrSystemId === "string" ? logOrSystemId : logOrSystemId?.systemId;
  return systemId === CRUCIBLE_SYSTEM_ID;
}

export function termKey(systemId, key) {
  return systemId === CRUCIBLE_SYSTEM_ID && CRUCIBLE_KEYS.has(key) ? key.replace(/^SCLS\./, "SCLS.Crucible.") : key;
}

export const SYSTEM_TERM_KEYS = Object.freeze({ crucible: Object.freeze(Array.from(CRUCIBLE_KEYS)) });
