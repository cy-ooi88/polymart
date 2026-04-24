import { FIVE_MIN_SECONDS, SLUG_PREFIX } from "./constants.js";
import { dom } from "./dom.js";
import { state } from "./state.js";

export function updateCountdown() {
  if (!Number.isFinite(state.currentWindowEndSec)) {
    dom.minsEl.textContent = "--";
    dom.secsEl.textContent = "--";
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  const remaining = Math.max(0, state.currentWindowEndSec - now);
  const mins = Math.floor(remaining / 60);
  const secs = remaining % 60;
  dom.minsEl.textContent = String(mins).padStart(2, "0");
  dom.secsEl.textContent = String(secs).padStart(2, "0");
}

export function baseTimestampNowSeconds() {
  return Math.floor(Date.now() / 1000 / FIVE_MIN_SECONDS) * FIVE_MIN_SECONDS;
}

export function candidateSlugs() {
  const base = baseTimestampNowSeconds();
  const offsets = [0, -FIVE_MIN_SECONDS, FIVE_MIN_SECONDS];
  return offsets.map((offset) => `${SLUG_PREFIX}${base + offset}`);
}
