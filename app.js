import { refreshBuyPrices, updateBuyButtons, updateSellButtons } from "./js/buy-prices.js";
import {
  clearBullpenSessionKey,
  getBullpenStatus,
  getCurrentMarket,
  setBullpenSessionKey,
  startBullpenLogin
} from "./js/bullpen-api.js";
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
import { placeBuyOrder, placeSellOrder, runApprovalFlow, runPreflightCheck } from "./trading.js";

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

function resetMarketState() {
  state.targetPriceCanonical = null;
  state.targetPriceCanonicalTs = null;
  state.targetPriceCanonicalAnchorMs = null;
  state.targetPriceFallback = null;
  state.latestPrice = null;
  state.upAsk = null;
  state.downAsk = null;
  state.upBid = null;
  state.downBid = null;
  state.pricePoints = [];
}

function applyMarketSnapshot(snapshot, fallbackTargetPrice = null) {
  state.currentSlug = snapshot.slug;
  state.conditionId = snapshot.conditionId || null;
  state.upTokenId = snapshot.upTokenId || null;
  state.downTokenId = snapshot.downTokenId || null;
  state.upOutcomeLabel = snapshot.upOutcomeLabel || "Yes";
  state.downOutcomeLabel = snapshot.downOutcomeLabel || "No";
  state.currentWindowStartSec = snapshot.startSec;
  state.currentWindowEndSec = snapshot.endSec;
  state.marketSource = snapshot.source || "unknown";

  resetMarketState();

  const canonicalAnchorMs = Number.isFinite(snapshot.startSec) ? snapshot.startSec * 1000 : null;
  state.targetPriceCanonicalAnchorMs = canonicalAnchorMs;
  state.targetPriceFallback = fallbackTargetPrice;

  setDataLoggerEventContext({
    slug: snapshot.slug,
    startSec: snapshot.startSec,
    eventUuid: String(snapshot.conditionId || snapshot.slug || "n/a")
  });

  dom.eventTitleEl.textContent = String(snapshot.title || "BTC Up or Down - 5 Minutes");
  dom.eventSubEl.textContent = formatEventWindowEt(snapshot.startSec, snapshot.endSec);
  updateExternalLinks(snapshot.slug);
  dom.btcEl.textContent = `$${formatUsd(state.latestPrice)}`;
  updateBuyButtons();
  updateSellButtons();
  updateTargetDisplay();
  updateCountdown();
}

async function loadEventAndStart() {
  setStatus("Resolving current BTC 5m event...", "warn");
  let loadedFromFallback = false;
  let slugForTargetFetch = null;

  try {
    const response = await getCurrentMarket();
    const market = response.market;
    applyMarketSnapshot(market, null);
    slugForTargetFetch = market.slug;
  } catch (error) {
    loadedFromFallback = true;
    const resolved = await resolveCurrentEvent();
    const startTs = Number(resolved.slug.split("-").pop());
    const endTs = Number.isFinite(startTs) ? startTs + FIVE_MIN_SECONDS : null;
    applyMarketSnapshot({
      slug: resolved.slug,
      title: String(resolved.eventData?.title || "BTC Up or Down - 5 Minutes"),
      conditionId: resolved.market.conditionId || resolved.market.condition_id || null,
      upTokenId: resolved.upTokenId,
      downTokenId: resolved.downTokenId,
      upOutcomeLabel: "Up",
      downOutcomeLabel: "Down",
      startSec: startTs,
      endSec: endTs,
      source: "frontend-public-fallback"
    }, readTargetPrice(resolved.eventData));
    slugForTargetFetch = resolved.slug;
    setStatus(`Bullpen market lookup failed. Showing fallback event metadata: ${error.message}`, "warn");
  }

  if (slugForTargetFetch) {
    fetchTargetPriceBySlug(slugForTargetFetch).then((target) => {
      if (!Number.isFinite(target)) return;
      if (state.currentSlug !== slugForTargetFetch) return;
      state.targetPriceFallback = target;
      updateTargetDisplay();
    });
  }

  await refreshBuyPrices();
  updateTradingButtonStates();

  if (!state.ws) {
    connectBtcWebSocket();
  }

  if (!loadedFromFallback) {
    setStatus("Current market loaded through the Bullpen adapter.", "ok");
  }
}

