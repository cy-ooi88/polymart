import { connectBuyPriceWebSocket, refreshBuyPrices, updateBuyButtons } from "./js/buy-prices.js";
import { setupChart, updateTargetDisplay } from "./js/chart.js";
import { FIVE_MIN_SECONDS, SLUG_PREFIX } from "./js/constants.js";
import { initDataLogger, setDataLoggerEventContext } from "./js/data-logger.js";
import { dom } from "./js/dom.js";
import { fetchTargetPriceBySlug, readTargetPrice, resolveCurrentEvent } from "./js/event-api.js";
import { formatEventWindowEt, formatUsd } from "./js/formatters.js";
import { state } from "./js/state.js";
import { setStatus } from "./js/status.js";
import { baseTimestampNowSeconds, updateCountdown } from "./js/time.js";
import { connectBtcWebSocket } from "./js/btc-stream.js";

function resolveEventUuid(resolved) {
  const eventUuid = resolved?.eventData?.id ?? resolved?.market?.id ?? resolved?.slug;
  return String(eventUuid || "n/a");
}

async function loadEventAndStart() {
  setStatus("Resolving current BTC 5m event...", "warn");
  const resolved = await resolveCurrentEvent();

  state.currentSlug = resolved.slug;
  state.conditionId = resolved.market.conditionId || resolved.market.condition_id || null;
  state.upTokenId = resolved.upTokenId;
  state.downTokenId = resolved.downTokenId;

  const startTs = Number(resolved.slug.split("-").pop());
  const endTs = Number.isFinite(startTs) ? startTs + FIVE_MIN_SECONDS : null;
  const canonicalAnchorMs = Number.isFinite(startTs) ? startTs * 1000 : null;
  const eventUuid = resolveEventUuid(resolved);

  state.currentWindowStartSec = startTs;
  state.currentWindowEndSec = endTs;
  state.targetPriceCanonical = null;
  state.targetPriceCanonicalTs = null;
  state.targetPriceCanonicalAnchorMs = canonicalAnchorMs;
  state.targetPriceFallback = readTargetPrice(resolved.eventData);
  state.latestPrice = null;
  state.upAsk = null;
  state.downAsk = null;
  state.pricePoints = [];

  setDataLoggerEventContext({
    slug: resolved.slug,
    startSec: startTs,
    eventUuid
  });

  dom.eventTitleEl.textContent = String(resolved.eventData?.title || "BTC Up or Down - 5 Minutes");
  dom.eventSubEl.textContent = formatEventWindowEt(startTs, endTs);
  dom.eventSlugEl.href = state.currentSlug
    ? `https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(state.currentSlug)}`
    : "#";
  dom.liveResultLinkEl.href = state.currentSlug
    ? `https://polymarket.com/event/${encodeURIComponent(state.currentSlug)}`
    : "#";
  dom.btcEl.textContent = `$${formatUsd(state.latestPrice)}`;
  updateBuyButtons();
  updateTargetDisplay();
  updateCountdown();

  if (state.currentSlug) {
    fetchTargetPriceBySlug(state.currentSlug).then((target) => {
      if (!Number.isFinite(target)) return;
      if (state.currentSlug !== resolved.slug) return;
      state.targetPriceFallback = target;
      updateTargetDisplay();
    });
  }

  await refreshBuyPrices();
  connectBuyPriceWebSocket();
  connectBtcWebSocket();
}

async function maybeRollEvent() {
  const expected = `${SLUG_PREFIX}${baseTimestampNowSeconds()}`;
  if (expected !== state.currentSlug) {
    await loadEventAndStart();
  }
}

(async () => {
  try {
    initDataLogger();
    setupChart();
    updateBuyButtons();
    await loadEventAndStart();
    setInterval(refreshBuyPrices, 15000);
    setInterval(maybeRollEvent, 5000);
    setInterval(updateCountdown, 1000);
  } catch (err) {
    setStatus(`Startup failed: ${err.message}`, "err");
  }
})();
