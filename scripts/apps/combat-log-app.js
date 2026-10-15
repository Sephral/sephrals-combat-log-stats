import { CONFIDENCE, EVENT_TYPES, HOOKS, LOG_STATUS, MODULE_ID, RESOURCE_INTERPRETATIONS, SETTINGS, SHARE_MODES, SIDES, SOURCE_KINDS, TABS } from "../constants.js";
import { getSetting } from "../settings.js";
import { downloadData, escapeHtml, format, formatDateTime, formatDuration, isTrackingGM, localize, renderAppTemplate } from "../utils.js";
import { CombatLogExportService } from "../services/export-service.js";
import { canWriteCombatLogs, effectiveShareMode, playerHistoryEntry, playerShareSettings, playerTabs, playerViewLog, SHAREABLE_MODES } from "../services/player-view-service.js";
import { formatNumber, normalizeReportSections, PlayerReportService, REPORT_SECTIONS, reportSectionsWithContent, shareOptionAvailability } from "../services/player-report-service.js";
import { awardDetail, awardLabel, computeAwards } from "../services/awards-service.js";
import { CombatStatsService } from "../services/stats-service.js";
import { isCrucibleLog, termKey } from "../services/system-terms.js";
import { combatantBarChart, roundDamageChart } from "./charts.js";
import {
  actionKind, actionName, downState, eventAmount, isAutomaticEffect, isControl, isDamageApplied, isDamageDealt, isDowned,
  isHealingApplied, isMoraleEvent, isOpenAction, isResourceDelta, isSourceAttributed, sourceCombatantId, targetCombatantId
} from "../services/event-insights.js";

// Wide enough for all tabs with their labels in one row in English and German (measured: German needs 1155 px in
// v14, 1130 px in v13). A narrower window shows the tabs as icons (fitTabs).
const DEFAULT_POSITION = { width: 1200, height: 760 };
const MANUAL_TYPES = [EVENT_TYPES.DAMAGE_MANUAL_ADDED, EVENT_TYPES.DAMAGE_MANUAL_REDUCED, EVENT_TYPES.HEALING_MANUAL_ADDED, EVENT_TYPES.HEALING_MANUAL_REDUCED];

