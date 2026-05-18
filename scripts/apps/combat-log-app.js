import { CONFIDENCE, EVENT_TYPES, HOOKS, MODULE_ID, RESOURCE_INTERPRETATIONS, SETTINGS, SHARE_MODES, SIDES, TABS } from "../constants.js";
import { getSetting } from "../settings.js";
import { escapeHtml, formatDateTime, formatDuration, localize, renderAppTemplate } from "../utils.js";
import { CombatLogExportService } from "../services/export-service.js";
import { normalizeReportSections, PlayerReportService, REPORT_SECTIONS } from "../services/player-report-service.js";

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
      ignoreEvent: CombatLogApp.#onIgnoreEvent,
      restoreEvent: CombatLogApp.#onRestoreEvent,
      setSide: CombatLogApp.#onSetSide,
      toggleSharing: CombatLogApp.#onToggleSharing,
      renameLog: CombatLogApp.#onRenameLog,
      postPlayerReport: CombatLogApp.#onPostPlayerReport,
      createJournalReport: CombatLogApp.#onCreateJournalReport,
      exportJson: CombatLogApp.#onExportJson,
      exportMarkdown: CombatLogApp.#onExportMarkdown,
      openLog: CombatLogApp.#onOpenLog,
      deleteLog: CombatLogApp.#onDeleteLog,
      sortDpr: CombatLogApp.#onSortDpr
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
        tabNavigation: tabNavigation(false, this.activeTab),
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
      tabNavigation: tabNavigation(true, this.activeTab),
      historyRows: historyRows(historyEntries, log.id),
      summary: summaryContext(log),
      timelineEvents: timelineEvents(log),
      combatRounds: combatRounds(log),
      combatMetrics: combatMetrics(log),
      correctionEvents: correctionEvents(log),
      manualAdjustmentEvents: manualAdjustmentEvents(log),
      participants: participantRows(log),
      dprRows: sortedDprRows(log, this.dprSort),
      dprColumns: dprColumns(this.dprSort),
      sideRows: computed.dpr?.bySide ?? [],
      rawEvents: log.events ?? [],
      reportSectionOptions: reportSectionOptions(log),
      canShareReport: this.playerReports.canShare(reportReadyLog(log)),
      includeUnclearDeltasInStats: getSetting(SETTINGS.INCLUDE_UNCLEAR_DELTAS_IN_STATS, false)
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    for (const panel of this.element.querySelectorAll("[data-panel]")) panel.hidden = panel.dataset.panel !== this.activeTab;
    for (const element of this.element.querySelectorAll("[data-detail-only]")) element.hidden = this.activeTab === "history";
    for (const select of this.element.querySelectorAll("select[data-scls-action]")) {
      select.addEventListener("change", (event) => this.handleSelectChange(event));
    }
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

  static async #onSortDpr(_event, target) {
    const key = target.dataset.sortKey;
    const column = DPR_COLUMNS.find((entry) => entry.key === key);
    if (!column) return;
    const current = this.dprSort ?? {};
    this.dprSort = {
      key,
      direction: current.key === key && current.direction === "desc" ? "asc" : "desc"
    };
    await this.render();
  }

  static async #onDeleteLog(_event, target) {
    const logId = target.dataset.logId;
    if (!logId) return;
    const title = String(target.dataset.logTitle ?? "").trim();
    const confirmed = await confirmDeleteCombatLog(title);
    if (!confirmed) return;
    const deleted = await this.service.deleteLog(logId);
    if (!deleted) return;
    if (this.logId === logId) this.logId = null;
    this.activeTab = "history";
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

  async handleSelectChange(event) {
    const target = event.currentTarget;
    switch (target.dataset.sclsAction) {
      case "classify":
        return CombatLogApp.#onClassify.call(this, event, target);
      case "setSide":
        return CombatLogApp.#onSetSide.call(this, event, target);
      default:
        return null;
    }
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
    applyReportSettings(log, formData);
    await this.saveLog(log);
  }

  static async #onRenameLog(_event, target) {
    const log = await this.getLog();
    if (!log) return;
    const form = target.closest("form");
    const title = String(new FormData(form).get("title") ?? "").trim();
    if (!title || title === log.title) return;
    log.title = title;
    log.lastSeenAt = new Date().toISOString();
    await this.saveLog(log);
  }

  static async #onPostPlayerReport(_event, target) {
    const log = await this.getLog();
    if (!log) return;
    applyReportSettings(log, new FormData(target.closest("form")));
    await this.playerReports.postChatSummary(log);
    await this.saveLog(log);
  }

  static async #onCreateJournalReport(_event, target) {
    const log = await this.getLog();
    if (!log) return;
    applyReportSettings(log, new FormData(target.closest("form")));
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
  if (typeof globalThis.Dialog?.confirm === "function") {
    return Boolean(await globalThis.Dialog.confirm({ title: dialogTitle, content, yes: () => true, no: () => false, defaultYes: false }));
  }
  const message = title ? `${localize("SCLS.Confirm.DeleteCombat")}\n\n${title}` : localize("SCLS.Confirm.DeleteCombat");
  return Boolean(globalThis.confirm?.(message));
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
  return TABS.filter((id) => hasLog || id === "history").map((id) => ({ id, label: localize(`SCLS.Tab.${id}`), icon: tabIcon(id), active: id === activeTab }));
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