async function maybeRollEvent() {
  const expected = `${SLUG_PREFIX}${baseTimestampNowSeconds()}`;
  if (expected !== state.currentSlug) {
    await loadEventAndStart();
  }
}

function updateTradingButtonStates() {
  const ready = Boolean(
    state.currentSlug &&
    state.bullpen.serviceOnline &&
    state.bullpen.cliInstalled &&
    state.bullpen.loggedIn &&
    state.bullpen.sessionKeyLoaded &&
    state.bullpen.preflightOk &&
    !state.tradingBusy
  );
  dom.buyUpBtnEl.disabled = !ready;
  dom.buyDownBtnEl.disabled = !ready;
  dom.sellUpBtnEl.disabled = !ready;
  dom.sellDownBtnEl.disabled = !ready;
}

function renderBullpenSession() {
  dom.bullpenStatusValueEl.textContent = state.bullpen.serviceOnline
    ? (state.bullpen.loggedIn ? "Logged In" : "Needs Login")
    : "Offline";
  dom.bullpenAddressValueEl.textContent = state.bullpen.addressMasked || "--";
  dom.bullpenApprovalsValueEl.textContent = state.bullpen.serviceOnline
    ? (state.bullpen.approvalsOk ? "Approved" : "Needs Setup")
    : "--";
  dom.bullpenPreflightValueEl.textContent = state.bullpen.serviceOnline
    ? (state.bullpen.preflightOk ? "Ready" : "Blocked")
    : "--";
  dom.bullpenSessionKeyValueEl.textContent = state.bullpen.sessionKeyLoaded
    ? `Loaded ${state.bullpen.sessionKeyFingerprint || ""}`.trim()
    : "Not loaded";
}

async function refreshBullpenSession(showFeedback = false) {
  try {
    const response = await getBullpenStatus();
    state.bullpen.serviceOnline = true;
    state.bullpen.cliInstalled = Boolean(response.cliInstalled);
    state.bullpen.loggedIn = Boolean(response.loggedIn);
    state.bullpen.address = response.address || null;
    state.bullpen.addressMasked = response.addressMasked || "";
    state.bullpen.approvalsOk = Boolean(response.approvals?.approved);
    state.bullpen.approvalsMessage = response.approvals?.message || "";
    state.bullpen.preflightOk = Boolean(response.preflight?.ok);
    state.bullpen.preflightMessage = response.preflight?.message || "";
    state.bullpen.sessionKeyLoaded = Boolean(response.sessionKeyLoaded);
    state.bullpen.sessionKeyFingerprint = response.sessionKeyFingerprint || "";
    renderBullpenSession();
    updateTradingButtonStates();
    if (showFeedback) {
      setStatus(
        response.loggedIn
          ? "Bullpen session refreshed."
          : "Bullpen reachable, but login is still required in WSL2.",
        response.loggedIn ? "ok" : "warn"
      );
    }
  } catch (error) {
    state.bullpen.serviceOnline = false;
    state.bullpen.cliInstalled = false;
    state.bullpen.loggedIn = false;
    state.bullpen.approvalsOk = false;
    state.bullpen.preflightOk = false;
    state.bullpen.sessionKeyLoaded = false;
    state.bullpen.sessionKeyFingerprint = "";
    renderBullpenSession();
    updateTradingButtonStates();
    if (showFeedback) {
      setStatus(`Bullpen service unavailable: ${error.message}`, "warn");
    }
  }
}

async function handleSaveSessionKey() {
  const privateKey = dom.sessionKeyInputEl.value.trim();
  if (!privateKey) {
    setStatus("Paste a private key before loading it into the Bullpen session.", "warn");
    return;
  }

  try {
    dom.saveSessionKeyBtnEl.disabled = true;
    setStatus("Loading session key into local backend memory...", "warn");
    await setBullpenSessionKey(privateKey);
    dom.sessionKeyInputEl.value = "";
    await refreshBullpenSession(false);
    setStatus("Session key loaded. Trading can proceed without MetaMask prompts.", "ok");
  } catch (error) {
    setStatus(`Failed to load session key: ${error.message}`, "err");
  } finally {
    dom.saveSessionKeyBtnEl.disabled = false;
  }
}

