import { CONFIDENCE, EVENT_TYPES, HOOKS, MODULE_ID, RESOURCE_INTERPRETATIONS, SETTINGS, SHARE_MODES, SIDES, SOURCE_KINDS, TABS, VISIBILITY } from "../constants.js";
import { getSetting } from "../settings.js";
import { formatDateTime, formatDuration, localize, renderAppTemplate } from "../utils.js";
import { CombatLogExportService } from "../services/export-service.js";
import { PlayerReportService } from "../services/player-report-service.js";

const DEFAULT_POSITION = { width: 1120, height: 760 };

export class CombatLogApp extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-app`,
    classes: ["scls-window"],
    tag: "section",
    position: DEFAULT_POSITION,
    window: {
      title: localize("SCLS.App.Title"),
      icon: "fa-solid fa-chart-line",
      resizable: true
    },
    actions: {
      switchTab: CombatLogApp.#onTab,
      classify: CombatLogApp.#onClassify,
      addManualAdjustment: CombatLogApp.#onAddManualAdjustment,
      ignoreEvent: CombatLogApp.#onIgnoreEvent,
      restoreEvent: CombatLogApp.#onRestoreEvent,
      setSide: CombatLogApp.#onSetSide,
      toggleSharing: CombatLogApp.#onToggleSharing,
      postPlayerReport: CombatLogApp.#onPostPlayerReport,
      createJournalReport: CombatLogApp.#onCreateJournalReport,
      exportJson: CombatLogApp.#onExportJson,
      exportMarkdown: CombatLogApp.#onExportMarkdown,
      openLog: CombatLogApp.#onOpenLog
    }
  };

  constructor(service, logId = null, options = {}) {
    super({ ...options, position: { ...DEFAULT_POSITION, ...(options.position ?? {}) } });
    this.service = service;
    this.logId = logId;
    this.activeTab = logId ? "summary" : "history";
    this.exporter = new CombatLogExportService();
    this.playerReports = new PlayerReportService();
    this.liveRenderQueued = false;
    this.onLogUpdated = (log) => this.scheduleLiveRender(log);
    globalThis.Hooks?.on?.(HOOKS.LOG_UPDATED, this.onLogUpdated);
  }

  async close(options = {}) {
    globalThis.Hooks?.off?.(HOOKS.LOG_UPDATED, this.onLogUpdated);
    return super.close(options);
  }

  async _renderHTML(context) {
    return renderAppTemplate(`modules/${MODULE_ID}/templates/combat-log-app.hbs`, context);
  }

  _replaceHTML(result, content) {
    content.innerHTML = result;
  }

  async getLog() {
    if (this.logId) return this.service.persistence.loadLog(this.logId);
    return this.service.listActiveLogs()[0] ?? null;
  }

  async _prepareContext(_options) {
    const log = await this.getLog();
    const historyEntries = await this.service.persistence.loadHistoryEntries();
    if (!log) {
      this.activeTab = "history";
      return {
        hasLog: false,
        hasHistory: historyEntries.length > 0,
        activeTab: this.activeTab,
        tabs: visibleTabs(false, this.activeTab),
        historyRows: historyRows(historyEntries)
      };
    }
    if (!TABS.includes(this.activeTab)) this.activeTab = "summary";
    const computed = log.computed ?? {};
    return {
      hasLog: true,
      hasHistory: historyEntries.length > 0,
      log,
      computed,
      activeTab: this.activeTab,
      tabs: visibleTabs(true, this.activeTab),
      historyRows: historyRows(historyEntries, log.id),
      summary: summaryContext(log),
      timelineEvents: timelineEvents(log),
      correctionEvents: correctionEvents(log),
      manualAdjustmentEvents: manualAdjustmentEvents(log),
      participants: participantRows(log),
      manualAdjustmentParticipants: manualAdjustmentParticipants(log),
      manualAdjustmentTypes: manualAdjustmentTypes(),
      dprRows: computed.dpr?.byCombatant ?? [],
      sideRows: computed.dpr?.bySide ?? [],
      rawEvents: log.events ?? [],
      shareModes: Object.values(SHARE_MODES).map((value) => ({ value, label: localize(`SCLS.ShareMode.${value}`), selected: log.shareSettings?.shareMode === value })),
      canShareReport: this.playerReports.canShare(log),
      includeUnclearDeltasInStats: getSetting(SETTINGS.INCLUDE_UNCLEAR_DELTAS_IN_STATS, false)
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    for (const panel of this.element.querySelectorAll("[data-panel]")) panel.hidden = panel.dataset.panel !== this.activeTab;
    for (const element of this.element.querySelectorAll("[data-detail-only]")) element.hidden = this.activeTab === "history";
  }

  async saveLog(log) {
    await this.service.saveAndCompute(log);
    await this.render();
  }

  scheduleLiveRender(log) {
    if (this.logId && log?.id !== this.logId) return;
    if (this.liveRenderQueued || !this.element?.isConnected) return;
    this.liveRenderQueued = true;
    setTimeout(() => {
      this.liveRenderQueued = false;
      void this.render();
    }, 100);
  }

  static async #onTab(event, target) {
    this.activeTab = target.dataset.tab;
    await this.render();
  }

  static async #onOpenLog(_event, target) {
    this.logId = target.dataset.logId;
    this.activeTab = "summary";
    await this.render();
  }

  static async #onClassify(event, target) {
    const log = await this.getLog();
    const eventId = target.dataset.eventId;
    const eventEntry = log?.events?.find((entry) => entry.id === eventId);
    if (!eventEntry) return;
    eventEntry.data.interpretedAs = target.value;
    eventEntry.confidence = "manual";
    eventEntry.data.manualCorrection = true;
    await this.saveLog(log);
  }

  static async #onAddManualAdjustment(_event, target) {
    const log = await this.getLog();
    if (!log) return;
    const form = target.closest("form");
    const formData = new FormData(form);
    const amount = Math.abs(Number(formData.get("amount")));
    if (!Number.isFinite(amount) || amount <= 0) return;
    const adjustmentType = String(formData.get("adjustmentType") ?? "");
    const eventType = manualAdjustmentEventType(adjustmentType);
    if (!eventType) return;
    const combatantId = String(formData.get("combatantId") ?? "");
    const participant = log.participants?.find((entry) => entry.combatantId === combatantId) ?? null;
    log.events.push({
      id: foundry?.utils?.randomID?.() ?? `manual-${Date.now()}`,
      type: eventType,
      createdAt: new Date().toISOString(),
      sequence: (log.events?.length ?? 0) + 1,
      round: game?.combat?.round ?? null,
      turn: game?.combat?.turn ?? null,
      combatantId: participant?.combatantId ?? combatantId,
      actorUuid: participant?.actorUuid ?? "",
      tokenUuid: participant?.tokenUuid ?? "",
      sceneUuid: log.sceneUuid,
      userId: game?.user?.id ?? "",
      visibility: VISIBILITY.GM,
      source: { kind: SOURCE_KINDS.MANUAL, id: adjustmentType },
      confidence: CONFIDENCE.MANUAL,
      ignored: false,
      tags: ["manual-adjustment"],
      data: { amount, adjustmentType, note: String(formData.get("note") ?? "") }
    });
    form.reset();
    await this.saveLog(log);
  }

  static async #onIgnoreEvent(_event, target) {
    const log = await this.getLog();
    const eventEntry = log?.events?.find((entry) => entry.id === target.dataset.eventId);
    if (!eventEntry) return;
    eventEntry.ignored = true;
    await this.saveLog(log);
  }

  static async #onRestoreEvent(_event, target) {
    const log = await this.getLog();
    const eventEntry = log?.events?.find((entry) => entry.id === target.dataset.eventId);
    if (!eventEntry) return;
    eventEntry.ignored = false;
    await this.saveLog(log);
  }

  static async #onSetSide(event, target) {
    const log = await this.getLog();
    const participant = log?.participants?.find((entry) => entry.combatantId === target.dataset.combatantId);
    if (!participant) return;
    participant.side = target.value;
    await this.saveLog(log);
  }

  static async #onToggleSharing(event, target) {
    const log = await this.getLog();
    if (!log) return;
    const form = target.closest("form");
    const formData = new FormData(form);
    log.shareSettings = {
      ...log.shareSettings,
      isShared: Boolean(formData.get("isShared")),
      shareMode: String(formData.get("shareMode") ?? SHARE_MODES.GM_ONLY),
      includePartyStats: Boolean(formData.get("includePartyStats")),
      includeEnemyStats: Boolean(formData.get("includeEnemyStats")),
      includeNpcNames: Boolean(formData.get("includeNpcNames")),
      includeHiddenCombatants: Boolean(formData.get("includeHiddenCombatants")),
      includePrivateRolls: Boolean(formData.get("includePrivateRolls")),
      includeGMNotes: Boolean(formData.get("includeGMNotes")),
      includeUnclearEvents: Boolean(formData.get("includeUnclearEvents")),
      includeDPR: Boolean(formData.get("includeDPR")),
      includeTimeline: Boolean(formData.get("includeTimeline")),
      includeCorrections: Boolean(formData.get("includeCorrections")),
      anonymizeEnemies: Boolean(formData.get("anonymizeEnemies")),
      allowPlayersToOpenReport: Boolean(formData.get("allowPlayersToOpenReport")),
      shareUpdatedAt: new Date().toISOString()
    };
    if (log.shareSettings.isShared && !log.shareSettings.shareStartedAt) log.shareSettings.shareStartedAt = log.shareSettings.shareUpdatedAt;
    await this.saveLog(log);
  }

  static async #onPostPlayerReport() {
    const log = await this.getLog();
    if (!log) return;
    await this.playerReports.postChatSummary(log);
    await this.saveLog(log);
  }

  static async #onCreateJournalReport() {
    const log = await this.getLog();
    if (!log) return;
    await this.playerReports.createJournalReport(log);
    await this.saveLog(log);
  }

  static async #onExportJson() {
    const log = await this.getLog();
    if (!log) return;
    this.exporter.appendExportEvent(log, "json");
    this.exporter.exportJson(log);
    await this.saveLog(log);
  }

  static async #onExportMarkdown() {
    const log = await this.getLog();
    if (!log) return;
    this.exporter.appendExportEvent(log, "markdown");
    this.exporter.exportMarkdown(log);
    await this.saveLog(log);
  }
}

function summaryContext(log) {
  return {
    title: log.title,
    status: log.status,
    startedAt: formatDateTime(log.startedAt),
    endedAt: log.endedAt ? formatDateTime(log.endedAt) : "-",
    activeDuration: formatDuration(log.computed?.summary?.activeDurationMs ?? 0),
    sessionCount: log.sessionSegments?.length ?? 0,
    rounds: log.computed?.summary?.rounds ?? 0,
    participants: log.participants?.length ?? 0,
    warnings: log.computed?.warnings ?? []
  };
}

function visibleTabs(hasLog, activeTab) {
  return TABS.filter((id) => hasLog || id === "history").map((id) => ({ id, label: localize(`SCLS.Tab.${id}`), active: id === activeTab }));
}

function historyRows(entries, selectedLogId = "") {
  return (entries ?? []).map((entry) => ({
    ...entry,
    selected: entry.combatLogId === selectedLogId,
    startedLabel: formatDateTime(entry.startedAt),
    endedLabel: entry.endedAt ? formatDateTime(entry.endedAt) : "-",
    lastSeenLabel: entry.lastSeenAt ? formatDateTime(entry.lastSeenAt) : "-",
    statusLabel: localize(`SCLS.Status.${entry.status}`),
    loadedLabel: entry.loaded ? localize("SCLS.Label.Stored") : localize("SCLS.Label.IndexOnly")
  }));
}

function timelineEvents(log) {
  return (log.events ?? []).map((event) => ({
    ...event,
    label: naturalEventLabel(event),
    createdLabel: formatDateTime(event.createdAt)
  }));
}

function correctionEvents(log) {
  return (log.events ?? [])
    .filter((event) => [EVENT_TYPES.RESOURCE_DELTA, EVENT_TYPES.RESOURCE_DELTA_OFFLINE].includes(event.type))
    .filter((event) => event.confidence === CONFIDENCE.UNCLEAR || event.data?.correlation?.status === "ambiguous" || event.data?.manualCorrection)
    .map((event) => ({
      ...event,
      interpretationOptions: interpretationOptions(event.data?.interpretedAs)
    }));
}

function manualAdjustmentEvents(log) {
  return (log.events ?? [])
    .filter((event) => isManualAdjustmentEvent(event))
    .map((event) => {
      const participant = (log.participants ?? []).find((entry) => entry.combatantId === event.combatantId || entry.actorUuid === event.actorUuid);
      return {
        ...event,
        label: manualAdjustmentLabel(event),
        amount: event.data?.amount ?? 0,
        note: event.data?.note ?? "",
        participantName: participant?.name ?? event.combatantId ?? "-",
        createdLabel: formatDateTime(event.createdAt)
      };
    });
}

function participantRows(log) {
  return (log.participants ?? []).map((participant) => {
    const stats = log.computed?.byCombatant?.find((entry) => entry.id === participant.combatantId) ?? {};
    return { ...participant, stats, sideOptions: sideOptions(participant.side) };
  });
}

function sideOptions(selectedSide) {
  return Object.values(SIDES).map((value) => ({ value, label: localize(`SCLS.Side.${value}`), selected: value === selectedSide }));
}

function interpretationOptions(selectedInterpretation) {
  return Object.values(RESOURCE_INTERPRETATIONS).map((value) => ({ value, label: localize(`SCLS.Interpretation.${value}`), selected: value === selectedInterpretation }));
}

function manualAdjustmentParticipants(log) {
  return (log.participants ?? []).map((participant) => ({ value: participant.combatantId, label: participant.name }));
}

function manualAdjustmentTypes() {
  return [
    { value: "damageAdd", label: localize("SCLS.Manual.damageAdd") },
    { value: "damageReduce", label: localize("SCLS.Manual.damageReduce") },
    { value: "healingAdd", label: localize("SCLS.Manual.healingAdd") },
    { value: "healingReduce", label: localize("SCLS.Manual.healingReduce") }
  ];
}

function manualAdjustmentEventType(adjustmentType) {
  switch (adjustmentType) {
    case "damageAdd": return EVENT_TYPES.DAMAGE_MANUAL_ADDED;
    case "damageReduce": return EVENT_TYPES.DAMAGE_MANUAL_REDUCED;
    case "healingAdd": return EVENT_TYPES.HEALING_MANUAL_ADDED;
    case "healingReduce": return EVENT_TYPES.HEALING_MANUAL_REDUCED;
    default: return null;
  }
}

function isManualAdjustmentEvent(event) {
  return [
    EVENT_TYPES.DAMAGE_MANUAL_ADDED,
    EVENT_TYPES.DAMAGE_MANUAL_REDUCED,
    EVENT_TYPES.HEALING_MANUAL_ADDED,
    EVENT_TYPES.HEALING_MANUAL_REDUCED
  ].includes(event.type);
}

function manualAdjustmentLabel(event) {
  switch (event.type) {
    case EVENT_TYPES.DAMAGE_MANUAL_ADDED: return localize("SCLS.Manual.damageAdd");
    case EVENT_TYPES.DAMAGE_MANUAL_REDUCED: return localize("SCLS.Manual.damageReduce");
    case EVENT_TYPES.HEALING_MANUAL_ADDED: return localize("SCLS.Manual.healingAdd");
    case EVENT_TYPES.HEALING_MANUAL_REDUCED: return localize("SCLS.Manual.healingReduce");
    default: return event.type;
  }
}

function naturalEventLabel(event) {
  const amount = event.data?.amount ?? Math.abs(event.data?.delta ?? event.data?.total ?? 0);
  switch (event.type) {
    case EVENT_TYPES.ROLL_DAMAGE: return `Damage roll: ${amount}`;
    case EVENT_TYPES.ROLL_HEALING: return `Healing roll: ${amount}`;
    case EVENT_TYPES.DAMAGE_MANUAL_ADDED: return `Manual damage added: ${amount}`;
    case EVENT_TYPES.DAMAGE_MANUAL_REDUCED: return `Manual damage reduced: ${amount}`;
    case EVENT_TYPES.HEALING_MANUAL_ADDED: return `Manual healing added: ${amount}`;
    case EVENT_TYPES.HEALING_MANUAL_REDUCED: return `Manual healing reduced: ${amount}`;
    case EVENT_TYPES.RESOURCE_DELTA: return `Resource delta ${event.data?.resourcePath}: ${event.data?.oldValue} -> ${event.data?.newValue}`;
    case EVENT_TYPES.RESOURCE_DELTA_OFFLINE: return `Offline resource delta ${event.data?.resourcePath}: ${event.data?.oldValue} -> ${event.data?.newValue}`;
    default: return event.type;
  }
}

export const __test__ = { correctionEvents, participantRows, manualAdjustmentEvents, historyRows };
