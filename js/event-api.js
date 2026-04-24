import { state } from "./state.js";
import { candidateSlugs } from "./time.js";

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
  if (Array.isArray(data?.events) && data.events.length) return data.events[0];
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

export async function fetchTargetPriceBySlug(slug) {
  const encoded = encodeURIComponent(slug);
  const urls = [
    `https://r.jina.ai/http://polymarket.com/event/${encoded}`,
    `https://r.jina.ai/http://gamma-api.polymarket.com/events/keyset?slug=${encoded}`,
    `https://r.jina.ai/http://gamma-api.polymarket.com/events?slug=${encoded}`
  ];

  for (const url of urls) {
    try {
      if (url.includes("polymarket.com/event/")) {
        const resp = await fetch(url, { cache: "no-store" });
        if (!resp.ok) continue;
        const text = await resp.text();
        const textMatch = text.match(/Price To Beat[\s\S]{0,120}?\$([0-9][0-9,]*\.[0-9]+)/i);
        if (textMatch && textMatch[1]) {
          const n = Number(textMatch[1].replace(/,/g, ""));
          if (Number.isFinite(n)) return n;
        }
      } else {
        const raw = await fetchJson(url, true);
        const event = unwrapGammaEvent(raw);
        const target = readTargetPrice(event);
        if (Number.isFinite(target)) return target;
      }
    } catch {
    }
  }

  return null;
}

export function readTargetPrice(eventData) {
  const candidates = [
    eventData?.eventMetadata?.priceToBeat,
    eventData?.eventMetadata?.price_to_beat,
    eventData?.event_metadata?.priceToBeat,
    eventData?.event_metadata?.price_to_beat,
    eventData?.markets?.[0]?.priceToBeat,
    eventData?.markets?.[0]?.price_to_beat
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

export async function resolveCurrentEvent() {
  const slugs = candidateSlugs();
  const found = [];

  for (const slug of slugs) {
    try {
      const eventData = await fetchGammaEventBySlug(slug);
      if (!eventData || !eventData.markets || !eventData.markets.length) continue;
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