async function handleClearSessionKey() {
  try {
    dom.clearSessionKeyBtnEl.disabled = true;
    await clearBullpenSessionKey();
    await refreshBullpenSession(false);
    setStatus("Session key cleared from backend memory.", "ok");
  } catch (error) {
    setStatus(`Could not clear session key: ${error.message}`, "err");
  } finally {
    dom.clearSessionKeyBtnEl.disabled = false;
  }
}

async function handleRunPreflight() {
  try {
    dom.preflightBtnEl.disabled = true;
    setStatus("Running Bullpen preflight checks...", "warn");
    const result = await runPreflightCheck();
    await refreshBullpenSession(false);
    setStatus(result.message || "Bullpen preflight passed.", result.ok ? "ok" : "warn");
  } catch (error) {
    await refreshBullpenSession(false);
    setStatus(`Bullpen preflight failed: ${error.message}`, "err");
  } finally {
    dom.preflightBtnEl.disabled = false;
  }
}

async function handleSetApprovals() {
  try {
    dom.approveBtnEl.disabled = true;
    setStatus("Submitting Bullpen approval setup...", "warn");
    const result = await runApprovalFlow();
    await refreshBullpenSession(false);
    setStatus(result.message || "Bullpen approvals submitted.", result.ok ? "ok" : "warn");
  } catch (error) {
    await refreshBullpenSession(false);
    setStatus(`Approval setup failed: ${error.message}`, "err");
  } finally {
    dom.approveBtnEl.disabled = false;
  }
}

async function handleLoginHelp() {
  try {
    const response = await startBullpenLogin();
    window.open(response.docs, "_blank", "noopener,noreferrer");
    setStatus(`Run "${response.command}" inside WSL2, then click Refresh.`, "warn");
  } catch (error) {
    setStatus(`Could not load Bullpen login instructions: ${error.message}`, "err");
  }
}

function tradingReady() {
  return (
    state.bullpen.serviceOnline &&
    state.bullpen.cliInstalled &&
    state.bullpen.loggedIn &&
    state.bullpen.sessionKeyLoaded &&
    state.bullpen.preflightOk &&
    Boolean(state.currentSlug)
  );
}

async function handleBuyUp() {
  if (!tradingReady()) {
    setStatus("Cannot place Buy Up: Bullpen session is not ready yet.", "err");
    return;
  }
  if (!Number.isFinite(state.upAsk)) {
    setStatus("Cannot place Buy Up: Up ask price is not available yet.", "err");
    return;
  }

  try {
    const size = parseFloat(dom.orderSizeEl.value) || 1;
    if (!Number.isFinite(size) || size <= 0) {
      setStatus("Cannot place Buy Up: order size must be greater than 0.", "err");
      return;
    }
    state.tradingBusy = true;
    updateTradingButtonStates();
    setStatus("Placing Bullpen buy order for Up...", "warn");

    const result = await placeBuyOrder({
      slug: state.currentSlug,
      side: "up",
      amountUsd: size
    });

    setStatus(`Buy Up placed successfully. Order ID: ${result.orderId || "N/A"}`, "ok");
  } catch (error) {
    setStatus(`Buy order failed: ${error.message}`, "err");
  } finally {
    state.tradingBusy = false;
    updateTradingButtonStates();
  }
}

async function handleBuyDown() {
  if (!tradingReady()) {
    setStatus("Cannot place Buy Down: Bullpen session is not ready yet.", "err");
    return;
  }
  if (!Number.isFinite(state.downAsk)) {
    setStatus("Cannot place Buy Down: Down ask price is not available yet.", "err");
    return;
  }

  try {
    const size = parseFloat(dom.orderSizeEl.value) || 1;
    if (!Number.isFinite(size) || size <= 0) {
      setStatus("Cannot place Buy Down: order size must be greater than 0.", "err");
      return;
    }
    state.tradingBusy = true;
    updateTradingButtonStates();
    setStatus("Placing Bullpen buy order for Down...", "warn");

    const result = await placeBuyOrder({
      slug: state.currentSlug,
      side: "down",
      amountUsd: size
    });

    setStatus(`Buy Down placed successfully. Order ID: ${result.orderId || "N/A"}`, "ok");
  } catch (error) {
    setStatus(`Buy order failed: ${error.message}`, "err");
  } finally {
    state.tradingBusy = false;
    updateTradingButtonStates();
  }
}