export class CombatLogApp extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-app`,
    // The window has its own dark surface. Without a fixed theme, Foundry's light theme paints headings, tabs and
    // inputs dark on dark (core's main menu fixes its theme the same way).
    classes: ["scls-window", "themed", "theme-dark"],
    tag: "section",
    position: DEFAULT_POSITION,
    window: {
      icon: "fa-solid fa-chart-line",
      resizable: true
    },
    // Players may switch tabs, open a log and sort the Impact Meter. Everything else changes, hands out or exports
    // a log and refuses them (gmOnly), also when such a button ends up in their window.
    actions: {
      switchTab: CombatLogApp.#onTab,
      openLog: CombatLogApp.#onOpenLog,
      sortDpr: CombatLogApp.#onSortDpr,
      ignoreEvent: gmOnly(CombatLogApp.#onIgnoreEvent),
      restoreEvent: gmOnly(CombatLogApp.#onRestoreEvent),
      saveSharing: gmOnly(CombatLogApp.#onSaveSharing),
      stopSharing: gmOnly(CombatLogApp.#onStopSharing),
      renameLog: gmOnly(CombatLogApp.#onRenameLog),
      postPlayerReport: gmOnly(CombatLogApp.#onPostPlayerReport),
      createJournalReport: gmOnly(CombatLogApp.#onCreateJournalReport),
      copyDiscordReport: gmOnly(CombatLogApp.#onCopyDiscordReport),
      exportJson: gmOnly(CombatLogApp.#onExportJson),
      exportMarkdown: gmOnly(CombatLogApp.#onExportMarkdown),
      exportCsv: gmOnly(CombatLogApp.#onExportCsv),
      exportDebug: gmOnly(CombatLogApp.#onExportDebug),
      deleteLog: gmOnly(CombatLogApp.#onDeleteLog),
      addAdjustment: gmOnly(CombatLogApp.#onAddAdjustment)
    }
  };

  constructor(service, logId = null, options = {}) {
    super({ ...options, position: { ...DEFAULT_POSITION, ...(options.position ?? {}) } });
    this.service = service;
    this.logId = logId;
    this.activeTab = logId ? "summary" : "history";
    this.exporter = new CombatLogExportService();
    this.playerReports = new PlayerReportService();
    this.dprSort = { key: "damageAppliedNet", direction: "desc" };
    this.liveRenderQueued = false;
    this.onLogUpdated = (log) => this.scheduleLiveRender(log);
    globalThis.Hooks?.on?.(HOOKS.LOG_UPDATED, this.onLogUpdated);
  }

  // Resolved on every render so the module language setting applies to the window title.
  get title() {
    return localize("SCLS.App.Title");
  }

  async close(options = {}) {
    globalThis.Hooks?.off?.(HOOKS.LOG_UPDATED, this.onLogUpdated);
    this.tabObserver?.disconnect();
    this.tabObserver = null;
    return super.close(options);
  }

  // Players see the window read only, with the privacy choices of each combat (player-view-service.js).
  get readOnly() {
    return !canWriteCombatLogs();
  }

  showLog(logId = null) {
    if (logId) {
      this.logId = logId;
      this.activeTab = "summary";
    } else if (this.readOnly) {
      // The tool or button brings up the running fight, if there is one (see getStoredLog).
      this.preferRunning = true;
    }
    void this.render({ force: true });
  }

  async _renderHTML(context) {
    return renderAppTemplate(`modules/${MODULE_ID}/templates/combat-log-app.hbs`, context);
  }

  _replaceHTML(result, content) {
    content.innerHTML = result;
  }

  async getLog() {
    if (this.readOnly) return this.getStoredLog();
    if (this.logId) return this.service.getLog ? this.service.getLog(this.logId) : this.service.persistence.loadLog(this.logId);
    return this.service.listActiveLogs()[0] ?? null;
  }

  // Players hold no live log. They read the store as the GM last saved it, which is at most a moment behind, and the
  // window renders again whenever the GM saves (scls.js). The running fight stays selected after it ends.
  async getStoredLog() {
    const persistence = this.service.persistence;
    if (!this.logId || this.preferRunning) {
      this.preferRunning = false;
      const active = (await persistence.loadActiveLogs?.()) ?? [];
      const latest = active.sort((left, right) => String(right.startedAt ?? "").localeCompare(String(left.startedAt ?? "")))[0] ?? null;
      if (latest) {
        this.logId = latest.id;
        return latest;
      }
    }
    return this.logId ? persistence.loadLog(this.logId) : null;
  }

  statsOptions() {
    return this.service.statsOptions?.() ?? {};
  }

  // While a combat runs, only the recording GM holds the live log. A change made by another GM would be overwritten.
  // Players change nothing.
  canEdit(log, { quiet = false } = {}) {
    if (!canWriteCombatLogs()) {
      if (!quiet) ui.notifications?.warn(localize("SCLS.Notification.ReadOnly"));
      return false;
    }
    if (log?.status !== LOG_STATUS.ACTIVE || isTrackingGM()) return true;
    if (!quiet) ui.notifications?.warn(format("SCLS.Notification.RecordedElsewhere", { name: game.users?.activeGM?.name ?? "" }));
    return false;
  }

  async getEditableLog() {
    const log = await this.getLog();
    return log && this.canEdit(log) ? log : null;
  }

  async _prepareContext(_options) {
    const readOnly = this.readOnly;
    if (!readOnly) await this.service.flushPendingSaves?.();
    const stored = await this.getLog();
    // Players get a copy with only what they may see and its own numbers; nothing else of the log reaches the page.
    const share = readOnly && stored ? playerShareSettings(stored) : null;
    const log = share ? playerViewLog(stored, { statsOptions: this.statsOptions(), share }) : stored;
    this.renderedLog = log;
    const tabIds = readOnly ? playerTabs({ roundLog: share?.roundLog ?? true }) : TABS;
    // The tab first: the player history rows depend on it.
    if (!log) this.activeTab = "history";
    else if (!tabIds.includes(this.activeTab)) this.activeTab = "summary";
    const historyEntries = await this.service.persistence.loadHistoryEntries();
    const rows = await this.historyRowsFor(historyEntries, log?.id ?? "", readOnly);
    const historyDamageLabel = localize(readOnly ? "SCLS.Label.PartyNetDamage" : "SCLS.Label.NetDamage");
    if (!log) {
      return {
        readOnly,
        hasLog: false,
        hasHistory: historyEntries.length > 0,
        activeTab: this.activeTab,
        tabs: visibleTabs(false, this.activeTab, tabIds),
        tabNavigation: tabNavigation(false, this.activeTab, tabIds),
        historyRows: rows,
        historyDamageLabel
      };
    }
    const computed = log.computed ?? {};
    const enemyStats = share ? share.enemyStats : true;
    // Without enemy numbers the totals are the party's (see withoutEnemyStats), and say so.
    const damageLabel = localize(enemyStats ? "SCLS.Label.NetDamage" : "SCLS.Label.PartyNetDamage");
    const healingLabel = localize(enemyStats ? "SCLS.Label.NetHealing" : "SCLS.Label.PartyNetHealing");
    const context = {
      readOnly,
      enemyStats,
      hasLog: true,
      hasHistory: historyEntries.length > 0,
      log,
      computed,
      activeTab: this.activeTab,
      tabs: visibleTabs(true, this.activeTab, tabIds),
      tabNavigation: tabNavigation(true, this.activeTab, tabIds),
      historyRows: rows,
      historyDamageLabel,
      netDamageLabel: damageLabel,
      netHealingLabel: healingLabel,
      summary: summaryContext(log),
      combatRounds: combatRounds(log, { readOnly, enemyStats }),
      combatMetrics: combatMetrics(log, { enemyStats, damageLabel }),
      participants: participantRows(log),
      dprRows: sortedDprRows(log, this.dprSort),
      dprColumns: dprColumns(this.dprSort, { morale: isCrucibleLog(log) }),
      showMorale: isCrucibleLog(log),
      charts: chartContext(log, { enemyStats }),
      awards: awardCards(log),
      dprMethodLabel: localize(`SCLS.DprMethod.${computed.dpr?.method ?? "appliedNet"}`),
      sideRows: sideRows(log),
      includeUnclearDeltasInStats: getSetting(SETTINGS.INCLUDE_UNCLEAR_DELTAS_IN_STATS, false)
    };
    // Corrections and Sharing are GM tabs; players get none of their data.
    if (readOnly) return context;
    // Building the report for every live render of another tab is wasted work; switching tabs renders again.
    const sectionOptions = reportSectionOptions(log, { checkContent: this.activeTab === "sharing" });
    return {
      ...context,
      correctionEvents: correctionEvents(log),
      manualAdjustmentEvents: manualAdjustmentEvents(log),
      manualTypeOptions: MANUAL_TYPES.map((value) => ({ value, label: manualTypeLabel(value) })),
      participantOptions: participantChoices(log),
      noCorrectionsLabel: localize(termKey(log.systemId, "SCLS.Label.NoCorrections")),
      automaticCorrectionsLabel: localize(termKey(log.systemId, "SCLS.Label.AutomaticCorrections")),
      sharing: sharingContext(log, this.playerReports),
      reportSectionOptions: sectionOptions,
      hasReportSections: sectionOptions.some((option) => option.available)
    };
  }

  // Players see each fight with its own privacy choices. Their rows are built only while the History tab is open:
  // that takes a player view of every stored fight, and switching tabs renders again anyway.
  async historyRowsFor(entries, selectedLogId, readOnly) {
    if (!readOnly) return historyRows(entries, selectedLogId);
    if (this.activeTab !== "history") return [];
    const options = { statsOptions: this.statsOptions() };
    const rows = [];
    for (const entry of entries) {
      const log = entry.loaded ? await this.service.persistence.loadLog(entry.combatLogId) : null;
      rows.push(playerHistoryEntry(entry, log, options));
    }
    return historyRows(rows, selectedLogId);
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    for (const panel of this.element.querySelectorAll("[data-panel]")) panel.hidden = panel.dataset.panel !== this.activeTab;
    for (const element of this.element.querySelectorAll("[data-detail-only]")) element.hidden = this.activeTab === "history";
    applyButtonTooltips(this.element.closest(".scls-window") ?? this.element);
    this.observeTabWidth();
    for (const select of this.element.querySelectorAll("select[data-scls-action]")) {
      select.addEventListener("change", (event) => this.handleSelectChange(event));
    }
    const shareForm = this.element.querySelector(".scls-share-form");
    if (shareForm) {
      shareForm.addEventListener("change", () => this.renderReportPreview(shareForm));
      this.renderReportPreview(shareForm);
    }
  }

  // Keeps the tabs in one row: when the window gets too narrow for the labels, the tabs show icons only.
  observeTabWidth() {
    fitTabs(this.element?.querySelector(".scls-tabs"));
    if (this.tabObserver || typeof globalThis.ResizeObserver !== "function" || !this.element) return;
    this.tabObserver = new globalThis.ResizeObserver(() => fitTabs(this.element?.querySelector(".scls-tabs")));
    this.tabObserver.observe(this.element);
  }

  // Shows the player report for the settings in the form, saved or not. Read only, nothing is posted.
  // The section checkboxes follow the same settings: a section without content for them is hidden.
  renderReportPreview(form) {
    if (!this.renderedLog || this.activeTab !== "sharing") return;
    const formData = new FormData(form);
    showReportSections(form, reportSectionsWithContent(this.renderedLog, reportSettingsFromForm(this.renderedLog, formData)));
    const preview = this.element?.querySelector("[data-scls-report-preview]");
    if (preview) preview.innerHTML = reportPreviewHtml(this.playerReports, this.renderedLog, formData);
  }

  async saveLog(log) {
    if (!canWriteCombatLogs()) return;
    await this.service.saveAndCompute(log, { immediate: true });
    await this.render();
  }

  scheduleLiveRender(log) {
    if (this.logId && log?.id !== this.logId) return;
    this.scheduleRefresh();
  }

  // One render shortly after a burst of changes.
  scheduleRefresh() {
    if (this.liveRenderQueued || !this.element?.isConnected) return;
    this.liveRenderQueued = true;
    setTimeout(() => {
      this.liveRenderQueued = false;
      void this.render();
    }, 250);
  }

  async handleSelectChange(event) {
    if (!this.canEdit(null)) return null;
    const target = event.currentTarget;
    switch (target.dataset.sclsAction) {
      case "classify": return this.classifyEvent(target.dataset.eventId, target.value);
      case "setSource": return this.setEventSource(target.dataset.eventId, target.value);
      case "setSide": return this.setParticipantSide(target.dataset.combatantId, target.value);
      default: return null;
    }
  }

  async classifyEvent(eventId, interpretation) {
    const log = await this.getEditableLog();
    const eventEntry = log?.events?.find((entry) => entry.id === eventId);
    if (!eventEntry) return;
    eventEntry.data.interpretedAs = interpretation;
    eventEntry.confidence = CONFIDENCE.MANUAL;
    eventEntry.data.manualCorrection = true;
    await this.saveLog(log);
  }

  async setEventSource(eventId, combatantId) {
    const log = await this.getEditableLog();
    if (!log || !this.service.setEventSource(log, eventId, combatantId)) return;
    const eventEntry = log.events.find((entry) => entry.id === eventId);
    eventEntry.data.manualCorrection = true;
    await this.saveLog(log);
  }

  async setParticipantSide(combatantId, side) {
    const log = await this.getEditableLog();
    const participant = log?.participants?.find((entry) => entry.combatantId === combatantId);
    if (!participant) return;
    participant.side = side;
    participant.sideLocked = true;
    await this.saveLog(log);
  }

  static async #onTab(_event, target) {
    this.activeTab = target.dataset.tab;
    await this.render();
  }

  static async #onOpenLog(_event, target) {
    this.logId = target.dataset.logId;
    this.activeTab = "summary";
    await this.render();
  }

  static async #onSortDpr(_event, target) {
    const key = target.dataset.sortKey;
    if (!DPR_COLUMNS.some((entry) => entry.key === key)) return;
    const current = this.dprSort ?? {};
    this.dprSort = { key, direction: current.key === key && current.direction === "desc" ? "asc" : "desc" };
    await this.render();
  }

  static async #onDeleteLog(_event, target) {
    const logId = target.dataset.logId;
    if (!logId) return;
    const title = String(target.dataset.logTitle ?? "").trim();
    if (!await confirmDeleteCombatLog(title)) return;
    if (!await this.service.deleteLog(logId)) return;
    if (this.logId === logId) this.logId = null;
    this.activeTab = "history";
    await this.render();
  }

  static async #onIgnoreEvent(_event, target) {
    const log = await this.getEditableLog();
    const eventEntry = log?.events?.find((entry) => entry.id === target.dataset.eventId);
    if (!eventEntry) return;
    eventEntry.ignored = true;
    await this.saveLog(log);
  }

  static async #onRestoreEvent(_event, target) {
    const log = await this.getEditableLog();
    const eventEntry = log?.events?.find((entry) => entry.id === target.dataset.eventId);
    if (!eventEntry) return;
    eventEntry.ignored = false;
    await this.saveLog(log);
  }

  static async #onAddAdjustment(_event, target) {
    const log = await this.getEditableLog();
    if (!log) return;
    const form = new FormData(target.closest("form"));
    const added = this.service.addManualAdjustment(log, {
      type: String(form.get("adjustmentType") ?? ""),
      amount: Number(form.get("adjustmentAmount") ?? 0),
      sourceCombatantId: String(form.get("adjustmentSource") ?? ""),
      targetCombatantId: String(form.get("adjustmentTarget") ?? ""),
      note: String(form.get("adjustmentNote") ?? "")
    });
    if (!added) {
      ui.notifications?.warn(localize("SCLS.Notification.AdjustmentInvalid"));
      return;
    }
    await this.saveLog(log);
    ui.notifications?.info(localize("SCLS.Notification.AdjustmentAdded"));
  }

  static async #onSaveSharing(_event, target) {
    const log = await this.getEditableLog();
    if (!log) return;
    applyReportSettings(log, new FormData(target.closest("form")));
    this.playerReports.appendShareEvent(log, log.shareSettings.shareStartedAt === log.shareSettings.shareUpdatedAt ? "created" : "updated", { shareMode: log.shareSettings.shareMode });
    await this.saveLog(log);
    ui.notifications?.info(localize("SCLS.Notification.SharingSaved"));
  }

  static async #onStopSharing() {
    const log = await this.getEditableLog();
    if (!log) return;
    log.shareSettings = { ...log.shareSettings, isShared: false, shareUpdatedAt: new Date().toISOString() };
    log.events.push(shareRevokedEvent(log));
    await this.playerReports.revokeJournalReports(log);
    await this.saveLog(log);
    ui.notifications?.info(localize("SCLS.Notification.SharingStopped"));
  }

  static async #onRenameLog(_event, target) {
    const log = await this.getEditableLog();
    if (!log) return;
    const title = String(new FormData(target.closest("form")).get("title") ?? "").trim();
    if (!title || title === log.title) return;
    log.title = title;
    log.lastSeenAt = new Date().toISOString();
    await this.saveLog(log);
  }

  static async #onPostPlayerReport(_event, target) {
    const log = await this.getEditableLog();
    if (!log) return;
    applyReportSettings(log, new FormData(target.closest("form")));
    const message = await this.playerReports.postChatSummary(log);
    await this.saveLog(log);
    if (message) ui.notifications?.info(localize("SCLS.Notification.ReportPosted"));
    else ui.notifications?.warn(localize("SCLS.Notification.ReportNotShared"));
  }

  static async #onCreateJournalReport(_event, target) {
    const log = await this.getEditableLog();
    if (!log) return;
    applyReportSettings(log, new FormData(target.closest("form")));
    const entry = await this.playerReports.createJournalReport(log);
    await this.saveLog(log);
    if (entry) {
      ui.notifications?.info(format("SCLS.Notification.JournalCreated", { name: entry.name ?? log.title }));
      entry.sheet?.render?.(true);
    } else ui.notifications?.warn(localize("SCLS.Notification.ReportNotShared"));
  }

  // Uses the settings in the form without saving them. Copying does not share the combat in Foundry.
  static async #onCopyDiscordReport(_event, target) {
    const log = await this.getLog();
    if (!log) return;
    const shareSettings = reportSettingsFromForm(log, new FormData(target.closest("form")));
    const messages = this.playerReports.discordMessages(log, { shareSettings });
    if (messages.length > 1) {
      await showDiscordParts(messages);
      return;
    }
    if (await copyText(messages[0] ?? "")) ui.notifications?.info(localize("SCLS.Notification.DiscordCopied"));
  }

  static async #onExportJson() {
    const log = await this.getLog();
    if (!log) return;
    const record = this.canEdit(log, { quiet: true });
    if (record) this.exporter.appendExportEvent(log, "json");
    this.exporter.exportJson(log);
    if (record) await this.saveLog(log);
  }

  // Raw data for bug reports: the log, the chat messages of the fight and the hook calls this client saw.
  static async #onExportDebug() {
    const log = await this.getLog();
    if (!log) return;
    const data = this.service.debugLog(log);
    downloadData(`${log.id}-debug.json`, JSON.stringify(data, null, 2), "application/json");
    ui.notifications?.info(localize("SCLS.Notification.DebugSaved"));
  }

  static async #onExportMarkdown() {
    const log = await this.getLog();
    if (!log) return;
    const record = this.canEdit(log, { quiet: true });
    if (record) this.exporter.appendExportEvent(log, "markdown");
    this.exporter.exportMarkdown(log);
    if (record) await this.saveLog(log);
  }

  static async #onExportCsv() {
    const log = await this.getLog();
    if (!log) return;
    const record = this.canEdit(log, { quiet: true });
    if (record) this.exporter.appendExportEvent(log, "csv");
    this.exporter.exportCsv(log);
    if (record) await this.saveLog(log);
  }
}

// Wraps an action that changes, hands out or exports a log. A player gets a warning and nothing happens.
function gmOnly(handler) {
  return function guardedAction(event, target) {
    if (!canWriteCombatLogs()) {
      globalThis.ui?.notifications?.warn(localize("SCLS.Notification.ReadOnly"));
      return null;
    }
    return handler.call(this, event, target);
  };
}

// Foundry's clipboard helper falls back to execCommand where the browser blocks the Clipboard API.
async function copyText(text) {
  try {
    if (typeof globalThis.game?.clipboard?.copyPlainText === "function") await globalThis.game.clipboard.copyPlainText(text);
    else await globalThis.navigator.clipboard.writeText(text);
    return true;
  } catch (error) {
    console.warn(`${MODULE_ID} | Copying to the clipboard failed`, error);
    globalThis.ui?.notifications?.error(localize("SCLS.Notification.CopyFailed"));
    return false;
  }
}

// A report longer than one Discord message: every part with its own copy button, sent one after another.
async function showDiscordParts(messages) {
  const dialogV2 = globalThis.foundry?.applications?.api?.DialogV2;
  if (typeof dialogV2?.wait !== "function") return null;
  return dialogV2.wait({
    window: { title: localize("SCLS.Discord.Title"), icon: "fa-brands fa-discord" },
    position: { width: 560 },
    content: discordPartsContent(messages),
    buttons: [{ action: "close", label: localize("SCLS.Button.Close"), icon: "fa-solid fa-check", default: true }],
    rejectClose: false,
    render: (_event, dialog) => {
      for (const button of dialog.element?.querySelectorAll("[data-scls-copy-part]") ?? []) {
        button.addEventListener("click", async () => {
          const index = Number(button.dataset.sclsCopyPart);
          if (!await copyText(messages[index] ?? "")) return;
          button.classList.add("is-copied");
          globalThis.ui?.notifications?.info(format("SCLS.Notification.DiscordPartCopied", { part: index + 1, count: messages.length }));
        });
      }
    }
  });
}

function discordPartsContent(messages) {
  const parts = messages.map((text, index) => `<div class="scls-discord-part">
  <div class="scls-discord-part__header">
    <strong>${escapeHtml(format("SCLS.Discord.Part", { part: index + 1, count: messages.length }))}</strong>
    <button type="button" data-scls-copy-part="${index}"><i class="fa-solid fa-copy" aria-hidden="true"></i> ${escapeHtml(localize("SCLS.Button.Copy"))}</button>
  </div>
  <textarea readonly rows="6">${escapeHtml(text)}</textarea>
