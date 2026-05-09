async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    ...options
  });

  const text = await response.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(text);
    }
  }

  if (!response.ok) {
    throw new Error(data.message || data.error || `Request failed: ${response.status}`);
  }

  return data;
}

export function getBullpenStatus() {
  return requestJson("/api/bullpen/status");
}

export function startBullpenLogin() {
  return requestJson("/api/bullpen/login/start", {
    method: "POST",
    body: JSON.stringify({})
  });
}

export function setBullpenSessionKey(privateKey) {
  return requestJson("/api/bullpen/session-key", {
    method: "POST",
    body: JSON.stringify({ privateKey })
  });
}

export function clearBullpenSessionKey() {
  return requestJson("/api/bullpen/session-key", {
    method: "DELETE"
  });
}

export function getCurrentMarket() {
  return requestJson("/api/markets/current");
}

export function getCurrentMarketPrice(slug) {
  const query = slug ? `?slug=${encodeURIComponent(slug)}` : "";
  return requestJson(`/api/markets/current/price${query}`);
}

export function getPositions() {
  return requestJson("/api/positions");
}

export function runBullpenPreflight() {
  return requestJson("/api/orders/preflight", {
    method: "POST",
    body: JSON.stringify({})
  });
}

export function runBullpenApprove() {
  return requestJson("/api/orders/approve", {
    method: "POST",
    body: JSON.stringify({})
  });
}

export function submitBuyOrder({ slug, side, amountUsd }) {
  return requestJson("/api/orders/buy", {
    method: "POST",
    body: JSON.stringify({ slug, side, amountUsd })
  });
}

export function submitSellOrder({ slug, side, amountUsd }) {
  return requestJson("/api/orders/sell", {
    method: "POST",
    body: JSON.stringify({ slug, side, amountUsd })
  });
}
