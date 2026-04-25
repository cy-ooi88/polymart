#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const FIVE_MIN_SECONDS = 300;
const SLUG_PREFIX = "btc-updown-5m-";
const POLYMARKET_RTDS_WS = "wss://ws-live-data.polymarket.com";
const POLYMARKET_CLOB_MARKET_WS = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const EVENT_FALLBACK_WAIT_MS = 60_000;
const NA = "n/a";

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

const state = {
  currentSlug: null,
  upTokenId: null,
  downTokenId: null,
  targetPriceCanonical: null,
  targetPriceFallback: null,
  targetPriceCanonicalTs: null,
  targetPriceCanonicalAnchorMs: null,
  latestPrice: null,
  upAsk: null,
  downAsk: null,
  currentWindowStartSec: null,
  currentWindowEndSec: null,
  ws: null,
  wsPingIntervalId: null,
  wsReconnectTimeoutId: null,
  marketWs: null,
  marketWsPingIntervalId: null,
  marketWsReconnectTimeoutId: null,
  eventCache: new Map()
};

const loggerState = {
  enabled: true,
  pendingEventTimeoutId: null,
  currentEvent: null,
  loggedEventSlugs: new Set(),
  lastWrittenPriceRowKey: null,
  lastTicks: {
    current_price: null,
    buy_up: null,
    buy_down: null
  }
};

function getWebSocketCtor() {
  if (typeof WebSocket !== "undefined") return WebSocket;
  try {
    return require("ws");
  } catch {
    throw new Error('No WebSocket implementation found. Install "ws" (npm i ws) or run on a Node version with global WebSocket.');
  }
}

const WebSocketCtor = getWebSocketCtor();

function createTimestampLabel(d = new Date()) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${yyyy}${mm}${dd}_${hh}${mi}${ss}`;
}

function toIsoTimestamp(ms) {
  return new Date(ms).toISOString();
}

function formatMaybeNumber(value) {
  return Number.isFinite(value) ? String(value) : NA;
}

function toCsvCell(value) {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (!/[",\r\n]/.test(s)) return s;
  return `"${s.replace(/"/g, "\"\"")}"`;
}

function createCsvLogger(filePath, headers) {
  const stream = fs.createWriteStream(filePath, { encoding: "utf8", flags: "w" });
  stream.write(`${headers.join(",")}\n`);

  return {
    filePath,
    writeRow(row) {
      const line = headers.map((h) => toCsvCell(row[h])).join(",");
      stream.write(`${line}\n`);
    },
    close() {
      return new Promise((resolve) => {
        stream.end(resolve);
      });
    }
  };
}

function baseTimestampNowSeconds() {
  return Math.floor(Date.now() / 1000 / FIVE_MIN_SECONDS) * FIVE_MIN_SECONDS;
}

function candidateSlugs() {
  const base = baseTimestampNowSeconds();
  const offsets = [0, -FIVE_MIN_SECONDS, FIVE_MIN_SECONDS];
  return offsets.map((offset) => `${SLUG_PREFIX}${base + offset}`);
}

function parseMaybeArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function extractJsonFromJinaText(text) {
  const marker = "Markdown Content:";
  const idx = text.indexOf(marker);
  let payload = idx >= 0 ? text.slice(idx + marker.length).trim() : text.trim();
  if (payload.startsWith("```")) {
    payload = payload.replace(/^```[a-zA-Z]*\s*/, "").replace(/\s*```$/, "");
  }
  return JSON.parse(payload);
}

function unwrapGammaEvent(data) {
  if (Array.isArray(data) && data.length) return data[0];
  if (Array.isArray(data && data.events) && data.events.length) return data.events[0];
  if (data && typeof data === "object" && data.slug) return data;
  return null;
}

async function fetchJson(url, isJinaProxy = false) {
  const resp = await fetch(url, { cache: "no-store" });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  if (isJinaProxy) {
    const text = await resp.text();
    return extractJsonFromJinaText(text);
  }
  return resp.json();
}

async function fetchGammaEventBySlug(slug) {
  const cached = state.eventCache.get(slug);
  if (cached && Date.now() - cached.at < 20_000) return cached.data;

  const encoded = encodeURIComponent(slug);
  const urls = [
    { url: `https://r.jina.ai/http://gamma-api.polymarket.com/events/keyset?slug=${encoded}`, jina: true },
    { url: `https://r.jina.ai/http://gamma-api.polymarket.com/events?slug=${encoded}`, jina: true }
  ];

  let lastError = null;
  for (const entry of urls) {
    try {
      const raw = await fetchJson(entry.url, entry.jina);
      const event = unwrapGammaEvent(raw);
      if (event) {
        state.eventCache.set(slug, { at: Date.now(), data: event });
        return event;
      }
    } catch (err) {
      lastError = err;
    }
  }

  if (lastError) throw lastError;
  throw new Error(`Gamma fetch failed for ${slug}`);
}

