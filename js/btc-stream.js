import { POLYMARKET_RTDS_WS } from "./constants.js";
import { addPricePoint } from "./chart.js";
import { state } from "./state.js";
import { setStatus } from "./status.js";

export function connectBtcWebSocket() {
  if (state.ws) state.ws.close();
  if (state.wsPingIntervalId) {
    clearInterval(state.wsPingIntervalId);
    state.wsPingIntervalId = null;
  }

  const ws = new WebSocket(POLYMARKET_RTDS_WS);
  state.ws = ws;

  ws.onopen = () => {
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
      if (ws.readyState === WebSocket.OPEN) ws.send("PING");
    }, 5000);
    setStatus("Connected. Streaming BTC/USD from Polymarket RTDS.", "ok");
  };

  ws.onmessage = (evt) => {
    if (ws !== state.ws) return;
    if (typeof evt.data !== "string" || evt.data === "PING" || evt.data === "PONG") return;

    try {
      const data = JSON.parse(evt.data);
      const topic = String(data.topic || "").toLowerCase();
      const symbol = String(data.payload?.symbol || "").toLowerCase();
      const isChainlinkUpdate = topic === "crypto_prices_chainlink" && symbol === "btc/usd";
      const isChainlinkSnapshot = topic === "crypto_prices" && symbol === "btc/usd";
      if (!isChainlinkUpdate && !isChainlinkSnapshot) return;

      const px = Number(data.payload?.value);
      const ts = Number(data.payload?.timestamp || Date.now());
      if (Number.isFinite(px)) {
        addPricePoint(ts, px);
        return;
      }

      const snapshot = Array.isArray(data.payload?.data) ? data.payload.data : [];
      if (snapshot.length) {
        snapshot.forEach((pt) => {
          const p = Number(pt?.value);
          const t = Number(pt?.timestamp);
          if (Number.isFinite(p)) addPricePoint(t, p);
        });
      }
    } catch {
    }
  };

  ws.onerror = () => {
    if (ws !== state.ws) return;
    setStatus("Polymarket BTC websocket error. Reconnecting...", "warn");
  };

  ws.onclose = () => {
    if (ws !== state.ws) return;
    if (state.wsPingIntervalId) {
      clearInterval(state.wsPingIntervalId);
      state.wsPingIntervalId = null;
    }
    setStatus("Polymarket BTC websocket closed. Reconnecting...", "warn");
    setTimeout(connectBtcWebSocket, 1200);
  };
}
