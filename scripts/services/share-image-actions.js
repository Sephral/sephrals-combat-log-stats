import { MODULE_ID, SETTINGS } from "../constants.js";
import { getSetting } from "../settings.js";
import { countFeature } from "../usage.mjs";
import { escapeHtml, localize } from "../utils.js";
import { isAbsoluteUrl, isTheForge, withTimeout } from "./persistence-service.js";
import { renderShareImage, shareImageFileName } from "./share-image.js";

// What the buttons "Copy as image", "Save as image" and "Post as image in chat" do with the picture of share-image.js.

const UPLOAD_TIMEOUT_MS = 20000;
const IMAGE_FOLDER = "images";

const notify = (type, key) => globalThis.ui?.notifications?.[type]?.(localize(key));

/** The clipboard takes pictures on secure pages only (https or localhost), and only in browsers with ClipboardItem. */
export function canCopyImage() {
  return Boolean(globalThis.isSecureContext && globalThis.navigator?.clipboard?.write && typeof globalThis.ClipboardItem !== "undefined");
}

/** Uploading needs the permission to upload files and a file picker. Players usually have neither. */
export function canPostImage() {
  const user = globalThis.game?.user;
  if (!user) return false;
  if (!(user.isGM || user.can?.("FILES_UPLOAD"))) return false;
  return Boolean(filePicker()?.upload);
}

function filePicker() {
  return globalThis.foundry?.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker;
}

// Like Foundry's own saveDataToFile: a detached link that gets a click event. A link in the page can be taken over
// by other click handlers and open the picture in a tab instead.
function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/** Saves the picture as a file in the browser's downloads. */
export async function saveFightImage(log, options = {}) {
  try {
    const blob = await renderShareImage(log, options);
    download(blob, shareImageFileName(log));
    countFeature(MODULE_ID, "imageSaved");
    notify("info", "SCLS.ShareImage.Saved");
    return "saved";
  } catch (error) {
    console.warn(`${MODULE_ID} | Could not draw the picture of the fight`, error);
    notify("warn", "SCLS.ShareImage.Failed");
    return null;
  }
}

/**
 * Puts the picture on the clipboard. Where the browser refuses (plain http, no ClipboardItem, no permission) the picture
 * is saved as a file instead and the message says why.
 * @returns {Promise<"copied"|"saved"|null>}
 */
export async function copyFightImage(log, options = {}) {
  // The picture is drawn while the clipboard waits for it, so the click still counts as the user's action.
  const drawing = renderShareImage(log, options);
  drawing.catch(() => {});
  if (canCopyImage()) {
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": drawing })]);
      countFeature(MODULE_ID, "imageCopied");
      notify("info", "SCLS.ShareImage.Copied");
      return "copied";
    } catch (error) {
      console.debug(`${MODULE_ID} | The clipboard refused the picture`, error);
    }
  }
  try {
    download(await drawing, shareImageFileName(log));
    countFeature(MODULE_ID, "imageSaved");
    notify("warn", "SCLS.ShareImage.CopyFallback");
    return "saved";
  } catch (error) {
    console.warn(`${MODULE_ID} | Could not draw the picture of the fight`, error);
    notify("warn", "SCLS.ShareImage.Failed");
    return null;
  }
}

// The folder of the pictures next to the combat log store: the world's data folder, on The Forge the Assets Library.
async function ensureImageFolder(persistence) {
  const FilePicker = filePicker();
  await persistence.ensureDirectories();
  const folder = `${persistence.storageBasePath()}/${IMAGE_FOLDER}`;
  if (isTheForge()) {
    try {
      await FilePicker.createDirectory("forgevtt", folder, { notify: false });
    } catch {
      // The Forge creates a missing folder on upload too.
    }
    return folder;
  }
  try {
    await FilePicker.browse("data", folder, { notify: false });
  } catch {
    try {
      await FilePicker.createDirectory("data", folder, { notify: false });
    } catch {
      // An existing folder or a refusal: the upload decides.
    }
  }
  return folder;
}

/** The chat message for an uploaded picture. */
export function shareImageMessageHtml(url, title) {
  const src = escapeHtml(url);
  const alt = escapeHtml(title || localize("SCLS.EndCard.TitlePlain"));
  return `<div class="scls-shareimage"><a href="${src}" target="_blank" rel="noopener"><img src="${src}" alt="${alt}"></a></div>`;
}

/**
 * Uploads the picture to the world's data folder and posts it in the chat for everyone, so players can take it.
 * Needs "Allow player reports" (a picture in the chat is a share) and the permission to upload files.
 * @param {object} log
 * @param {object} options    statsOptions, persistence (the store service that knows the folders)
 * @returns {Promise<object|null>} the chat message, null when nothing was posted
 */
export async function postFightImage(log, { persistence, ...options } = {}) {
  if (getSetting(SETTINGS.ENABLE_PLAYER_SHARING, true) === false) {
    notify("warn", "SCLS.ShareImage.PostOff");
    return null;
  }
  if (!canPostImage() || !persistence) {
    notify("warn", "SCLS.ShareImage.PostNoUpload");
    return null;
  }
  try {
    const blob = await renderShareImage(log, options);
    const folder = await ensureImageFolder(persistence);
    const name = `fight-${String(log.id ?? "log").replace(/[^A-Za-z0-9_-]/g, "").slice(-24)}-${Date.now().toString(36)}.png`;
    const file = new File([blob], name, { type: "image/png" });
    const response = await withTimeout(filePicker().upload(persistence.storageSource(), folder, file, {}, { notify: false }), UPLOAD_TIMEOUT_MS, "Timed out while uploading the picture of the fight");
    if (!response?.path) throw new Error("The upload returned no file path");
    const url = isAbsoluteUrl(response.path) || response.path.startsWith("/") ? response.path : (globalThis.foundry?.utils?.getRoute?.(response.path) ?? `/${response.path}`);
    const message = await globalThis.ChatMessage.create({
      content: shareImageMessageHtml(url, log.title),
      speaker: { alias: globalThis.game?.modules?.get?.(MODULE_ID)?.title ?? "Combat Log & Stats" },
      whisper: [],
      flags: { [MODULE_ID]: { shareImage: { logId: log.id } } }
    });
    countFeature(MODULE_ID, "imagePosted");
    notify("info", "SCLS.ShareImage.Posted");
    return message;
  } catch (error) {
    console.warn(`${MODULE_ID} | Could not post the picture of the fight`, error);
    notify("warn", "SCLS.ShareImage.PostFailed");
    return null;
  }
}

/** The log of a button: a GM reads it live, a player from the store as the GM last saved it. */
export async function logForImage(service, logId) {
  if (!service || !logId) return null;
  if (globalThis.game?.user?.isGM && service.getLog) return service.getLog(logId);
  // Players must not draw from a log cached before the GM changed it or its share mode.
  service.persistence?.cache?.delete?.(logId);
  return service.persistence?.loadLog?.(logId) ?? null;
}

/**
 * One of the three buttons.
 * @param {"copy"|"save"|"post"} kind
 * @param {object} service    the combat log service (statsOptions, persistence)
 * @param {string} logId
 */
export async function runShareImage(kind, service, logId) {
  const log = await logForImage(service, logId);
  if (!log) {
    notify("warn", "SCLS.ShareImage.NoLog");
    return null;
  }
  const options = { statsOptions: service.statsOptions?.() ?? {} };
  if (kind === "copy") return copyFightImage(log, options);
  if (kind === "save") return saveFightImage(log, options);
  if (kind === "post") return postFightImage(log, { ...options, persistence: service.persistence });
  return null;
}