function tabNavigation(hasLog, activeTab) {
  const tabs = visibleTabs(hasLog, activeTab);
  return {
    hasTabs: tabs.length > 0,
    historyTab: tabs.find((tab) => tab.id === "history") ?? null,
    detailTabs: hasLog ? tabs.filter((tab) => tab.id !== "history") : [],
    showConnector: Boolean(hasLog),
    connectorLabel: localize("SCLS.Navigation.SelectedCombat"),
    connectorArrow: "-->"
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

function timelineEvents(log) {
  return (log.events ?? []).map((event) => ({
    ...event,
    label: naturalEventLabel(event),
    createdLabel: formatDateTime(event.createdAt)
  }));
}

function combatRounds(log) {
  const participants = participantLookup(log);
  const roundNumbers = new Set((log.events ?? []).map((event) => Number(event.round) || 0).filter((round) => round > 0));
  const maxRound = Math.max(0, log.computed?.summary?.rounds ?? 0, ...roundNumbers);
  const rounds = [];
  for (let round = 1; round <= maxRound; round += 1) {
    const events = (log.events ?? []).filter((event) => (Number(event.round) || 0) === round && !event.ignored);
    const actions = events.map((event) => roundAction(event, participants)).filter(Boolean);
    if (!actions.length) continue;
    const heroDamage = sumRoundAmount(actions, SIDES.FRIENDLY, "damage");
    const foeDamage = sumRoundAmount(actions, SIDES.HOSTILE, "damage");
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

function dprRows(log) {
  const participants = participantLookup(log);
  const disciplineStats = disciplineStatsByCombatant(log, participants);
  return (log.computed?.dpr?.byCombatant ?? []).map((row) => {
    const participant = participants.byCombatantId.get(row.id) ?? participants.byName.get(normalizeLabel(row.name));
    const disciplines = disciplineStats.get(row.id) ?? emptyDisciplineStats();
    return {
      ...row,
      ...disciplines,
      img: participant?.img ?? "icons/svg/mystery-man.svg",
      name: row.name || participant?.name || row.id || "-"
    };
  });
}

const DPR_COLUMNS = Object.freeze([
  { key: "name", labelKey: "SCLS.Label.Combatant", type: "string" },
  { key: "side", labelKey: "SCLS.Label.Side", type: "string" },
  { key: "damageAppliedNet", labelKey: "SCLS.Label.NetDamage", type: "number" },
  { key: "healing", labelKey: "SCLS.Label.Healing", type: "number" },
  { key: "martial", labelKey: "SCLS.Label.Martial", type: "number" },
  { key: "ranged", labelKey: "SCLS.Label.Ranged", type: "number" },
  { key: "magic", labelKey: "SCLS.Label.Magic", type: "number" },
  { key: "control", labelKey: "SCLS.Label.Control", type: "number" },
  { key: "downed", labelKey: "SCLS.Label.Downed", type: "number" },
  { key: "netDPR", labelKey: "SCLS.Label.NetDPR", type: "number" }
]);

function dprColumns(sort = {}) {
  return DPR_COLUMNS.map((column) => {
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

function combatMetrics(log) {
  const rows = dprRows(log);
  const participants = participantLookup(log);
  const topDamage = Math.max(0, ...rows.map((row) => Number(row.damageAppliedNet) || 0));
  const topHealing = Math.max(0, ...rows.map((row) => Number(row.healing) || 0));
  const contributionRows = rows.slice(0, 8).map((row) => ({
    ...row,
    damagePercent: percent(row.damageAppliedNet, topDamage),
    healingPercent: percent(row.healing, topHealing),
    impact: impactLabel(row)
  }));
  const totals = disciplineTotals(log, participants);
  const outputTotal = Math.max(1, totals.damage, totals.healing);
  const actionTotal = Math.max(1, totals.actionCount);
  const disciplineRows = [
    metricDiscipline("damage", localize("SCLS.Label.NetDamage"), totals.damage, outputTotal, "damage"),
    metricDiscipline("healing", localize("SCLS.Label.Healing"), totals.healing, outputTotal, "healing"),
    metricDiscipline("martial", localize("SCLS.Label.Martial"), totals.martial, actionTotal, "martial"),
    metricDiscipline("ranged", localize("SCLS.Label.Ranged"), totals.ranged, actionTotal, "ranged"),
    metricDiscipline("magic", localize("SCLS.Label.Magic"), totals.magic, actionTotal, "magic"),
    metricDiscipline("control", localize("SCLS.Label.Control"), totals.control, actionTotal, "control"),
    metricDiscipline("downed", localize("SCLS.Label.Downed"), totals.downed, actionTotal, "downed")
  ];
  return {
    pressureRows: pressureRows(log),
    contributionRows,
    disciplineRows,
    topActions: topActions(log, participants),
    totals
  };
}

function disciplineTotals(log, participants) {
  const totals = { damage: 0, healing: 0, martial: 0, ranged: 0, magic: 0, control: 0, downed: 0, actionCount: 0 };
  for (const event of log.events ?? []) {
    if (event.ignored) continue;
    const amount = eventAmount(event);
    if (isDamageEvent(event)) totals.damage += amount;
    if (isHealingEvent(event)) totals.healing += amount;
    if (isMartialAction(event)) totals.martial += 1;
    if (isRangedAction(event)) totals.ranged += 1;
    if (isMagicAction(event)) totals.magic += 1;
    if (isControlEvent(event)) totals.control += 1;
    if (targetFellToZero(event) && targetForEvent(event, participants)?.side === SIDES.FRIENDLY) totals.downed += 1;
    if (isDamageEvent(event) || isHealingEvent(event) || isControlEvent(event)) totals.actionCount += 1;
  }
  return totals;
}

function metricDiscipline(id, label, value, total, tone) {
  return { id, label, value, percent: percent(value, total), tone };
}

function pressureRows(log) {
  const rows = log.computed?.dpr?.bySide ?? [];
  const topDamage = Math.max(0, ...rows.map((row) => Number(row.damageAppliedNet) || 0));
  return rows.map((row) => ({
    ...row,
    label: localize(`SCLS.Side.${row.id ?? row.name}`),
    pressurePercent: percent(row.damageAppliedNet, topDamage)
  }));
}

function topActions(log, participants) {
  const actions = new Map();
  for (const event of log.events ?? []) {
    if (event.ignored || !(isDamageEvent(event) || isHealingEvent(event) || isControlEvent(event))) continue;
    const name = actionDetail(event) || event.data?.name || event.type;
    const kind = actionKind(event);
    const key = `${kind}:${normalizeLabel(name)}`;
    const source = participantForEvent(event, participants);
    const amount = eventAmount(event);
    const row = actions.get(key) ?? { name, kind, uses: 0, amount: 0, actors: new Set() };
    row.uses += 1;
    row.amount += amount;
    if (source?.name) row.actors.add(source.name);
    actions.set(key, row);
  }
  return Array.from(actions.values())
    .map((row) => ({ ...row, actors: Array.from(row.actors).slice(0, 3).join(", ") || "-", average: row.uses ? Math.round((row.amount / row.uses) * 10) / 10 : 0 }))
    .sort((left, right) => (right.amount - left.amount) || (right.uses - left.uses) || left.name.localeCompare(right.name))
    .slice(0, 8);
}

function actionKind(event) {
  if (isHealingEvent(event)) return "healing";
  if (isControlEvent(event)) return "control";
  if (isDamageEvent(event)) return "damage";
  return "utility";
}

function impactLabel(row) {
  const parts = [];
  if (row.damageAppliedNet) parts.push(`${row.damageAppliedNet} ${localize("SCLS.Label.NetDamage")}`);
  if (row.healing) parts.push(`${row.healing} ${localize("SCLS.Label.Healing")}`);
  if (row.control) parts.push(`${row.control} ${localize("SCLS.Label.Control")}`);
  if (row.downed) parts.push(`${row.downed} ${localize("SCLS.Label.Downed")}`);
  return parts.join(" | ") || "-";
}

function percent(value, total) {
  const numericValue = Number(value) || 0;
  const numericTotal = Number(total) || 0;
  if (numericValue <= 0 || numericTotal <= 0) return 0;
  return Math.max(2, Math.min(100, Math.round((numericValue / numericTotal) * 100)));
}

function disciplineStatsByCombatant(log, participants) {
  const stats = new Map((log.participants ?? []).map((participant) => [participant.combatantId, emptyDisciplineStats()]));
  for (const event of log.events ?? []) {
    if (event.ignored) continue;
    const source = participantForEvent(event, participants);
    const target = targetForEvent(event, participants);
    const amount = eventAmount(event);
    if (source?.combatantId) {
      const row = stats.get(source.combatantId) ?? emptyDisciplineStats();
      if (isDamageEvent(event)) row.damage += amount;
      if (isHealingEvent(event)) row.healing += amount;
      if (isMartialAction(event)) row.martial += 1;
      if (isRangedAction(event)) row.ranged += 1;
      if (isMagicAction(event)) row.magic += 1;
      if (isControlEvent(event)) row.control += 1;
      stats.set(source.combatantId, row);
    }
    if (target?.combatantId && targetFellToZero(event)) {
      const row = stats.get(target.combatantId) ?? emptyDisciplineStats();
      row.downed += 1;
      stats.set(target.combatantId, row);
    }
  }
  return stats;
}

function emptyDisciplineStats() {
  return { damage: 0, healing: 0, martial: 0, ranged: 0, magic: 0, control: 0, downed: 0 };
}

function reportReadyLog(log) {
  return {
    ...log,
    shareSettings: {
      ...log?.shareSettings,
      isShared: true,
      shareMode: SHARE_MODES.FULL_VISIBLE_RECAP,
      includePartyStats: true,
      includeEnemyStats: true,
      includeNpcNames: true,
      includePrivateRolls: false,
      includeGMNotes: false,
      includeUnclearEvents: false,
      includeCorrections: false,
      anonymizeEnemies: false,
      allowPlayersToOpenReport: true
    }
  };
}

function reportSectionOptions(log) {
  const selected = normalizeReportSections(log.shareSettings?.reportSections);
  return REPORT_SECTIONS.map((section) => ({
    value: section.key,
    label: localize(section.labelKey),
    selected: selected[section.key] !== false
  }));
}

function reportSectionsFromForm(formData) {
  const selected = new Set(formData.getAll("reportSections").map(String));
  return Object.fromEntries(REPORT_SECTIONS.map((section) => [section.key, selected.has(section.key)]));
}

function applyReportSettings(log, formData) {
  log.shareSettings = {
    ...log.shareSettings,
    isShared: true,
    shareMode: SHARE_MODES.FULL_VISIBLE_RECAP,
    includePartyStats: true,
    includeEnemyStats: true,
    includeNpcNames: true,
    includeHiddenCombatants: false,
    includePrivateRolls: false,
    includeGMNotes: false,
    includeUnclearEvents: false,
    includeDPR: formData.getAll("reportSections").includes("damageSpotlight"),
    includeTimeline: formData.getAll("reportSections").some((value) => ["martialHighlights", "spellwork", "healingSupport", "controlPlays", "closeCalls", "heroMoments", "enemyPressure", "tacticalTurningPoints", "supportSaves"].includes(value)),
    includeCorrections: false,
    anonymizeEnemies: false,
    allowPlayersToOpenReport: true,
    reportSections: reportSectionsFromForm(formData),
    shareUpdatedAt: new Date().toISOString()
  };
  if (log.shareSettings.isShared && !log.shareSettings.shareStartedAt) log.shareSettings.shareStartedAt = log.shareSettings.shareUpdatedAt;
}

function participantLookup(log) {
  const byCombatantId = new Map();
  const byActorUuid = new Map();
  const byTokenUuid = new Map();
  const byName = new Map();
  for (const participant of log.participants ?? []) {
    if (participant.combatantId) byCombatantId.set(participant.combatantId, participant);
    if (participant.actorUuid) byActorUuid.set(participant.actorUuid, participant);
    if (participant.tokenUuid) byTokenUuid.set(participant.tokenUuid, participant);
    if (participant.name) byName.set(normalizeLabel(participant.name), participant);
  }
  return { byCombatantId, byActorUuid, byTokenUuid, byName };
}

function participantForEvent(event, participants) {
  return participants.byCombatantId.get(event.combatantId) ?? participants.byActorUuid.get(event.actorUuid) ?? participants.byTokenUuid.get(event.tokenUuid) ?? null;
}

function targetForEvent(event, participants) {
  return participants.byCombatantId.get(event.data?.targetCombatantId) ?? participants.byActorUuid.get(event.data?.targetActorUuid) ?? participants.byTokenUuid.get(event.data?.targetTokenUuid) ?? participants.byName.get(normalizeLabel(event.data?.targetName)) ?? null;
}

function roundAction(event, participants) {
  const source = participantForEvent(event, participants);
  const target = targetForEvent(event, participants);
  const amount = eventAmount(event);
  const actor = source?.name ?? event.data?.actorName ?? event.data?.speaker?.alias ?? "-";
  const targetName = target?.name ?? event.data?.targetName ?? event.data?.targetNames?.join?.(", ") ?? "-";
  const side = source?.side ?? SIDES.UNKNOWN;
  const detail = actionDetail(event);
  switch (event.type) {
    case EVENT_TYPES.DAMAGE_APPLIED:
    case EVENT_TYPES.DAMAGE_MANUAL_ADDED:
      return actionRow(event, "damage", side, actor, targetName, amount, localize("SCLS.Protocol.Damage"), detail);
    case EVENT_TYPES.DAMAGE_MANUAL_REDUCED:
      return actionRow(event, "correction", side, actor, targetName, amount, localize("SCLS.Protocol.DamageReduced"), detail);
    case EVENT_TYPES.HEALING_APPLIED:
    case EVENT_TYPES.HEALING_MANUAL_ADDED:
      return actionRow(event, "healing", side, actor, targetName, amount, localize("SCLS.Protocol.Healing"), detail);
    case EVENT_TYPES.HEALING_MANUAL_REDUCED:
      return actionRow(event, "correction", side, actor, targetName, amount, localize("SCLS.Protocol.HealingReduced"), detail);
    case EVENT_TYPES.RESOURCE_DELTA:
    case EVENT_TYPES.RESOURCE_DELTA_OFFLINE:
      return resourceDeltaAction(event, source, targetName, side, actor, amount);
    case EVENT_TYPES.ROLL_DAMAGE:
      return actionRow(event, "roll", side, actor, targetName, amount, localize("SCLS.Protocol.DamageRoll"), detail);
    case EVENT_TYPES.ROLL_HEALING:
      return actionRow(event, "roll", side, actor, targetName, amount, localize("SCLS.Protocol.HealingRoll"), detail);
    case EVENT_TYPES.ACTIVE_EFFECT_CREATED:
      return actionRow(event, "effect", side, actor, targetName, 0, localize("SCLS.Protocol.EffectAdded"), event.data?.name ?? "");
    case EVENT_TYPES.ACTIVE_EFFECT_DELETED:
      return actionRow(event, "effect", side, actor, targetName, 0, localize("SCLS.Protocol.EffectRemoved"), event.data?.name ?? "");
    default:
      return null;
  }
}

function resourceDeltaAction(event, source, targetName, side, actor, amount) {
  switch (event.data?.interpretedAs) {
    case RESOURCE_INTERPRETATIONS.DAMAGE:
      return actionRow(event, "damage", side, actor, targetName || source?.name || "-", amount, localize("SCLS.Protocol.Damage"));
    case RESOURCE_INTERPRETATIONS.HEALING:
      return actionRow(event, "healing", side, actor, targetName || source?.name || "-", amount, localize("SCLS.Protocol.Healing"));
    case RESOURCE_INTERPRETATIONS.CORRECTION_DAMAGE_UP:
    case RESOURCE_INTERPRETATIONS.CORRECTION_DAMAGE_DOWN:
      return actionRow(event, "correction", side, actor, targetName || source?.name || "-", amount, localize("SCLS.Protocol.DamageCorrection"));
    case RESOURCE_INTERPRETATIONS.CORRECTION_HEALING_UP:
    case RESOURCE_INTERPRETATIONS.CORRECTION_HEALING_DOWN:
      return actionRow(event, "correction", side, actor, targetName || source?.name || "-", amount, localize("SCLS.Protocol.HealingCorrection"));
    default:
      return null;
  }
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
    time: formatDateTime(event.createdAt),
    amountLabel: amount > 0 ? String(amount) : "-"
  };
}

function sumRoundAmount(actions, side, kind) {
  return actions.filter((action) => action.side === side && action.kind === kind).reduce((total, action) => total + action.amount, 0);
}

function roundSummary(heroDamage, foeDamage, healing, actionCount) {
  const parts = [`${actionCount} ${localize("SCLS.Protocol.Actions")}`];
  if (heroDamage) parts.push(`${localize("SCLS.Protocol.Heroes")}: ${heroDamage}`);
  if (foeDamage) parts.push(`${localize("SCLS.Protocol.Enemies")}: ${foeDamage}`);
  if (healing) parts.push(`${localize("SCLS.Protocol.HealingShort")}: ${healing}`);
  return parts.join(" | ");
}

function eventAmount(event) {
  return Math.abs(Number(event?.data?.amount ?? event?.data?.delta ?? event?.data?.total ?? 0)) || 0;
}

function actionDetail(event) {
  return String(event?.data?.actionName ?? event?.data?.spellName ?? event?.data?.itemName ?? "").trim();
}

function isDamageEvent(event) {
  return [EVENT_TYPES.DAMAGE_APPLIED, EVENT_TYPES.DAMAGE_MANUAL_ADDED, EVENT_TYPES.ROLL_DAMAGE].includes(event.type) || event.data?.interpretedAs === RESOURCE_INTERPRETATIONS.DAMAGE;
}

function isHealingEvent(event) {
  return [EVENT_TYPES.HEALING_APPLIED, EVENT_TYPES.HEALING_MANUAL_ADDED, EVENT_TYPES.ROLL_HEALING].includes(event.type) || event.data?.interpretedAs === RESOURCE_INTERPRETATIONS.HEALING;
}

function isControlEvent(event) {
  if ([EVENT_TYPES.ACTIVE_EFFECT_CREATED, EVENT_TYPES.ACTIVE_EFFECT_UPDATED, EVENT_TYPES.ACTIVE_EFFECT_DELETED].includes(event.type)) return true;
  return /control|stun|slow|prone|restrain|fear|fright|hex|pin|blind|charm|silence|web|hold|banish|bless|bane|paraly/i.test(`${actionDetail(event)} ${event?.data?.name ?? ""}`);
}

function isMagicAction(event) {
  if (isHealingEvent(event) || isControlEvent(event)) return false;
  return /spell|magic|fireball|bolt|shatter|cone|wave|burst|cloud|storm|spirit|sacred|radiant|necrotic|shadow|arcane|thunder|lightning|orb|missile|ray|hex|blight|guiding|burning|scorching|vitriolic|sphere|guardians/i.test(actionDetail(event));
}

function isRangedAction(event) {
  return /bow|crossbow|shot|arrow|bolt|ray|missile|blast|throw|thrown|sling/i.test(actionDetail(event));
}

function isMartialAction(event) {
  if (isMagicAction(event)) return false;
  return /sword|slash|strike|dagger|scimitar|bite|claw|bash|slam|charge|lunge|cut|stab|rake|spear|pommel|shield|flourish|riposte|attack|weapon/i.test(actionDetail(event));
}

function targetFellToZero(event) {
  const values = [event?.data?.targetHpAfter, event?.data?.targetRemainingHp, event?.data?.newValue];
  return values.some((value) => Number(value) === 0) || Boolean(event?.data?.targetDowned);
}

function normalizeLabel(value) {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function sideOptions(selectedSide) {
  return Object.values(SIDES).map((value) => ({ value, label: localize(`SCLS.Side.${value}`), selected: value === selectedSide }));
}

function interpretationOptions(selectedInterpretation) {
  return Object.values(RESOURCE_INTERPRETATIONS).map((value) => ({ value, label: localize(`SCLS.Interpretation.${value}`), selected: value === selectedInterpretation }));
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

export const __test__ = { combatMetrics, combatRounds, correctionEvents, dprRows, sortedDprRows, dprColumns, participantRows, manualAdjustmentEvents, historyRows, tabNavigation, confirmDeleteCombatLog };
