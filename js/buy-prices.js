import { POLYMARKET_CLOB_MARKET_WS } from "./constants.js";
import { logPriceTick } from "./data-logger.js";
import { dom } from "./dom.js";
import { formatShareLabel } from "./formatters.js";
import { state } from "./state.js";
import { setStatus } from "./status.js";

export function updateBuyButtons() {
  dom.buyUpBtnEl.textContent = `Buy Up ${formatShareLabel(state.upAsk)}`;
  dom.buyDownBtnEl.textContent = `Buy Down ${formatShareLabel(state.downAsk)}`;
}

export function updateSellButtons() {
  dom.sellUpBtnEl.textContent = `Sell Up ${formatShareLabel(state.upBid)}`;
  dom.sellDownBtnEl.textContent = `Sell Down ${formatShareLabel(state.downBid)}`;
}

async function fetchBestAsk(tokenId) {
  const resp = await fetch(`https://clob.polymarket.com/book?token_id=${encodeURIComponent(tokenId)}`, { cache: "no-store" });
  if (!resp.ok) throw new Error("Failed to fetch orderbook");
  const data = await resp.json();
  const asks = Array.isArray(data.asks) ? data.asks : [];
  if (!asks.length) return null;

  let bestAsk = Number.POSITIVE_INFINITY;
  asks.forEach((a) => {
    const p = Number(a.price);
    if (Number.isFinite(p) && p < bestAsk) bestAsk = p;
  });

  return Number.isFinite(bestAsk) ? bestAsk : null;
}

async function fetchBestBid(tokenId) {
  const resp = await fetch(`https://clob.polymarket.com/book?token_id=${encodeURIComponent(tokenId)}`, { cache: "no-store" });
  if (!resp.ok) throw new Error("Failed to fetch orderbook");
  const data = await resp.json();
  const bids = Array.isArray(data.bids) ? data.bids : [];
  if (!bids.length) return null;

  let bestBid = Number.NEGATIVE_INFINITY;
  bids.forEach((b) => {
    const p = Number(b.price);
    if (Number.isFinite(p) && p > bestBid) bestBid = p;
  });

  return Number.isFinite(bestBid) && bestBid > Number.NEGATIVE_INFINITY ? bestBid : null;
}

export async function refreshBuyPrices() {
  if (!state.upTokenId || !state.downTokenId) return;
  try {
    const [upAsk, downAsk, upBid, downBid] = await Promise.all([
      fetchBestAsk(state.upTokenId),
      fetchBestAsk(state.downTokenId),
      fetchBestBid(state.upTokenId),
      fetchBestBid(state.downTokenId)
    ]);
    state.upAsk = upAsk;
    state.downAsk = downAsk;
    state.upBid = upBid;
    state.downBid = downBid;
    updateBuyButtons();
    updateSellButtons();
    logPriceTick("buy_up", upAsk);
    logPriceTick("buy_down", downAsk);
    logPriceTick("sell_up", upBid);
    logPriceTick("sell_down", downBid);
  } catch (err) {
    setStatus(`Price update failed: ${err.message}`, "warn");
  }
}

function bestAskFromBookMessage(data) {
  const asks = Array.isArray(data?.asks) ? data.asks : [];
  if (!asks.length) return null;
  let bestAsk = Number.POSITIVE_INFINITY;
  asks.forEach((a) => {
    const p = Number(a?.price);
    if (Number.isFinite(p) && p < bestAsk) bestAsk = p;
  });
  return Number.isFinite(bestAsk) ? bestAsk : null;
}

function bestBidFromBookMessage(data) {
  const bids = Array.isArray(data?.bids) ? data.bids : [];
  if (!bids.length) return null;
  let bestBid = Number.NEGATIVE_INFINITY;
  bids.forEach((b) => {
    const p = Number(b?.price);
    if (Number.isFinite(p) && p > bestBid) bestBid = p;
  });
  return Number.isFinite(bestBid) && bestBid > Number.NEGATIVE_INFINITY ? bestBid : null;
}