</div>`);
  return `<div class="scls-discord-parts"><p>${escapeHtml(localize("SCLS.Discord.Hint"))}</p>${parts.join("")}</div>`;
}

// Measured with the labels shown, so a wider window brings them back.
function fitTabs(nav) {
  if (!nav?.classList) return false;
  nav.classList.remove("scls-tabs--compact");
  const compact = nav.scrollWidth > nav.clientWidth + 1;
  nav.classList.toggle("scls-tabs--compact", compact);
  return compact;
}

// Hidden checkboxes stay in the form, so saving keeps their stored value for a later state that fills the section.
function showReportSections(form, available) {
  const labels = Array.from(form?.querySelectorAll?.("[data-scls-report-section]") ?? []);
  for (const label of labels) label.hidden = !available.has(label.dataset.sclsReportSection);
  const fieldset = form?.querySelector?.(".scls-report-sections");
  if (fieldset) fieldset.hidden = !labels.some((label) => !label.hidden);
}

function reportPreviewHtml(playerReports, log, formData) {
  return playerReports.renderHtml(playerReports.buildReport(log, { shareSettings: reportSettingsFromForm(log, formData) }));
}

async function confirmDeleteCombatLog(title = "") {
  const content = `<div class="scls-delete-confirm"><p>${escapeHtml(localize("SCLS.Confirm.DeleteCombat"))}</p>${title ? `<p><strong>${escapeHtml(title)}</strong></p>` : ""}</div>`;
  const dialogTitle = localize("SCLS.Confirm.DeleteCombatTitle");
  const deleteLabel = localize("SCLS.Button.Delete");
  const cancelLabel = localize("SCLS.Button.Cancel");
  const dialogV2 = globalThis.foundry?.applications?.api?.DialogV2;
  if (typeof dialogV2?.confirm === "function") {
    return Boolean(await dialogV2.confirm({
      window: { title: dialogTitle },
      content,
      modal: true,
      rejectClose: false,
      yes: { icon: "fa-solid fa-trash", label: deleteLabel },
      no: { label: cancelLabel }
    }));
  }
  const message = title ? `${localize("SCLS.Confirm.DeleteCombat")}\n\n${title}` : localize("SCLS.Confirm.DeleteCombat");
  return Boolean(globalThis.confirm?.(message));
}

function shareRevokedEvent(log) {
  return {
    id: `share-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type: EVENT_TYPES.SHARE_REVOKED,
    createdAt: new Date().toISOString(),
    sequence: (log.events?.length ?? 0) + 1,
    round: null,
    turn: null,
    combatantId: "",
    actorUuid: "",
    tokenUuid: "",
    sceneUuid: log.sceneUuid ?? "",
    userId: game?.user?.id ?? "",
    visibility: "gm",
    source: { kind: SOURCE_KINDS.MANUAL, id: "revoked" },
    confidence: CONFIDENCE.MANUAL,
    ignored: false,
    tags: ["share"],
    data: {}
  };
}

