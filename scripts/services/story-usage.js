import { MODULE_ID } from "../constants.js";
import { countFeature } from "../usage.mjs";

// Counter roundStoryShown: once per log and session, wherever the sentences appear first (Round Log or end card).
const counted = new Set();

export function countRoundStory(logId) {
  const key = String(logId ?? "");
  if (!key || counted.has(key)) return;
  counted.add(key);
  countFeature(MODULE_ID, "roundStoryShown");
}