function applyBestAsk(assetId, bestAsk) {
  if (!assetId || !Number.isFinite(bestAsk)) return;
  if (String(assetId) === String(state.upTokenId)) {
    state.upAsk = bestAsk;
    updateBuyButtons();
    logPriceTick("buy_up", bestAsk);
    return;
  }
  if (String(assetId) === String(state.downTokenId)) {
    state.downAsk = bestAsk;
    updateBuyButtons();
    logPriceTick("buy_down", bestAsk);
  }
}

function applyBestBid(assetId, bestBid) {
  if (!assetId || !Number.isFinite(bestBid)) return;
  if (String(assetId) === String(state.upTokenId)) {
    state.upBid = bestBid;
    updateSellButtons();
    logPriceTick("sell_up", bestBid);
    return;
  }
  if (String(assetId) === String(state.downTokenId)) {
    state.downBid = bestBid;
    updateSellButtons();
    logPriceTick("sell_down", bestBid);
  }
}

function handleMarketWsMessage(data) {
  if (!data || typeof data !== "object") return;
  const eventType = String(data.event_type || "").toLowerCase();
  const assetId = data.asset_id;

  if (eventType === "best_bid_ask") {
    const bestAsk = Number(data.best_ask);
    const bestBid = Number(data.best_bid);
    applyBestAsk(assetId, bestAsk);
    applyBestBid(assetId, bestBid);
    return;
  }

  if (eventType === "book") {
    const bestAsk = bestAskFromBookMessage(data);
    const bestBid = bestBidFromBookMessage(data);
    applyBestAsk(assetId, bestAsk);
    applyBestBid(assetId, bestBid);
    return;
  }

  if (eventType === "price_change") {
    const topLevelBestAsk = Number(data.best_ask);
    const topLevelBestBid = Number(data.best_bid);
    if (Number.isFinite(topLevelBestAsk)) {
      applyBestAsk(assetId, topLevelBestAsk);
    }
    if (Number.isFinite(topLevelBestBid)) {
      applyBestBid(assetId, topLevelBestBid);
    }
    const changes = Array.isArray(data.price_changes) ? data.price_changes : [];
    changes.forEach((chg) => {
      const bestAsk = Number(chg?.best_ask);
      const bestBid = Number(chg?.best_bid);
      applyBestAsk(assetId, bestAsk);
      applyBestBid(assetId, bestBid);
    });
  }
}

function teardownBuyPriceWebSocket() {
  if (state.marketWsReconnectTimeoutId) {
    clearTimeout(state.marketWsReconnectTimeoutId);
    state.marketWsReconnectTimeoutId = null;
  }
  if (state.marketWsPingIntervalId) {
    clearInterval(state.marketWsPingIntervalId);
    state.marketWsPingIntervalId = null;
  }
  if (state.marketWs) {
    state.marketWs.close();
    state.marketWs = null;
  }
}

export function connectBuyPriceWebSocket() {
  if (!state.upTokenId || !state.downTokenId) return;
  teardownBuyPriceWebSocket();

  const ws = new WebSocket(POLYMARKET_CLOB_MARKET_WS);
  state.marketWs = ws;

  ws.onopen = () => {
    if (ws !== state.marketWs) return;
    ws.send(JSON.stringify({
      type: "market",
      assets_ids: [String(state.upTokenId), String(state.downTokenId)],
      custom_feature_enabled: true
    }));

    state.marketWsPingIntervalId = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send("PING");
    }, 10000);
  };

  ws.onmessage = (evt) => {
    if (ws !== state.marketWs) return;
    if (typeof evt.data !== "string" || evt.data === "PING" || evt.data === "PONG") return;
    try {
      const parsed = JSON.parse(evt.data);
      if (Array.isArray(parsed)) {
        parsed.forEach(handleMarketWsMessage);
        return;
      }
      handleMarketWsMessage(parsed);
    } catch {
    }
  };

  ws.onerror = () => {
    if (ws !== state.marketWs) return;
    setStatus("Buy price websocket error. Reconnecting...", "warn");
  };

  ws.onclose = () => {
    if (ws !== state.marketWs) return;
    if (state.marketWsPingIntervalId) {
      clearInterval(state.marketWsPingIntervalId);
      state.marketWsPingIntervalId = null;
    }
    setStatus("Buy price websocket closed. Reconnecting...", "warn");
    state.marketWsReconnectTimeoutId = setTimeout(() => {
      connectBuyPriceWebSocket();
    }, 1200);
  };
}
