import { MODULE_ID, SETTINGS } from "../constants.js";
import { getSetting, setSetting } from "../settings.js";
import { cloneData, debugLog, isGM, isoNow } from "../utils.js";
import { appendEvent, emptyState, normalizeState, trim } from "./offcombat-log.js";
import { forgeAssetUrl, isAbsoluteUrl, isTheForge, supportsClientFileUpload, withTimeout } from "./persistence-service.js";

// Where the log outside fights lives. Foundry 14 writes one small file next to the combat log store (world data
// folder, the Assets Library on The Forge); the world setting then only points to it. Where no file can be written
// (Foundry 13, a failed upload) the nights are kept inside the setting itself, which the lean limits of offcombat-log.js
// keep small. Only a GM writes. Writes are batched: a burst of changes is one upload.

const FILE_NAME = "off-combat.json";
const DEFAULT_DELAY_MS = 4000;
const UPLOAD_TIMEOUT_MS = 10000;

export class OffCombatStore {
  /**
   * @param {object} files  The combat log persistence service, for its folder, directory and read helpers
   * @param {{delayMs?: number}} [options]
   */
  constructor(files, { delayMs = DEFAULT_DELAY_MS } = {}) {
    this.files = files;
    this.delayMs = delayMs;
    this.state = null;
    this.dirty = false;
    this.timer = null;
    this.queue = Promise.resolve();
    this.filesDisabled = false;
  }

  filePath() {
    return `${this.files.storageBasePath()}/${FILE_NAME}`;
  }

  // Another GM wrote. Read the nights again before the next change or view.
  invalidate() {
    if (!this.dirty) this.state = null;
  }

  async load() {
    if (this.state) return this.state;
    const data = getSetting(SETTINGS.OFF_COMBAT_DATA, {}) ?? {};
    let state = null;
    if (data.file) {
      for (const candidate of await this.candidates(data.file)) {
        const loaded = await this.files.tryLoadFromFile(candidate);
        if (loaded) {
          state = normalizeState(loaded);
          break;
        }
      }
    }
    this.state = state ?? normalizeState(data.state ?? emptyState());
    return this.state;
  }

  async candidates(file) {
    const list = [];
    if (file.url) list.push(file.url);
    if (file.path && !isAbsoluteUrl(file.path)) {
      if (isTheForge()) {
        const url = await forgeAssetUrl(file.path);
        if (url) list.push(url);
      }
      list.push(file.path);
    }
    return [...new Set(list)];
  }

  /** A copy of the nights for the views. */
  async snapshot() {
    return cloneData(await this.load());
  }

  async add(event, options = {}) {
    if (!isGM()) return;
    const state = await this.load();
    appendEvent(state, event, options);
    this.dirty = true;
    this.schedule();
  }

  schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.delayMs);
    // A pending write never keeps a process alive (the unit tests).
    this.timer?.unref?.();
  }

  // Applies the retention setting and writes, if anything changed.
  async flush({ retentionDays = 0 } = {}) {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty || !this.state) return false;
    if (!isGM()) return false;
    const next = this.queue.then(() => this.write(retentionDays), () => this.write(retentionDays));
    this.queue = next.catch(() => {});
    return next;
  }

  async write(retentionDays) {
    if (!this.dirty || !this.state) return false;
    trim(this.state, { retentionDays });
    this.dirty = false;
    const written = await this.writeFile(this.state);
    const pointer = written
      ? { v: 1, savedAt: isoNow(), file: written, summary: summary(this.state) }
      : { v: 1, savedAt: isoNow(), file: null, state: cloneData(this.state), summary: summary(this.state) };
    await setSetting(SETTINGS.OFF_COMBAT_DATA, pointer);
    return true;
  }

  async writeFile(state) {
    if (this.filesDisabled || !supportsClientFileUpload()) return null;
    const FilePicker = globalThis.foundry?.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker;
    if (!FilePicker?.upload) {
      this.filesDisabled = true;
      return null;
    }
    try {
      await this.files.ensureDirectories();
      const file = new File([JSON.stringify(state)], FILE_NAME, { type: "application/json" });
      const response = await withTimeout(FilePicker.upload(this.files.storageSource(), this.files.storageBasePath(), file, {}, { notify: false }), UPLOAD_TIMEOUT_MS, "Timed out while uploading the log outside fights");
      if (!response?.path) throw new Error("The upload returned no file path");
      return { path: this.filePath(), url: isTheForge() ? response.path : null };
    } catch (error) {
      this.filesDisabled = true;
      console.warn(`${MODULE_ID} | Failed to write the log outside fights`, error);
      debugLog("Log outside fights stays in the world setting", error);
      return null;
    }
  }

  // A reload or closing the tab should not lose the last burst.
  stash() {
    return this.flush();
  }
}

function summary(state) {
  return { nights: state.nights.length, events: state.nights.reduce((total, night) => total + night.events.length, 0) };
}
