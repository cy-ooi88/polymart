import { connectBuyPriceWebSocket, refreshBuyPrices, updateBuyButtons, updateSellButtons } from "./js/buy-prices.js";
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
import { connectWallet, disconnectWallet, isConnected } from "./wallet.js";
import { placeBuyOrder, placeSellOrder } from "./trading.js";

function buildGammaEventUrl(slug) {
  if (!slug) return "https://gamma-api.polymarket.com/events";
  return `https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}`;
}

function buildLiveResultUrl(slug) {
  if (!slug) return "https://polymarket.com/markets";
  return `https://polymarket.com/event/${encodeURIComponent(slug)}`;
}

function updateExternalLinks(slug) {
  dom.eventSlugEl.href = buildGammaEventUrl(slug);
  dom.liveResultLinkEl.href = buildLiveResultUrl(slug);
}

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
  updateExternalLinks(state.currentSlug);
  dom.btcEl.textContent = `$${formatUsd(state.latestPrice)}`;
  updateBuyButtons();
  updateSellButtons();
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

function updateTradingButtonStates() {
  const connected = isConnected();
  dom.buyUpBtnEl.disabled = !connected;
  dom.buyDownBtnEl.disabled = !connected;
  dom.sellUpBtnEl.disabled = !connected;
  dom.sellDownBtnEl.disabled = !connected;
}

async function handleConnectWallet() {
  try {
    dom.connectWalletBtnEl.disabled = true;
    dom.connectWalletBtnEl.textContent = "Connecting...";
    setStatus("Connecting wallet...", "warn");

    const address = await connectWallet();

    dom.walletAddressEl.textContent = `${address.slice(0, 6)}...${address.slice(-4)}`;
    dom.connectWalletBtnEl.style.display = "none";
    dom.disconnectWalletBtnEl.style.display = "inline-block";
    updateTradingButtonStates();
    setStatus("Wallet connected successfully", "ok");
  } catch (error) {
    console.error("Wallet connection failed:", error);
    dom.connectWalletBtnEl.disabled = false;
    dom.connectWalletBtnEl.textContent = "Connect Wallet";
    setStatus(`Wallet connection failed: ${error.message}`, "err");
  }
}

function handleDisconnectWallet() {
  disconnectWallet();
  dom.walletAddressEl.textContent = "";
  dom.connectWalletBtnEl.style.display = "inline-block";
  dom.connectWalletBtnEl.disabled = false;
  dom.connectWalletBtnEl.textContent = "Connect Wallet";
  dom.disconnectWalletBtnEl.style.display = "none";
  updateTradingButtonStates();
  setStatus("Wallet disconnected from app. To fully disconnect, please disconnect from your wallet extension.", "ok");
}

async function handleBuyUp() {
  if (!isConnected() || !state.upTokenId || !state.upAsk) return;

  try {
    const size = parseFloat(dom.orderSizeEl.value) || 1;
    dom.buyUpBtnEl.disabled = true;
    setStatus("Placing buy order...", "warn");

    const result = await placeBuyOrder(state.upTokenId, state.upAsk, size);

    setStatus(`Buy order placed successfully! Order ID: ${result.orderID || 'N/A'}`, "ok");
  } catch (error) {
    console.error("Buy order failed:", error);
    setStatus(`Buy order failed: ${error.message}`, "err");
  } finally {
    dom.buyUpBtnEl.disabled = false;
  }
}

async function handleBuyDown() {
  if (!isConnected() || !state.downTokenId || !state.downAsk) return;

  try {
    const size = parseFloat(dom.orderSizeEl.value) || 1;
    dom.buyDownBtnEl.disabled = true;
    setStatus("Placing buy order...", "warn");

    const result = await placeBuyOrder(state.downTokenId, state.downAsk, size);

    setStatus(`Buy order placed successfully! Order ID: ${result.orderID || 'N/A'}`, "ok");
  } catch (error) {
    console.error("Buy order failed:", error);
    setStatus(`Buy order failed: ${error.message}`, "err");
  } finally {
    dom.buyDownBtnEl.disabled = false;
  }
}

async function handleSellUp() {
  if (!isConnected() || !state.upTokenId || !state.upBid) return;

  try {
    const size = parseFloat(dom.orderSizeEl.value) || 1;
    dom.sellUpBtnEl.disabled = true;
    setStatus("Placing sell order...", "warn");

    const result = await placeSellOrder(state.upTokenId, state.upBid, size);

    setStatus(`Sell order placed successfully! Order ID: ${result.orderID || 'N/A'}`, "ok");
  } catch (error) {
    console.error("Sell order failed:", error);
    setStatus(`Sell order failed: ${error.message}`, "err");
  } finally {
    dom.sellUpBtnEl.disabled = false;
  }
}

async function handleSellDown() {
  if (!isConnected() || !state.downTokenId || !state.downBid) return;

  try {
    const size = parseFloat(dom.orderSizeEl.value) || 1;
    dom.sellDownBtnEl.disabled = true;
    setStatus("Placing sell order...", "warn");

    const result = await placeSellOrder(state.downTokenId, state.downBid, size);

    setStatus(`Sell order placed successfully! Order ID: ${result.orderID || 'N/A'}`, "ok");
  } catch (error) {
    console.error("Sell order failed:", error);
    setStatus(`Sell order failed: ${error.message}`, "err");
  } finally {
    dom.sellDownBtnEl.disabled = false;
  }
}

function handleOrderSizeChange() {
  const value = parseFloat(dom.orderSizeEl.value);
  if (value > 0) {
    state.orderSize = value;
  }
}

(async () => {
  updateExternalLinks(`${SLUG_PREFIX}${baseTimestampNowSeconds()}`);
  try {
    initDataLogger();
    setupChart();
    updateBuyButtons();
    updateSellButtons();
    updateTradingButtonStates();

    dom.connectWalletBtnEl.addEventListener("click", handleConnectWallet);
    dom.disconnectWalletBtnEl.addEventListener("click", handleDisconnectWallet);
    dom.buyUpBtnEl.addEventListener("click", handleBuyUp);
    dom.buyDownBtnEl.addEventListener("click", handleBuyDown);
    dom.sellUpBtnEl.addEventListener("click", handleSellUp);
    dom.sellDownBtnEl.addEventListener("click", handleSellDown);
    dom.orderSizeEl.addEventListener("change", handleOrderSizeChange);

    await loadEventAndStart();
    setInterval(refreshBuyPrices, 15000);
    setInterval(maybeRollEvent, 5000);
    setInterval(updateCountdown, 1000);
  } catch (err) {
    setStatus(`Startup failed: ${err.message}`, "err");
  }
})();