function summaryContext(log) {
  const summary = log.computed?.summary ?? {};
  return {
    title: log.title,
    status: log.status,
    statusLabel: localize(`SCLS.Status.${log.status}`),
    isShared: Boolean(log.shareSettings?.isShared),
    startedAt: formatDateTime(log.startedAt),
    endedAt: log.endedAt ? formatDateTime(log.endedAt) : "-",
    activeDuration: formatDuration(summary.activeDurationMs ?? 0),
    sessionCount: log.sessionSegments?.length ?? 0,
    roundsLabel: countLabel("SCLS.Count.Rounds", summary.rounds ?? 0),
    sessionsLabel: countLabel("SCLS.Count.Sessions", log.sessionSegments?.length ?? 0),
    rounds: summary.rounds ?? 0,
    participants: log.participants?.length ?? 0,
    partyDowned: summary.partyDowned ?? 0,
    enemiesDefeated: summary.enemiesDefeated ?? 0,
    criticalHits: summary.criticalHits ?? 0,
    moraleDamage: summary.moraleDamageApplied ?? 0,
    warnings: warningLines(log.computed?.warningCounts ?? {}, log.systemId)
  };
}

// "1 round" and "3 rounds" need their own keys in both languages.
function countLabel(key, count) {
  return count === 1 ? localize(`${key}One`) : format(`${key}Other`, { count });
}

// Crucible logs speak of health and morale; open action cards only exist there.
function warningLines(counts, systemId = "") {
  const lines = [];
  for (const [code, key] of [["unclearExcluded", "SCLS.Warning.UnclearExcluded"], ["manualIncluded", "SCLS.Warning.ManualIncluded"], ["openActions", "SCLS.Warning.OpenActions"], ["unknownSource", "SCLS.Warning.UnknownSource"]]) {
    const count = Number(counts[code]) || 0;
    if (!count) continue;
    lines.push(count === 1 ? localize(termKey(systemId, `${key}One`)) : format(termKey(systemId, `${key}Other`), { count }));
  }
  return lines;
}

function visibleTabs(hasLog, activeTab, tabIds = TABS) {
  return tabIds.filter((id) => hasLog || id === "history").map((id) => ({ id, label: localize(`SCLS.Tab.${id}`), icon: tabIcon(id), active: id === activeTab }));
}

function tabIcon(id) {
  switch (id) {
    case "history": return "fa-solid fa-clock-rotate-left";
    case "summary": return "fa-solid fa-chart-pie";
    case "timeline": return "fa-solid fa-list-ol";
    case "statistics": return "fa-solid fa-chart-column";
    case "dpr": return "fa-solid fa-bolt";
    case "corrections": return "fa-solid fa-sliders";
    case "participants": return "fa-solid fa-users";
    case "sharing": return "fa-solid fa-scroll";
    default: return "fa-solid fa-circle";
  }
}

