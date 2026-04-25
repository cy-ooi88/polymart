import { dom } from "./dom.js";
import { state } from "./state.js";

const EVENT_HEADERS = [
  "event_slug",
  "event_timestamp",
  "price_to_beat_canonical",
  "price_to_beat_fallback",
  "event_uuid"
];

const PRICE_HEADERS = [
  "event_uuid",
  "timestamp",
  "current_price",
  "buy_up",
  "buy_down"
];

const EVENT_FALLBACK_WAIT_MS = 60_000;
const NA = "n/a";

const loggerState = {
  enabled: false,
  eventRows: [],
  priceRows: [],
  loggedEventSlugs: new Set(),
  pendingEventTimeoutId: null,
  currentEvent: null,
  lastTicks: {
    current_price: null,
    buy_up: null,
    buy_down: null
  }
};

function toIsoTimestamp(ms) {
  return new Date(ms).toISOString();
}

function toCsvCell(value) {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (!/[",\r\n]/.test(s)) return s;
  return `"${s.replace(/"/g, "\"\"")}"`;
}

function rowsToCsv(headers, rows) {
  const lines = [headers.join(",")];
  rows.forEach((row) => {
    const line = headers.map((h) => toCsvCell(row[h])).join(",");
    lines.push(line);
  });
  return `${lines.join("\n")}\n`;
}

function triggerCsvDownload(filename, headers, rows) {
  const csv = rowsToCsv(headers, rows);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();

  URL.revokeObjectURL(url);
}

function formatMaybeNumber(value) {
  return Number.isFinite(value) ? String(value) : NA;
}

function clearPendingEventTimer() {
  if (!loggerState.pendingEventTimeoutId) return;
  clearTimeout(loggerState.pendingEventTimeoutId);
  loggerState.pendingEventTimeoutId = null;
}

function refreshDownloadButtonState() {
  if (dom.downloadEventListBtnEl) {
    dom.downloadEventListBtnEl.disabled = loggerState.eventRows.length === 0;
  }
  if (dom.downloadPriceFeedBtnEl) {
    dom.downloadPriceFeedBtnEl.disabled = loggerState.priceRows.length === 0;
  }
}

function emitEventRowIfDue(eventSlug) {
  loggerState.pendingEventTimeoutId = null;
  if (!loggerState.enabled) return;

  const event = loggerState.currentEvent;
  if (!event || event.slug !== eventSlug) return;
  if (loggerState.loggedEventSlugs.has(eventSlug)) return;

  loggerState.eventRows.push({
    event_slug: event.slug,
    event_timestamp: toIsoTimestamp(event.startSec * 1000),
    price_to_beat_canonical: formatMaybeNumber(state.targetPriceCanonical),
    price_to_beat_fallback: formatMaybeNumber(state.targetPriceFallback),
    event_uuid: event.eventUuid
  });
  loggerState.loggedEventSlugs.add(eventSlug);
  refreshDownloadButtonState();
}

function scheduleEventRow() {
  clearPendingEventTimer();
  if (!loggerState.enabled || !loggerState.currentEvent) return;

  const { slug, startSec } = loggerState.currentEvent;
  if (loggerState.loggedEventSlugs.has(slug)) return;

  const dueAtMs = (startSec * 1000) + EVENT_FALLBACK_WAIT_MS;
  const delayMs = Math.max(0, dueAtMs - Date.now());
  loggerState.pendingEventTimeoutId = setTimeout(() => {
    emitEventRowIfDue(slug);
  }, delayMs);
}

function primeTickCarryForwardState() {
  if (Number.isFinite(state.latestPrice)) loggerState.lastTicks.current_price = state.latestPrice;
  if (Number.isFinite(state.upAsk)) loggerState.lastTicks.buy_up = state.upAsk;
  if (Number.isFinite(state.downAsk)) loggerState.lastTicks.buy_down = state.downAsk;
}

export function initDataLogger() {
  if (dom.logToggleEl) {
    dom.logToggleEl.checked = false;
    dom.logToggleEl.addEventListener("change", () => {
      setDataLoggingEnabled(dom.logToggleEl.checked);
    });
  }

  if (dom.downloadEventListBtnEl) {
    dom.downloadEventListBtnEl.addEventListener("click", () => {
      triggerCsvDownload("event_list.csv", EVENT_HEADERS, loggerState.eventRows);
    });
  }

  if (dom.downloadPriceFeedBtnEl) {
    dom.downloadPriceFeedBtnEl.addEventListener("click", () => {
      triggerCsvDownload("price_feed_timeseries.csv", PRICE_HEADERS, loggerState.priceRows);
    });
  }

  refreshDownloadButtonState();
}

export function setDataLoggingEnabled(enabled) {
  loggerState.enabled = Boolean(enabled);
  if (dom.logToggleEl && dom.logToggleEl.checked !== loggerState.enabled) {
    dom.logToggleEl.checked = loggerState.enabled;
  }

  clearPendingEventTimer();
  if (loggerState.enabled) {
    primeTickCarryForwardState();
    scheduleEventRow();
  }
}

export function setDataLoggerEventContext({ slug, startSec, eventUuid }) {
  const numericStartSec = Number(startSec);
  loggerState.currentEvent = {
    slug: String(slug || ""),
    startSec: Number.isFinite(numericStartSec) ? numericStartSec : Math.floor(Date.now() / 1000),
    eventUuid: String(eventUuid || NA)
  };

  if (loggerState.enabled) {
    primeTickCarryForwardState();
    scheduleEventRow();
  }
}

export function logPriceTick(kind, value, timestampMs = Date.now()) {
  if (!loggerState.enabled || !loggerState.currentEvent) return;
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return;
  if (!Object.prototype.hasOwnProperty.call(loggerState.lastTicks, kind)) return;

  loggerState.lastTicks[kind] = numericValue;
  loggerState.priceRows.push({
    event_uuid: loggerState.currentEvent.eventUuid,
    timestamp: toIsoTimestamp(timestampMs),
    current_price: formatMaybeNumber(loggerState.lastTicks.current_price),
    buy_up: formatMaybeNumber(loggerState.lastTicks.buy_up),
    buy_down: formatMaybeNumber(loggerState.lastTicks.buy_down)
  });
  refreshDownloadButtonState();
}
