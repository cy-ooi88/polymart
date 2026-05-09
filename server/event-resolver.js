"use strict";

const FIVE_MIN_SECONDS = 300;
const SLUG_PREFIX = "btc-updown-5m-";

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

function titleFromSlug(slug) {
  return String(slug || "btc-updown-5m")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function toNumericTimestampFromSlug(slug) {
  const tail = String(slug || "").split("-").pop();
  const numeric = Number(tail);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeOutcomeName(name) {
  return String(name || "").trim().toLowerCase();
}

function findOutcomeEntry(entries, acceptedNames) {
  return entries.find((entry) => acceptedNames.includes(normalizeOutcomeName(entry.name)));
}

function normalizeBullpenMarket(raw, slugHint = "") {
  const root = raw?.market || raw?.event || raw?.data || raw;
  if (!root || typeof root !== "object") return null;

  const slug = String(root.slug || raw?.slug || slugHint || "");
  if (!slug) return null;

  const startSec = toNumericTimestampFromSlug(slug);
  const endSec = Number.isFinite(startSec) ? startSec + FIVE_MIN_SECONDS : null;
  const outcomes = Array.isArray(root.outcomes)
    ? root.outcomes.map((outcome, index) => {
        if (typeof outcome === "string") {
          return {
            name: outcome,
            tokenId: Array.isArray(root.tokens) ? root.tokens[index]?.tokenId || root.tokens[index]?.id || null : null
          };
        }
        return {
          name: outcome?.name || outcome?.label || outcome?.outcome || "",
          tokenId: outcome?.tokenId || outcome?.token_id || outcome?.id || null
        };
      })
    : Array.isArray(root.tokens)
      ? root.tokens.map((token) => ({
          name: token?.name || token?.label || token?.outcome || "",
          tokenId: token?.tokenId || token?.token_id || token?.id || null
        }))
      : [];

  const upOutcome = findOutcomeEntry(outcomes, ["up", "yes"]);
  const downOutcome = findOutcomeEntry(outcomes, ["down", "no"]);

  return {
    source: "bullpen",
    slug,
    title: String(root.title || root.question || raw?.title || titleFromSlug(slug)),
    conditionId: root.conditionId || root.condition_id || raw?.conditionId || null,
    upOutcomeLabel: upOutcome?.name || "Yes",
    downOutcomeLabel: downOutcome?.name || "No",
    upTokenId: upOutcome?.tokenId || null,
    downTokenId: downOutcome?.tokenId || null,
    acceptingOrders: Boolean(root.acceptingOrders ?? root.accepting_orders ?? !root.closed),
    active: Boolean(root.active ?? !root.closed),
    closed: Boolean(root.closed),
    startSec,
    endSec,
    raw
  };
}

async function fetchGammaEventBySlug(slug) {
  const resp = await fetch(`https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}`, {
    cache: "no-store"
  });
  if (!resp.ok) {
    throw new Error(`Gamma fetch failed for ${slug}: HTTP ${resp.status}`);
  }
  const data = await resp.json();
  if (Array.isArray(data) && data.length) return data[0];
  if (Array.isArray(data?.events) && data.events.length) return data.events[0];
  if (data && typeof data === "object" && data.slug) return data;
  throw new Error(`Gamma event not found for ${slug}`);
}

function normalizeGammaMarket(eventData, slugHint = "") {
  if (!eventData || !Array.isArray(eventData.markets) || !eventData.markets.length) return null;
  const market = eventData.markets[0];
  const outcomes = parseMaybeArray(market.outcomes);
  const tokenIds = parseMaybeArray(market.clobTokenIds);

  const outcomeEntries = outcomes.map((name, index) => ({
    name,
    tokenId: tokenIds[index] || null
  }));

  const upOutcome = findOutcomeEntry(outcomeEntries, ["up", "yes"]);
  const downOutcome = findOutcomeEntry(outcomeEntries, ["down", "no"]);
  const slug = String(eventData.slug || slugHint || "");
  const startSec = toNumericTimestampFromSlug(slug);
  const endSec = Number.isFinite(startSec) ? startSec + FIVE_MIN_SECONDS : null;

  return {
    source: "gamma-fallback",
    slug,
    title: String(eventData.title || titleFromSlug(slug)),
    conditionId: market.conditionId || market.condition_id || null,
    upOutcomeLabel: upOutcome?.name || "Up",
    downOutcomeLabel: downOutcome?.name || "Down",
    upTokenId: upOutcome?.tokenId || null,
    downTokenId: downOutcome?.tokenId || null,
    acceptingOrders: Boolean(market.acceptingOrders ?? (!market.closed && market.active)),
    active: Boolean(market.active),
    closed: Boolean(market.closed),
    startSec,
    endSec,
    raw: {
      eventData,
      market
    }
  };
}

function isTradableMarket(snapshot) {
  if (!snapshot || !snapshot.slug) return false;
  if (!snapshot.upOutcomeLabel || !snapshot.downOutcomeLabel) return false;
  return true;
}

async function resolveCurrentMarket(adapter) {
  const slugs = candidateSlugs();
  const found = [];

  for (const slug of slugs) {
    let market = null;

    if (adapter && typeof adapter.getMarketBySlug === "function") {
      try {
        market = await adapter.getMarketBySlug(slug);
      } catch {
        market = null;
      }
    }

    if (!market) {
      try {
        market = normalizeGammaMarket(await fetchGammaEventBySlug(slug), slug);
      } catch {
        market = null;
      }
    }

    if (market && isTradableMarket(market)) {
      found.push(market);
    }
  }

  if (!found.length) {
    throw new Error("Could not resolve the current BTC 5m market");
  }

  return found.find((item) => item.acceptingOrders || (!item.closed && item.active)) || found[0];
}

module.exports = {
  candidateSlugs,
  fetchGammaEventBySlug,
  normalizeBullpenMarket,
  normalizeGammaMarket,
  resolveCurrentMarket
};