function readTargetPrice(eventData) {
  const candidates = [
    eventData && eventData.eventMetadata && eventData.eventMetadata.priceToBeat,
    eventData && eventData.eventMetadata && eventData.eventMetadata.price_to_beat,
    eventData && eventData.event_metadata && eventData.event_metadata.priceToBeat,
    eventData && eventData.event_metadata && eventData.event_metadata.price_to_beat,
    eventData && eventData.markets && eventData.markets[0] && eventData.markets[0].priceToBeat,
    eventData && eventData.markets && eventData.markets[0] && eventData.markets[0].price_to_beat
  ];

  for (const candidate of candidates) {
    const n = Number(candidate);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function findUpDownTokens(market) {
  const outcomes = parseMaybeArray(market.outcomes);
  const tokenIds = parseMaybeArray(market.clobTokenIds);
  let upTokenId = null;
  let downTokenId = null;

  outcomes.forEach((outcome, i) => {
    const label = String(outcome).trim().toLowerCase();
    if (label === "up") upTokenId = tokenIds[i] || null;
    if (label === "down") downTokenId = tokenIds[i] || null;
  });

  return { upTokenId, downTokenId };
}

async function resolveCurrentEvent() {
  const slugs = candidateSlugs();
  const found = [];

  for (const slug of slugs) {
    try {
      const eventData = await fetchGammaEventBySlug(slug);
      if (!eventData || !Array.isArray(eventData.markets) || !eventData.markets.length) continue;
      const market = eventData.markets[0];
      const { upTokenId, downTokenId } = findUpDownTokens(market);
      if (upTokenId && downTokenId) {
        found.push({ slug, eventData, market, upTokenId, downTokenId });
      }
    } catch {
    }
  }

  if (!found.length) throw new Error("Could not resolve the current BTC 5m event");
  const openCandidate = found.find((x) => x.market.acceptingOrders || (!x.market.closed && x.market.active));
  return openCandidate || found[0];
}

function resolveEventUuid(resolved) {
  const eventUuid = (resolved && resolved.eventData && resolved.eventData.id)
    || (resolved && resolved.market && resolved.market.id)
    || (resolved && resolved.slug);
  return String(eventUuid || NA);
}

function wsIsOpen(ws) {
  const OPEN = typeof WebSocketCtor.OPEN === "number" ? WebSocketCtor.OPEN : 1;
  return ws && ws.readyState === OPEN;
}

function bindWsHandlers(ws, handlers) {
  if (typeof ws.on === "function") {
    if (handlers.open) ws.on("open", handlers.open);
    if (handlers.message) {
      ws.on("message", (data) => {
        if (typeof data === "string") handlers.message(data);
        else handlers.message(Buffer.isBuffer(data) ? data.toString("utf8") : String(data));
      });
    }
    if (handlers.error) ws.on("error", handlers.error);
    if (handlers.close) ws.on("close", handlers.close);
    return;
  }

  ws.onopen = handlers.open || null;
  ws.onmessage = handlers.message
    ? (evt) => handlers.message(evt && evt.data)
    : null;
  ws.onerror = handlers.error || null;
  ws.onclose = handlers.close || null;
}

function clearPendingEventTimer() {
  if (!loggerState.pendingEventTimeoutId) return;
  clearTimeout(loggerState.pendingEventTimeoutId);
  loggerState.pendingEventTimeoutId = null;
}

function primeTickCarryForwardState() {
  if (Number.isFinite(state.latestPrice)) loggerState.lastTicks.current_price = state.latestPrice;
  if (Number.isFinite(state.upAsk)) loggerState.lastTicks.buy_up = state.upAsk;
  if (Number.isFinite(state.downAsk)) loggerState.lastTicks.buy_down = state.downAsk;
}

function emitEventRowIfDue(eventSlug) {
  loggerState.pendingEventTimeoutId = null;
  if (!loggerState.enabled) return;

  const event = loggerState.currentEvent;
  if (!event || event.slug !== eventSlug) return;
  if (loggerState.loggedEventSlugs.has(eventSlug)) return;

  eventCsv.writeRow({
    event_slug: event.slug,
    event_timestamp: toIsoTimestamp(event.startSec * 1000),
    price_to_beat_canonical: formatMaybeNumber(state.targetPriceCanonical),
    price_to_beat_fallback: formatMaybeNumber(state.targetPriceFallback),
    event_uuid: event.eventUuid
  });
  loggerState.loggedEventSlugs.add(eventSlug);
  console.log(`[event] logged ${event.slug}`);
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

function setDataLoggerEventContext({ slug, startSec, eventUuid }) {
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

function logPriceTick(kind, value, timestampMs = Date.now()) {
  if (!loggerState.enabled || !loggerState.currentEvent) return;
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return;
  if (!Object.prototype.hasOwnProperty.call(loggerState.lastTicks, kind)) return;

  const prevValue = loggerState.lastTicks[kind];
  if (Number.isFinite(prevValue) && prevValue === numericValue) return;

  loggerState.lastTicks[kind] = numericValue;
  const row = {
    event_uuid: loggerState.currentEvent.eventUuid,
    timestamp: toIsoTimestamp(timestampMs),
    current_price: formatMaybeNumber(loggerState.lastTicks.current_price),
    buy_up: formatMaybeNumber(loggerState.lastTicks.buy_up),
    buy_down: formatMaybeNumber(loggerState.lastTicks.buy_down)
  };

  const rowKey = `${row.event_uuid}|${row.timestamp}|${row.current_price}|${row.buy_up}|${row.buy_down}`;
  if (rowKey === loggerState.lastWrittenPriceRowKey) return;

  priceCsv.writeRow(row);
  loggerState.lastWrittenPriceRowKey = rowKey;
}

function maybeSetCanonicalTarget(timestampMs, price) {
  if (!Number.isFinite(state.targetPriceCanonicalAnchorMs)) return false;
  const t = Number(timestampMs);
  const p = Number(price);
  if (!Number.isFinite(t) || !Number.isFinite(p)) return false;

  if (t < state.targetPriceCanonicalAnchorMs) return false;
  const shouldReplace = !Number.isFinite(state.targetPriceCanonicalTs) || t < state.targetPriceCanonicalTs;
  if (!shouldReplace) return false;

  state.targetPriceCanonical = p;
  state.targetPriceCanonicalTs = t;
  return true;
}

function addPricePoint(timestampMs, price) {
  const rawT = Number.isFinite(timestampMs) ? timestampMs : Date.now();
  const t = rawT < 1e12 ? rawT * 1000 : rawT;
  const p = Number(price);
  if (!Number.isFinite(t) || !Number.isFinite(p)) return;

  state.latestPrice = p;
  logPriceTick("current_price", p, t);
  maybeSetCanonicalTarget(t, p);
}

async function fetchBestAsk(tokenId) {
  const resp = await fetch(`https://clob.polymarket.com/book?token_id=${encodeURIComponent(tokenId)}`, { cache: "no-store" });
  if (!resp.ok) throw new Error(`Failed to fetch orderbook: HTTP ${resp.status}`);

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

async function refreshBuyPrices() {
  if (!state.upTokenId || !state.downTokenId) return;

  try {
    const prevUp = state.upAsk;
    const prevDown = state.downAsk;
    const [upAsk, downAsk] = await Promise.all([
      fetchBestAsk(state.upTokenId),
      fetchBestAsk(state.downTokenId)
    ]);
    state.upAsk = upAsk;
    state.downAsk = downAsk;
    if (Number.isFinite(upAsk) && upAsk !== prevUp) logPriceTick("buy_up", upAsk);
    if (Number.isFinite(downAsk) && downAsk !== prevDown) logPriceTick("buy_down", downAsk);
  } catch (err) {
    console.warn(`[warn] price update failed: ${err.message}`);
  }
}

function bestAskFromBookMessage(data) {
  const asks = Array.isArray(data && data.asks) ? data.asks : [];
  if (!asks.length) return null;

  let bestAsk = Number.POSITIVE_INFINITY;
  asks.forEach((a) => {
    const p = Number(a && a.price);
    if (Number.isFinite(p) && p < bestAsk) bestAsk = p;
  });

  return Number.isFinite(bestAsk) ? bestAsk : null;
}

function applyBestAsk(assetId, bestAsk) {
  if (!assetId || !Number.isFinite(bestAsk)) return;

  if (String(assetId) === String(state.upTokenId)) {
    if (state.upAsk === bestAsk) return;
    state.upAsk = bestAsk;
    logPriceTick("buy_up", bestAsk);
    return;
  }

  if (String(assetId) === String(state.downTokenId)) {
    if (state.downAsk === bestAsk) return;
    state.downAsk = bestAsk;
    logPriceTick("buy_down", bestAsk);
  }
}

function handleMarketWsMessage(data) {
  if (!data || typeof data !== "object") return;

  const eventType = String(data.event_type || "").toLowerCase();
  const assetId = data.asset_id;

  if (eventType === "best_bid_ask") {
    const bestAsk = Number(data.best_ask);
    applyBestAsk(assetId, bestAsk);
    return;
  }

  if (eventType === "book") {
    const bestAsk = bestAskFromBookMessage(data);
    applyBestAsk(assetId, bestAsk);
    return;
  }

  if (eventType === "price_change") {
    const topLevelBestAsk = Number(data.best_ask);
    if (Number.isFinite(topLevelBestAsk)) {
      applyBestAsk(assetId, topLevelBestAsk);
      return;
    }

    const changes = Array.isArray(data.price_changes) ? data.price_changes : [];
    changes.forEach((chg) => {
      const bestAsk = Number(chg && chg.best_ask);
      applyBestAsk(assetId, bestAsk);
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

function connectBuyPriceWebSocket() {
  if (!state.upTokenId || !state.downTokenId) return;
  teardownBuyPriceWebSocket();

  const ws = new WebSocketCtor(POLYMARKET_CLOB_MARKET_WS);
  state.marketWs = ws;

  bindWsHandlers(ws, {
    open: () => {
      if (ws !== state.marketWs) return;
      ws.send(JSON.stringify({
        type: "market",
        assets_ids: [String(state.upTokenId), String(state.downTokenId)],
        custom_feature_enabled: true
      }));

      state.marketWsPingIntervalId = setInterval(() => {
        if (wsIsOpen(ws)) ws.send("PING");
      }, 10_000);
    },
    message: (raw) => {
      if (ws !== state.marketWs) return;
      if (typeof raw !== "string" || raw === "PING" || raw === "PONG") return;

      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          parsed.forEach(handleMarketWsMessage);
          return;
        }
        handleMarketWsMessage(parsed);
      } catch {
      }
    },
    error: () => {
      if (ws !== state.marketWs) return;
      console.warn("[warn] Buy price websocket error. Reconnecting...");
    },
    close: () => {
      if (ws !== state.marketWs) return;
      if (state.marketWsPingIntervalId) {
        clearInterval(state.marketWsPingIntervalId);
        state.marketWsPingIntervalId = null;
      }
      console.warn("[warn] Buy price websocket closed. Reconnecting...");
      state.marketWsReconnectTimeoutId = setTimeout(() => {
        connectBuyPriceWebSocket();
      }, 1200);
    }
  });
}

function teardownBtcWebSocket() {
  if (state.wsReconnectTimeoutId) {
    clearTimeout(state.wsReconnectTimeoutId);
    state.wsReconnectTimeoutId = null;
  }
  if (state.wsPingIntervalId) {
    clearInterval(state.wsPingIntervalId);
    state.wsPingIntervalId = null;
  }
  if (state.ws) {
    state.ws.close();
    state.ws = null;
  }
}

function connectBtcWebSocket() {
  teardownBtcWebSocket();

  const ws = new WebSocketCtor(POLYMARKET_RTDS_WS);
  state.ws = ws;

  bindWsHandlers(ws, {
    open: () => {
      if (ws !== state.ws) return;

      ws.send(JSON.stringify({
        action: "subscribe",
        subscriptions: [
          {
            topic: "crypto_prices_chainlink",
            type: "*",
            filters: JSON.stringify({ symbol: "btc/usd" })
          },
          {
            topic: "crypto_prices",
            type: "*",
            filters: JSON.stringify({ symbol: "btc/usd" })
          }
        ]
      }));

      state.wsPingIntervalId = setInterval(() => {
        if (wsIsOpen(ws)) ws.send("PING");
      }, 5000);

      console.log("[ok] Connected BTC stream websocket");
    },
    message: (raw) => {
      if (ws !== state.ws) return;
      if (typeof raw !== "string" || raw === "PING" || raw === "PONG") return;

      try {
        const data = JSON.parse(raw);
        const topic = String(data.topic || "").toLowerCase();
        const symbol = String(data && data.payload && data.payload.symbol || "").toLowerCase();
        const isChainlinkUpdate = topic === "crypto_prices_chainlink" && symbol === "btc/usd";
        const isChainlinkSnapshot = topic === "crypto_prices" && symbol === "btc/usd";
        if (!isChainlinkUpdate && !isChainlinkSnapshot) return;

        const px = Number(data && data.payload && data.payload.value);
        const ts = Number((data && data.payload && data.payload.timestamp) || Date.now());
        if (Number.isFinite(px)) {
          addPricePoint(ts, px);
          return;
        }

        const snapshot = Array.isArray(data && data.payload && data.payload.data)
          ? data.payload.data
          : [];

        snapshot.forEach((pt) => {
          const p = Number(pt && pt.value);
          const t = Number(pt && pt.timestamp);
          if (Number.isFinite(p)) addPricePoint(t, p);
        });
      } catch {
      }
    },
    error: () => {
      if (ws !== state.ws) return;
      console.warn("[warn] Polymarket BTC websocket error. Reconnecting...");
    },
    close: () => {
      if (ws !== state.ws) return;
      if (state.wsPingIntervalId) {
        clearInterval(state.wsPingIntervalId);
        state.wsPingIntervalId = null;
      }
      console.warn("[warn] Polymarket BTC websocket closed. Reconnecting...");
      state.wsReconnectTimeoutId = setTimeout(() => {
        connectBtcWebSocket();
      }, 1200);
    }
  });
}

async function loadEventAndStart() {
  console.log("[info] Resolving current BTC 5m event...");
  const resolved = await resolveCurrentEvent();

  state.currentSlug = resolved.slug;
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

  setDataLoggerEventContext({
    slug: resolved.slug,
    startSec: startTs,
    eventUuid
  });

  console.log(`[info] Active event: ${resolved.slug}`);

  await refreshBuyPrices();
  connectBuyPriceWebSocket();
  connectBtcWebSocket();
}

async function maybeRollEvent() {
  const expected = `${SLUG_PREFIX}${baseTimestampNowSeconds()}`;
  if (expected !== state.currentSlug) {
    console.log(`[info] Rolling to new event slug ${expected}`);
    await loadEventAndStart();
  }
}

function shutdownTimersAndSockets() {
  clearPendingEventTimer();

  teardownBtcWebSocket();
  teardownBuyPriceWebSocket();

  if (intervalIds.refreshBuy) clearInterval(intervalIds.refreshBuy);
  if (intervalIds.rollEvent) clearInterval(intervalIds.rollEvent);

  intervalIds.refreshBuy = null;
  intervalIds.rollEvent = null;
}

const intervalIds = {
  refreshBuy: null,
  rollEvent: null
};

const runLabel = createTimestampLabel();
const outputDir = __dirname;
const eventsFilePath = path.join(outputDir, `events_${runLabel}.csv`);
const priceDataFilePath = path.join(outputDir, `price_data_${runLabel}.csv`);

const eventCsv = createCsvLogger(eventsFilePath, EVENT_HEADERS);
const priceCsv = createCsvLogger(priceDataFilePath, PRICE_HEADERS);

let shuttingDown = false;

async function gracefulShutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`\n[info] Shutting down (${reason})...`);
  shutdownTimersAndSockets();

  await Promise.all([
    eventCsv.close(),
    priceCsv.close()
  ]);

  console.log(`[done] Event log: ${eventsFilePath}`);
  console.log(`[done] Price log: ${priceDataFilePath}`);

  process.exit(0);
}

process.on("SIGINT", () => {
  gracefulShutdown("SIGINT");
});

process.on("SIGTERM", () => {
  gracefulShutdown("SIGTERM");
});

process.on("uncaughtException", async (err) => {
  console.error(`[error] Uncaught exception: ${err && err.stack ? err.stack : err}`);
  await gracefulShutdown("uncaughtException");
});

process.on("unhandledRejection", async (reason) => {
  console.error(`[error] Unhandled rejection: ${reason}`);
  await gracefulShutdown("unhandledRejection");
});

(async () => {
  try {
    console.log(`[start] Event CSV -> ${eventsFilePath}`);
    console.log(`[start] Price CSV -> ${priceDataFilePath}`);

    await loadEventAndStart();

    intervalIds.refreshBuy = setInterval(() => {
      refreshBuyPrices();
    }, 15_000);

    intervalIds.rollEvent = setInterval(() => {
      maybeRollEvent().catch((err) => {
        console.warn(`[warn] Event roll check failed: ${err.message}`);
      });
    }, 5000);
  } catch (err) {
    console.error(`[error] Startup failed: ${err.message}`);
    await gracefulShutdown("startup-failure");
  }
})();