async function handleSellUp() {
  if (!tradingReady()) {
    setStatus("Cannot place Sell Up: Bullpen session is not ready yet.", "err");
    return;
  }
  if (!Number.isFinite(state.upBid)) {
    setStatus("Cannot place Sell Up: Up bid price is not available yet.", "err");
    return;
  }

  try {
    const size = parseFloat(dom.orderSizeEl.value) || 1;
    if (!Number.isFinite(size) || size <= 0) {
      setStatus("Cannot place Sell Up: order size must be greater than 0.", "err");
      return;
    }
    state.tradingBusy = true;
    updateTradingButtonStates();
    setStatus("Placing Bullpen sell order for Up...", "warn");

    const result = await placeSellOrder({
      slug: state.currentSlug,
      side: "up",
      amountUsd: size
    });

    setStatus(
      `Sell Up placed successfully. Order ID: ${result.orderId || "N/A"}${result.shares ? ` | Shares: ${result.shares}` : ""}`,
      "ok"
    );
  } catch (error) {
    setStatus(`Sell order failed: ${error.message}`, "err");
  } finally {
    state.tradingBusy = false;
    updateTradingButtonStates();
  }
}

async function handleSellDown() {
  if (!tradingReady()) {
    setStatus("Cannot place Sell Down: Bullpen session is not ready yet.", "err");
    return;
  }
  if (!Number.isFinite(state.downBid)) {
    setStatus("Cannot place Sell Down: Down bid price is not available yet.", "err");
    return;
  }

  try {
    const size = parseFloat(dom.orderSizeEl.value) || 1;
    if (!Number.isFinite(size) || size <= 0) {
      setStatus("Cannot place Sell Down: order size must be greater than 0.", "err");
      return;
    }
    state.tradingBusy = true;
    updateTradingButtonStates();
    setStatus("Placing Bullpen sell order for Down...", "warn");

    const result = await placeSellOrder({
      slug: state.currentSlug,
      side: "down",
      amountUsd: size
    });

    setStatus(
      `Sell Down placed successfully. Order ID: ${result.orderId || "N/A"}${result.shares ? ` | Shares: ${result.shares}` : ""}`,
      "ok"
    );
  } catch (error) {
    setStatus(`Sell order failed: ${error.message}`, "err");
  } finally {
    state.tradingBusy = false;
    updateTradingButtonStates();
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
    renderBullpenSession();
    updateTradingButtonStates();

    dom.refreshBullpenBtnEl.addEventListener("click", () => refreshBullpenSession(true));
    dom.saveSessionKeyBtnEl.addEventListener("click", handleSaveSessionKey);
    dom.clearSessionKeyBtnEl.addEventListener("click", handleClearSessionKey);
    dom.preflightBtnEl.addEventListener("click", handleRunPreflight);
    dom.approveBtnEl.addEventListener("click", handleSetApprovals);
    dom.loginHelpBtnEl.addEventListener("click", handleLoginHelp);
    dom.buyUpBtnEl.addEventListener("click", handleBuyUp);
    dom.buyDownBtnEl.addEventListener("click", handleBuyDown);
    dom.sellUpBtnEl.addEventListener("click", handleSellUp);
    dom.sellDownBtnEl.addEventListener("click", handleSellDown);
    dom.orderSizeEl.addEventListener("change", handleOrderSizeChange);

    await refreshBullpenSession(false);
    await loadEventAndStart();
    setInterval(refreshBuyPrices, 1500);
    setInterval(() => refreshBullpenSession(false), 15000);
    setInterval(maybeRollEvent, 5000);
    setInterval(updateCountdown, 1000);
  } catch (err) {
    setStatus(`Startup failed: ${err.message}`, "err");
  }
})();