function tabNavigation(hasLog, activeTab, tabIds = TABS) {
  const tabs = visibleTabs(hasLog, activeTab, tabIds);
  return {
    hasTabs: tabs.length > 0,
    historyTab: tabs.find((tab) => tab.id === "history") ?? null,
    detailTabs: hasLog ? tabs.filter((tab) => tab.id !== "history") : [],
    showConnector: Boolean(hasLog),
    connectorLabel: localize("SCLS.Navigation.SelectedCombat"),
    connectorIcon: "fa-solid fa-angles-right"
  };
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

function participantLookup(log) {
  const byCombatantId = new Map();
  for (const participant of log.participants ?? []) if (participant.combatantId) byCombatantId.set(participant.combatantId, participant);
  return { byCombatantId };
}

function participantName(participants, combatantId, fallback = "-") {
  return participants.byCombatantId.get(combatantId)?.name ?? fallback;
}

// Rolls that led to an applied hit point change are shown through that change, not twice.
function appliedRollMessageIds(log) {
  const ids = new Set();
  const rollsById = new Map((log.events ?? []).filter((event) => String(event.type).startsWith("roll.")).map((event) => [event.id, event]));
  for (const event of log.events ?? []) {
    const correlation = event.data?.correlation;
    if (!correlation) continue;
    if (correlation.messageId) ids.add(correlation.messageId);
    const roll = rollsById.get(correlation.rollEventId);
    if (roll?.source?.id) ids.add(roll.source.id);
  }
  return ids;
}

// readOnly (player view): no open action cards and no manual changes of the GM, they only count in the numbers.
// enemyStats false: no healing of enemies and no enemy damage per round.
function combatRounds(log, { readOnly = false, enemyStats = true } = {}) {
  const participants = participantLookup(log);
  const appliedMessages = appliedRollMessageIds(log);
  const shown = (event) => {
    if (!readOnly) return true;
    if (event.type === EVENT_TYPES.ACTION_USED || MANUAL_TYPES.includes(event.type)) return false;
    return enemyStats || !(isHealingApplied(event) && participants.byCombatantId.get(targetCombatantId(event))?.side === SIDES.HOSTILE);
  };
  const roundNumbers = new Set((log.events ?? []).map((event) => Number(event.round) || 0).filter((round) => round > 0));
  const maxRound = Math.max(0, log.computed?.summary?.rounds ?? 0, ...roundNumbers);
  const rounds = [];
  for (let round = 1; round <= maxRound; round += 1) {
    const events = (log.events ?? []).filter((event) => (Number(event.round) || 0) === round && !event.ignored && shown(event));
    const actions = events.flatMap((event) => roundActions(event, participants, appliedMessages));
    if (!actions.length) continue;
    // The round totals come from the statistics when they are there, so the round log and the chart agree (damage
    // without a known source counts for the other side, corrections are taken back in the right round).
    const computedRound = log.computed?.byRound?.find((row) => Number(row.round) === round);
    const heroDamage = computedRound ? Number(computedRound.partyDamage) || 0 : sumRoundAmount(actions, SIDES.FRIENDLY, "damage");
    const foeDamage = !enemyStats ? 0 : computedRound ? Number(computedRound.enemyDamage) || 0 : sumRoundAmount(actions, SIDES.HOSTILE, "damage");
    const healing = actions.filter((action) => action.kind === "healing").reduce((total, action) => total + action.amount, 0);
    rounds.push({
      round,
      open: rounds.length === 0,
      actions,
      hasActions: actions.length > 0,
      heroDamage,
      foeDamage,
      healing,
      summary: roundSummary(heroDamage, foeDamage, healing, actions.length)
    });
  }
  return rounds;
}

function roundActions(event, participants, appliedMessages) {
  const sourceId = sourceCombatantId(event);
  const targetId = targetCombatantId(event);
  const source = participants.byCombatantId.get(sourceId) ?? null;
  const side = source?.side ?? participants.byCombatantId.get(targetId)?.side ?? SIDES.UNKNOWN;
  const actor = source?.name ?? "-";
  const target = participantName(participants, targetId, event.data?.targetName ?? "-");
  const amount = eventAmount(event);
  const detail = actionName(event);
  const rows = [];
  if (isResourceDelta(event) && isMoraleEvent(event)) {
    const targetSide = participants.byCombatantId.get(targetId)?.side ?? SIDES.UNKNOWN;
    if (isDamageApplied(event)) {
      if (isDamageDealt(event)) rows.push(actionRow(event, "morale", side, actor, target, amount, localize("SCLS.Protocol.MoraleDamage"), detail));
      else rows.push(actionRow(event, "morale", targetSide, target, "-", amount, localize("SCLS.Protocol.MoraleDamage"), detail));
    } else if (isHealingApplied(event)) {
      rows.push(actionRow(event, "morale", side, source ? actor : "-", target, amount, localize("SCLS.Protocol.MoraleRestored"), detail));
    } else if (isCorrectionInterpretation(event.data?.interpretedAs)) {
      rows.push(actionRow(event, "correction", side, actor, target, amount, correctionVerb(event), detail));
    }
    if (isDowned(event) || downState(event)) rows.push(actionRow(event, "downed", targetSide, target, "-", 0, downVerb(event)));
    return rows;
  }
  if (isResourceDelta(event)) {
    if (isDamageApplied(event)) {
      if (isDamageDealt(event)) rows.push(actionRow(event, "damage", side, actor, target, amount, localize("SCLS.Protocol.Damage"), detail));
      else rows.push(actionRow(event, "taken", participants.byCombatantId.get(targetId)?.side ?? SIDES.UNKNOWN, target, "-", amount, localize("SCLS.Protocol.DamageTaken"), detail));
    } else if (isHealingApplied(event)) {
      rows.push(actionRow(event, "healing", side, source ? actor : "-", target, amount, localize("SCLS.Protocol.Healing"), detail));
    } else if (isCorrectionInterpretation(event.data?.interpretedAs)) {
      rows.push(actionRow(event, "correction", side, actor, target, amount, correctionVerb(event), event.data?.reversal ? detail : ""));
    }
    if (isDowned(event) || downState(event)) rows.push(actionRow(event, "downed", participants.byCombatantId.get(targetId)?.side ?? SIDES.UNKNOWN, target, "-", 0, downVerb(event)));
    return rows;
  }
  switch (event.type) {
    case EVENT_TYPES.ACTION_USED: {
      // Crucible action cards: shown until the GM confirms them, then their changes speak for them.
      if (!isOpenAction(event)) return [];
      const targets = (event.data?.outcomes ?? []).map((outcome) => participantName(participants, outcome.targetCombatantId, outcome.targetName || "-")).filter((name) => name !== "-");
      return [actionRow(event, "roll", side, actor, targets.join(", ") || "-", Number(event.data?.plannedDamage) || 0, localize("SCLS.Protocol.ActionOpen"), detail)];
    }
    case EVENT_TYPES.DAMAGE_APPLIED:
    case EVENT_TYPES.DAMAGE_MANUAL_ADDED:
      return [actionRow(event, "damage", side, actor, target, amount, localize(event.type === EVENT_TYPES.DAMAGE_APPLIED ? "SCLS.Protocol.Damage" : "SCLS.Manual.damageAdd"), detail)];
    case EVENT_TYPES.DAMAGE_MANUAL_REDUCED:
      return [actionRow(event, "correction", side, actor, target, amount, localize("SCLS.Protocol.DamageReduced"), detail)];
    case EVENT_TYPES.HEALING_APPLIED:
    case EVENT_TYPES.HEALING_MANUAL_ADDED:
      return [actionRow(event, "healing", side, actor, target, amount, localize(event.type === EVENT_TYPES.HEALING_APPLIED ? "SCLS.Protocol.Healing" : "SCLS.Manual.healingAdd"), detail)];
    case EVENT_TYPES.HEALING_MANUAL_REDUCED:
      return [actionRow(event, "correction", side, actor, target, amount, localize("SCLS.Protocol.HealingReduced"), detail)];
    case EVENT_TYPES.ROLL_ATTACK:
      if (event.data?.isCritical) return [actionRow(event, "roll", side, actor, target, 0, localize("SCLS.Protocol.CriticalHit"), detail)];
      if (event.data?.isFumble) return [actionRow(event, "roll", side, actor, target, 0, localize("SCLS.Protocol.Fumble"), detail)];
      return [];
    case EVENT_TYPES.ROLL_DAMAGE:
    case EVENT_TYPES.ROLL_HEALING:
      if (appliedMessages.has(event.source?.id)) return [];
      return [actionRow(event, "roll", side, actor, target, amount, localize(event.type === EVENT_TYPES.ROLL_DAMAGE ? "SCLS.Protocol.DamageRollOpen" : "SCLS.Protocol.HealingRollOpen"), detail)];
    case EVENT_TYPES.ACTIVE_EFFECT_CREATED:
      if (isAutomaticEffect(event)) return [];
      return [actionRow(event, isControl(event) ? "control" : "effect", side, actor, target, 0, localize(isControl(event) ? "SCLS.Protocol.ControlAdded" : "SCLS.Protocol.EffectAdded"), event.data?.name ?? "")];
    case EVENT_TYPES.ACTIVE_EFFECT_DELETED:
      if (isAutomaticEffect(event)) return [];
      return [actionRow(event, "effect", side, "-", target, 0, localize("SCLS.Protocol.EffectRemoved"), event.data?.name ?? "")];
    default:
      return [];
  }
}

function correctionVerb(event) {
  return event.data?.reversal ? localize("SCLS.Protocol.ActionUndone") : localize(`SCLS.Interpretation.${event.data.interpretedAs}`);
}

// "Dropped to 0 HP", or the Crucible state reached (weakened, dead, broken, insane).
function downVerb(event) {
  const state = downState(event);
  return state ? localize(`SCLS.Crucible.State.${state}`) : localize("SCLS.Protocol.Downed");
}

function isCorrectionInterpretation(value) {
  return [RESOURCE_INTERPRETATIONS.CORRECTION_DAMAGE_UP, RESOURCE_INTERPRETATIONS.CORRECTION_DAMAGE_DOWN, RESOURCE_INTERPRETATIONS.CORRECTION_HEALING_UP, RESOURCE_INTERPRETATIONS.CORRECTION_HEALING_DOWN].includes(value);
}

function actionRow(event, kind, side, actor, target, amount, verb, detail = "") {
  return {
    id: event.id,
    kind,
    side,
    actor,
    target,
    amount,
    verb,
    detail,
    confidence: event.confidence,
    confidenceLabel: localize(`SCLS.Confidence.${event.confidence}`),
    time: formatDateTime(event.createdAt),
    amountLabel: amount > 0 ? String(amount) : "-"
  };
}

function sumRoundAmount(actions, side, kind) {
  return actions.filter((action) => action.side === side && action.kind === kind).reduce((total, action) => total + action.amount, 0);
}

function roundSummary(heroDamage, foeDamage, healing, actionCount) {
  const parts = [countLabel("SCLS.Protocol.ActionCount", actionCount)];
  if (heroDamage) parts.push(`${localize("SCLS.Protocol.Heroes")}: ${heroDamage}`);
  if (foeDamage) parts.push(`${localize("SCLS.Protocol.Enemies")}: ${foeDamage}`);
  if (healing) parts.push(`${localize("SCLS.Protocol.HealingShort")}: ${healing}`);
  return parts.join(" | ");
}

// Hit point changes that need the GM: unclear ones, ambiguous ones, already corrected ones and
// damage or healing whose source is unknown.
function correctionEvents(log) {
  const participants = participantLookup(log);
  return (log.events ?? [])
    .filter((event) => isResourceDelta(event))
    .filter((event) => event.confidence === CONFIDENCE.UNCLEAR
      || event.data?.correlation?.status === "ambiguous"
      || event.data?.manualCorrection
      || ((isDamageApplied(event) || isHealingApplied(event)) && !isSourceAttributed(event)))
    .map((event) => {
      const targetId = targetCombatantId(event);
      const sourceId = isSourceAttributed(event) ? sourceCombatantId(event) : "";
      return {
        ...event,
        label: correctionLabel(event),
        partsLabel: poolParts(event),
        roundLabel: event.round ? format("SCLS.Protocol.RoundNumber", { round: event.round }) : "-",
        targetName: participantName(participants, targetId),
        confidenceLabel: localize(`SCLS.Confidence.${event.confidence}`),
        reasonLabel: correctionReason(event),
        interpretationOptions: interpretationOptions(event.data?.interpretedAs, log.systemId),
        sourceOptions: [{ value: "", label: localize("SCLS.Label.UnknownSource"), selected: !sourceId }].concat(
          (log.participants ?? []).filter((participant) => participant.combatantId !== targetId).map((participant) => ({ value: participant.combatantId, label: participant.name, selected: participant.combatantId === sourceId }))
        )
      };
    });
}

// Crucible changes name their pool: "Health change", "Morale change".
function correctionLabel(event) {
  if (event.type === EVENT_TYPES.RESOURCE_DELTA_OFFLINE) return localize("SCLS.Event.ResourceDeltaOffline");
  if (event.data?.pool) return localize(`SCLS.Crucible.Event.${isMoraleEvent(event) ? "morale" : "health"}`);
  return localize("SCLS.Event.ResourceDelta");
}

// "Health -3, Wounds +4" for a Crucible change that spans both values of a pool.
function poolParts(event) {
  const parts = Object.entries(event.data?.parts ?? {}).filter(([, value]) => Number(value));
  if (parts.length < 2) return "";
  return parts.map(([resource, value]) => `${localize(`SCLS.Crucible.Pool.${resource}`)} ${Number(value) > 0 ? "+" : ""}${formatNumber(value)}`).join(", ");
}

function correctionReason(event) {
  if (event.data?.manualCorrection) return localize("SCLS.Correction.Corrected");
  if (event.type === EVENT_TYPES.RESOURCE_DELTA_OFFLINE) return localize("SCLS.Correction.Offline");
  if (event.data?.correlation?.status === "ambiguous") return localize("SCLS.Correction.Ambiguous");
  if (event.confidence === CONFIDENCE.UNCLEAR) return localize("SCLS.Correction.Unclear");
  return localize("SCLS.Correction.NoSource");
}

function manualAdjustmentEvents(log) {
  const participants = participantLookup(log);
  return (log.events ?? [])
    .filter((event) => MANUAL_TYPES.includes(event.type))
    .map((event) => ({
      ...event,
      label: manualTypeLabel(event.type),
      amount: event.data?.amount ?? 0,
      note: event.data?.note ?? "",
      participantName: participantName(participants, event.combatantId),
      targetName: participantName(participants, event.data?.targetCombatantId),
      createdLabel: formatDateTime(event.createdAt)
    }));
}

function manualTypeLabel(type) {
  switch (type) {
    case EVENT_TYPES.DAMAGE_MANUAL_ADDED: return localize("SCLS.Manual.damageAdd");
    case EVENT_TYPES.DAMAGE_MANUAL_REDUCED: return localize("SCLS.Manual.damageReduce");
    case EVENT_TYPES.HEALING_MANUAL_ADDED: return localize("SCLS.Manual.healingAdd");
    case EVENT_TYPES.HEALING_MANUAL_REDUCED: return localize("SCLS.Manual.healingReduce");
    default: return type;
  }
}

function participantChoices(log) {
  return [{ value: "", label: localize("SCLS.Label.UnknownSource") }].concat((log.participants ?? []).map((participant) => ({ value: participant.combatantId, label: participant.name })));
}

function participantRows(log) {
  return (log.participants ?? []).map((participant) => {
    const stats = log.computed?.byCombatant?.find((entry) => entry.id === participant.combatantId) ?? {};
    return { ...participant, stats, sideLabel: localize(`SCLS.Side.${participant.side ?? SIDES.UNKNOWN}`), sideOptions: sideOptions(participant.side) };
  });
}

function dprRows(log) {
  const participants = participantLookup(log);
  return (log.computed?.dpr?.byCombatant ?? log.computed?.byCombatant ?? []).map((row) => {
    const participant = participants.byCombatantId.get(row.id);
    return {
      ...row,
      healing: Number(row.healingNet ?? 0),
      martial: Number(row.martial ?? 0),
      ranged: Number(row.ranged ?? 0),
      magic: Number(row.magic ?? 0),
      control: Number(row.control ?? 0),
      downed: Number(row.downed ?? 0),
      takedowns: Number(row.takedowns ?? 0),
      moraleDamageDealt: Number(row.moraleDamageDealt ?? 0),
      img: participant?.img ?? "icons/svg/mystery-man.svg",
      name: row.name || participant?.name || row.id || "-",
      sideLabel: localize(`SCLS.Side.${row.side ?? SIDES.UNKNOWN}`)
    };
  });
}

const DPR_COLUMNS = Object.freeze([
  { key: "name", labelKey: "SCLS.Label.Combatant", type: "string" },
  { key: "side", labelKey: "SCLS.Label.Side", type: "string" },
  { key: "damageAppliedNet", labelKey: "SCLS.Label.DamageDealt", type: "number" },
  { key: "damageTakenNet", labelKey: "SCLS.Label.DamageTaken", type: "number" },
  { key: "healing", labelKey: "SCLS.Label.Healing", type: "number" },
  { key: "martial", labelKey: "SCLS.Label.Martial", type: "number" },
  { key: "ranged", labelKey: "SCLS.Label.Ranged", type: "number" },
  { key: "magic", labelKey: "SCLS.Label.Magic", type: "number" },
  { key: "control", labelKey: "SCLS.Label.Control", type: "number" },
  { key: "takedowns", labelKey: "SCLS.Label.Takedowns", type: "number" },
  { key: "downed", labelKey: "SCLS.Label.Downed", type: "number" },
  { key: "moraleDamageDealt", labelKey: "SCLS.Label.MoraleDamage", type: "number", morale: true },
  { key: "netDPR", labelKey: "SCLS.Label.NetDPR", type: "number" }
]);

// The morale column only appears in Crucible logs.
function dprColumns(sort = {}, { morale = false } = {}) {
  return DPR_COLUMNS.filter((column) => morale || !column.morale).map((column) => {
    const active = sort.key === column.key;
    return {
      ...column,
      label: localize(column.labelKey),
      active,
      direction: active ? sort.direction : "",
      icon: active && sort.direction === "asc" ? "fa-solid fa-arrow-up-wide-short" : "fa-solid fa-arrow-down-wide-short"
    };
  });
}

function sortedDprRows(log, sort = {}) {
  const rows = dprRows(log);
  const column = DPR_COLUMNS.find((entry) => entry.key === sort.key);
  if (!column) return rows;
  const direction = sort.direction === "asc" ? 1 : -1;
  return rows.map((row, index) => ({ row, index })).sort((left, right) => {
    const result = compareDprValues(left.row[column.key], right.row[column.key], column.type);
    return result ? result * direction : left.index - right.index;
  }).map((entry) => entry.row);
}

function compareDprValues(left, right, type) {
  if (type === "number") return (Number(left) || 0) - (Number(right) || 0);
  return String(left ?? "").localeCompare(String(right ?? ""), String(game?.i18n?.lang ?? "en"), { sensitivity: "base", numeric: true });
}

// Statistics charts. Logs saved before 1.1 have no per round numbers, those are computed here.
// enemyStats false: the round chart shows the party only.
function chartContext(log, { enemyStats = true } = {}) {
  const byRound = Array.isArray(log.computed?.byRound) ? log.computed.byRound : CombatStatsService.compute(log, {
    includeUnclearDeltasInStats: getSetting(SETTINGS.INCLUDE_UNCLEAR_DELTAS_IN_STATS, false),
    defaultDprMethod: log.computed?.dpr?.method
  }).byRound;
  const roundChart = roundDamageChart(byRound, { formatValue: formatNumber, enemies: enemyStats });
  const combatantChart = combatantBarChart(dprRows(log), { formatValue: formatNumber });
  return {
    hasCharts: Boolean(roundChart || combatantChart),
    roundChart,
    combatantChart,
    roundLegend: [{ tone: "party", label: localize("SCLS.Chart.Party") }, { tone: "enemies", label: localize("SCLS.Chart.Enemies") }].slice(0, enemyStats ? 2 : 1),
    combatantLegend: [
      { tone: "dealt", label: localize("SCLS.Label.DamageDealt") },
      { tone: "taken", label: localize("SCLS.Label.DamageTaken") },
      { tone: "healing", label: localize("SCLS.Label.Healing") }
    ]
  };
}

// Award cards for the Summary tab. The GM sees every party member, hidden or not.
function awardCards(log) {
  const members = (log.participants ?? []).filter((participant) => participant.side === SIDES.FRIENDLY && participant.combatantId)
    .map((participant) => ({ id: String(participant.combatantId), name: participant.name || "-" }));
  const events = (log.events ?? []).filter((event) => !event.ignored);
  return computeAwards({ members, rows: log.computed?.byCombatant ?? log.computed?.dpr?.byCombatant ?? [], events }).map((award) => ({
    key: award.key,
    icon: award.icon,
    label: awardLabel(award.key),
    names: award.winners.map((winner) => winner.name).join(", "),
    detail: awardDetail(award)
  }));
}

function sideRows(log) {
  const presentSides = new Set((log.participants ?? []).map((participant) => participant.side ?? SIDES.UNKNOWN));
  return (log.computed?.dpr?.bySide ?? []).filter((row) => presentSides.has(row.id)).map((row) => ({ ...row, label: localize(`SCLS.Side.${row.id}`) }));
}

function combatMetrics(log, { enemyStats = true, damageLabel = localize("SCLS.Label.NetDamage") } = {}) {
  const rows = dprRows(log);
  const summary = log.computed?.summary ?? {};
  const topDamage = Math.max(0, ...rows.map((row) => Number(row.damageAppliedNet) || 0));
  const topHealing = Math.max(0, ...rows.map((row) => Number(row.healing) || 0));
  const contributionRows = [...rows]
    .sort((left, right) => (Number(right.damageAppliedNet) || 0) - (Number(left.damageAppliedNet) || 0) || (Number(right.healing) || 0) - (Number(left.healing) || 0))
    .slice(0, 10)
    .map((row) => ({
      ...row,
      damagePercent: percent(row.damageAppliedNet, topDamage),
      healingPercent: percent(row.healing, topHealing),
      impactMetrics: impactMetrics(row)
    }));
  const totals = {
    damage: Number(summary.netDamageApplied ?? 0),
    healing: Number(summary.netHealingApplied ?? 0),
    martial: sum(rows, "martial"),
    ranged: sum(rows, "ranged"),
    magic: sum(rows, "magic"),
    control: sum(rows, "control"),
    partyDowned: Number(summary.partyDowned ?? 0),
    enemiesDefeated: Number(summary.enemiesDefeated ?? 0)
  };
  totals.downed = totals.partyDowned + totals.enemiesDefeated;
  const outputTotal = Math.max(1, totals.damage, totals.healing);
  const actionTotal = Math.max(1, totals.martial + totals.ranged + totals.magic + totals.control + totals.downed);
  const disciplineRows = [
    metricDiscipline("damage", damageLabel, totals.damage, outputTotal, "damage"),
    metricDiscipline("healing", localize("SCLS.Label.Healing"), totals.healing, outputTotal, "healing"),
    metricDiscipline("martial", localize("SCLS.Label.Martial"), totals.martial, actionTotal, "martial"),
    metricDiscipline("ranged", localize("SCLS.Label.Ranged"), totals.ranged, actionTotal, "ranged"),
    metricDiscipline("magic", localize("SCLS.Label.Magic"), totals.magic, actionTotal, "magic"),
    metricDiscipline("control", localize("SCLS.Label.Control"), totals.control, actionTotal, "control"),
    metricDiscipline("enemiesDefeated", localize("SCLS.Label.EnemiesDefeated"), totals.enemiesDefeated, actionTotal, "downed"),
    metricDiscipline("partyDowned", localize("SCLS.Label.PartyDowned"), totals.partyDowned, actionTotal, "downed")
  ];
  return {
    pressureRows: pressureRows(log),
    contributionRows,
    disciplineRows,
    topActions: topActions(log, { enemyStats }),
    totals
  };
}

function sum(rows, key) {
  return rows.reduce((total, row) => total + (Number(row[key]) || 0), 0);
}

function metricDiscipline(id, label, value, total, tone) {
  return { id, label, value, percent: percent(value, total), tone };
}

function pressureRows(log) {
  const rows = sideRows(log);
  const topDamage = Math.max(0, ...rows.map((row) => Number(row.damageAppliedNet) || 0));
  return rows.map((row) => ({ ...row, pressurePercent: percent(row.damageAppliedNet, topDamage) }));
}

// enemyStats false: actions of enemies stay out, their damage would be enemy numbers.
function topActions(log, { enemyStats = true } = {}) {
  const participants = participantLookup(log);
  const actions = new Map();
  for (const event of log.events ?? []) {
    // An undone hit (Crucible) is no use of the action; the reversal takes its damage back.
    if (event.ignored || event.data?.reversed) continue;
    const kind = isDamageDealt(event) ? "damage" : (isHealingApplied(event) && isSourceAttributed(event)) ? "healing" : isControl(event) ? "control" : null;
    if (!kind) continue;
    const name = (kind === "control" ? event.data?.name : actionName(event)) || localize(`SCLS.ActionKind.${kind}`);
    const key = `${kind}:${normalizeLabel(name)}`;
    const source = participants.byCombatantId.get(sourceCombatantId(event));
    if (!enemyStats && source?.side === SIDES.HOSTILE) continue;
    const row = actions.get(key) ?? { name, kind, kindLabel: localize(`SCLS.ActionKind.${kind}`), style: actionKind(event), uses: 0, amount: 0, actors: new Set() };
    row.uses += 1;
    row.amount += kind === "control" ? 0 : eventAmount(event);
    if (source?.name) row.actors.add(source.name);
    actions.set(key, row);
  }
  return Array.from(actions.values())
    .map((row) => ({ ...row, actors: Array.from(row.actors).slice(0, 3).join(", ") || "-", average: row.uses ? Math.round((row.amount / row.uses) * 10) / 10 : 0 }))
    .sort((left, right) => (right.amount - left.amount) || (right.uses - left.uses) || left.name.localeCompare(right.name))
    .slice(0, 8);
}

function impactMetrics(row) {
  const metrics = [
    impactMetric("damage", "fa-solid fa-burst", localize("SCLS.Label.DamageDealt"), row.damageAppliedNet),
    impactMetric("taken", "fa-solid fa-shield-heart", localize("SCLS.Label.DamageTaken"), row.damageTakenNet),
    impactMetric("healing", "fa-solid fa-heart-pulse", localize("SCLS.Label.Healing"), row.healing),
    impactMetric("control", "fa-solid fa-hand-sparkles", localize("SCLS.Label.Control"), row.control),
    impactMetric("takedowns", "fa-solid fa-crosshairs", localize("SCLS.Label.Takedowns"), row.takedowns),
    impactMetric("downed", "fa-solid fa-skull", localize("SCLS.Label.Downed"), row.downed)
  ].filter((metric) => metric.value);
  return metrics.length ? metrics : [impactMetric("empty", "fa-solid fa-minus", "", "-")];
}

function impactMetric(type, icon, label, value) {
  return { type, icon, label, value };
}

function percent(value, total) {
  const numericValue = Number(value) || 0;
  const numericTotal = Number(total) || 0;
  if (numericValue <= 0 || numericTotal <= 0) return 0;
  return Math.max(2, Math.min(100, Math.round((numericValue / numericTotal) * 100)));
}

// The mode the Sharing form preselects: the saved one, else the default from the settings. The player view of the
// window reads the same (player-view-service.js).
function formShareMode(share = {}) {
  return effectiveShareMode(share);
}

function sharingContext(log, playerReports) {
  const share = log.shareSettings ?? {};
  const mode = formShareMode(share);
  const options = shareOptionAvailability(log);
  return {
    isShared: Boolean(share.isShared),
    sharingEnabled: getSetting(SETTINGS.ENABLE_PLAYER_SHARING, true) !== false,
    statusLabel: share.isShared ? format("SCLS.Share.SharedSince", { date: formatDateTime(share.shareStartedAt ?? share.shareUpdatedAt) }) : localize("SCLS.Share.NotShared"),
    modeOptions: SHAREABLE_MODES.map((value) => ({ value, label: localize(`SCLS.ShareMode.${value}`), selected: value === mode })),
    anonymizeEnemies: Boolean(share.anonymizeEnemies),
    includeEnemyStats: Boolean(share.includeEnemyStats),
    includeHiddenCombatants: Boolean(share.includeHiddenCombatants),
    // Options without anyone to apply to stay in the form, hidden, and keep their stored value.
    showEnemyOptions: options.enemies,
    showHiddenOption: options.hiddenCombatants,
    canPost: playerReports.canShare({ ...log, shareSettings: { ...share, isShared: true, shareMode: mode } })
  };
}

// available: the section has content with the saved settings, as the form first shows them. Every change in the
// form updates it again (renderReportPreview).
function reportSectionOptions(log, { checkContent = true } = {}) {
  const share = log.shareSettings ?? {};
  const selected = normalizeReportSections(share.reportSections);
  const available = !checkContent ? new Set(REPORT_SECTIONS.map((section) => section.key)) : reportSectionsWithContent(log, reportSettingsFromValues(log, {
    shareMode: formShareMode(share),
    includeEnemyStats: Boolean(share.includeEnemyStats),
    anonymizeEnemies: Boolean(share.anonymizeEnemies),
    includeHiddenCombatants: Boolean(share.includeHiddenCombatants),
    sections: REPORT_SECTIONS.filter((section) => selected[section.key] !== false).map((section) => section.key)
  }));
  return REPORT_SECTIONS.map((section) => ({
    value: section.key,
    label: localize(section.labelKey),
    selected: selected[section.key] !== false,
    available: available.has(section.key)
  }));
}

// Share settings as the form shows them. Saving, posting, the preview and the Discord copy all read them this way.
// Hidden options are part of the form as well, so they keep their stored value.
function reportSettingsFromForm(log, formData) {
  return reportSettingsFromValues(log, {
    shareMode: formData.get("shareMode"),
    includeEnemyStats: formData.get("includeEnemyStats") !== null,
    anonymizeEnemies: formData.get("anonymizeEnemies") !== null,
    includeHiddenCombatants: formData.get("includeHiddenCombatants") !== null,
    sections: formData.getAll("reportSections")
  });
}

function reportSettingsFromValues(log, { shareMode, includeEnemyStats, anonymizeEnemies, includeHiddenCombatants, sections: sectionKeys = [] }) {
  const requestedMode = String(shareMode ?? "");
  const selected = new Set(sectionKeys.map(String));
  const sections = Object.fromEntries(REPORT_SECTIONS.map((section) => [section.key, selected.has(section.key)]));
  return {
    ...log.shareSettings,
    isShared: true,
    shareMode: SHAREABLE_MODES.includes(requestedMode) ? requestedMode : SHARE_MODES.FULL_VISIBLE_RECAP,
    includePartyStats: true,
    includeEnemyStats: Boolean(includeEnemyStats),
    anonymizeEnemies: Boolean(anonymizeEnemies),
    includeNpcNames: !anonymizeEnemies,
    includeHiddenCombatants: Boolean(includeHiddenCombatants),
    includePrivateRolls: false,
    includeGMNotes: false,
    includeUnclearEvents: false,
    includeDPR: Boolean(sections.damageSpotlight),
    includeTimeline: Object.entries(sections).some(([key, value]) => value && !["combatRecap", "partyContributions", "damageSpotlight", "awards", "aftermath"].includes(key)),
    includeCorrections: false,
    allowPlayersToOpenReport: true,
    reportSections: sections
  };
}

function applyReportSettings(log, formData) {
  const now = new Date().toISOString();
  const wasShared = Boolean(log.shareSettings?.isShared);
  log.shareSettings = { ...reportSettingsFromForm(log, formData), shareUpdatedAt: now };
  if (!wasShared || !log.shareSettings.shareStartedAt) log.shareSettings.shareStartedAt = now;
}

function applyButtonTooltips(root) {
  for (const button of root?.querySelectorAll?.("button") ?? []) {
    if (button.getAttribute("title")) continue;
    const title = button.dataset?.tooltip || button.getAttribute("aria-label") || button.innerText?.trim();
    if (title) button.setAttribute("title", title);
  }
}

function normalizeLabel(value) {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function sideOptions(selectedSide) {
  return Object.values(SIDES).map((value) => ({ value, label: localize(`SCLS.Side.${value}`), selected: value === selectedSide }));
}

// Crucible has no temporary or maximum hit points; a change already filed that way keeps its choice.
const HIT_POINT_ONLY_INTERPRETATIONS = new Set([RESOURCE_INTERPRETATIONS.TEMP_HP_GAIN, RESOURCE_INTERPRETATIONS.TEMP_HP_LOSS, RESOURCE_INTERPRETATIONS.MAX_HP_CHANGE]);

function interpretationOptions(selectedInterpretation, systemId = "") {
  return Object.values(RESOURCE_INTERPRETATIONS)
    .filter((value) => !isCrucibleLog(systemId) || !HIT_POINT_ONLY_INTERPRETATIONS.has(value) || value === selectedInterpretation)
    .map((value) => ({ value, label: localize(`SCLS.Interpretation.${value}`), selected: value === selectedInterpretation }));
}

export const __test__ = {
  gmOnly, visibleTabs, topActions,
  chartContext, awardCards, warningLines, combatMetrics, combatRounds, correctionEvents, dprRows, sortedDprRows, dprColumns, participantRows, manualAdjustmentEvents, historyRows, tabNavigation,
  confirmDeleteCombatLog, interpretationOptions, applyReportSettings, reportSettingsFromForm, reportPreviewHtml, reportSectionOptions, showReportSections, fitTabs, sharingContext, copyText, showDiscordParts, discordPartsContent
};
