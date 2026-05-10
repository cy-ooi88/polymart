"use strict";

const VATIC_TARGET_URL = "https://api.vatic.trading/api/v1/targets/slug/";
const GAMMA_EVENT_URL = "https://gamma-api.polymarket.com/events?slug=";

function toFiniteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function eventFromGammaResponse(data) {
  if (Array.isArray(data) && data.length) return data[0];
  if (Array.isArray(data?.events) && data.events.length) return data.events[0];
  if (data && typeof data === "object" && data.slug) return data;
  return null;
}

function priceFromGammaEvent(eventData) {
  if (!eventData || typeof eventData !== "object") return null;
  const candidates = [
    eventData?.eventMetadata?.priceToBeat,
    eventData?.eventMetadata?.price_to_beat,
    eventData?.event_metadata?.priceToBeat,
    eventData?.event_metadata?.price_to_beat
  ];
  for (const candidate of candidates) {
    const n = toFiniteNumber(candidate);
    if (n !== null) return n;
  }
  return null;
}

function slugWindowStart(slug) {
  const tail = String(slug || "").split("-").pop();
  const n = Number(tail);
  return Number.isFinite(n) ? n : null;
}

class TargetResolver {
  constructor(options = {}) {
    this.fetchImpl = options.fetchImpl || fetch;
    this.now = typeof options.now === "function" ? options.now : () => Date.now();
    this.logger = options.logger || console;
    this.cache = new Map();
    this.successTtlMs = Number.isFinite(Number(options.successTtlMs)) ? Number(options.successTtlMs) : 45_000;
    this.failureTtlMs = Number.isFinite(Number(options.failureTtlMs)) ? Number(options.failureTtlMs) : 5_000;
  }

  readCache(slug) {
    const entry = this.cache.get(slug);
    if (!entry) return null;
    if (this.now() - entry.at > entry.ttlMs) {
      this.cache.delete(slug);
      return null;
    }
    return entry.payload;
  }

  writeCache(slug, payload) {
    const ttlMs = payload.ok ? this.successTtlMs : this.failureTtlMs;
    this.cache.set(slug, {
      at: this.now(),
      ttlMs,
      payload
    });
  }

  makeFailurePayload({ slug, windowStart, attempts, reason, startedAtMs }) {
    return {
      ok: false,
      slug,
      windowStart,
      priceToBeat: null,
      source: null,
      authoritative: false,
      fetchedAt: new Date().toISOString(),
      reason,
      attempts,
      latencyMs: this.now() - startedAtMs
    };
  }

  async tryVatic(slug, expectedWindowStart, attempts) {
    const url = `${VATIC_TARGET_URL}${encodeURIComponent(slug)}`;
    const attempt = { source: "vatic", url, ok: false };
    attempts.push(attempt);

    const resp = await this.fetchImpl(url, { cache: "no-store" });
    attempt.httpStatus = resp.status;
    if (!resp.ok) {
      attempt.reason = `http_${resp.status}`;
      return null;
    }

    const data = await resp.json();
    const price = toFiniteNumber(data?.price);
    const windowStart = toFiniteNumber(data?.windowStart ?? data?.window_start);
    const source = String(data?.source || "unknown").toLowerCase();

    if (!Number.isFinite(price)) {
      attempt.reason = "missing_price";
      return null;
    }
    if (!Number.isFinite(windowStart)) {
      attempt.reason = "missing_window_start";
      return null;
    }
    if (Number.isFinite(expectedWindowStart) && windowStart !== expectedWindowStart) {
      attempt.reason = "window_start_mismatch";
      attempt.windowStart = windowStart;
      return null;
    }

    attempt.ok = true;
    return {
      slug,
      windowStart,
      priceToBeat: price,
      source: `vatic_${source}_slug`,
      authoritative: true
    };
  }

  async tryGamma(slug, expectedWindowStart, attempts) {
    const url = `${GAMMA_EVENT_URL}${encodeURIComponent(slug)}`;
    const attempt = { source: "gamma_event_metadata", url, ok: false };
    attempts.push(attempt);

    const resp = await this.fetchImpl(url, { cache: "no-store" });
    attempt.httpStatus = resp.status;
    if (!resp.ok) {
      attempt.reason = `http_${resp.status}`;
      return null;
    }

    const raw = await resp.json();
    const eventData = eventFromGammaResponse(raw);
    if (!eventData) {
      attempt.reason = "event_not_found";
      return null;
    }
    const price = priceFromGammaEvent(eventData);
    if (!Number.isFinite(price)) {
      attempt.reason = "missing_price_to_beat";
      return null;
    }

    attempt.ok = true;
    return {
      slug,
      windowStart: Number.isFinite(expectedWindowStart) ? expectedWindowStart : null,
      priceToBeat: price,
      source: "gamma_event_metadata",
      authoritative: true
    };
  }

  async resolveBySlug(slug) {
    const normalizedSlug = String(slug || "").trim();
    const expectedWindowStart = slugWindowStart(normalizedSlug);
    const startedAtMs = this.now();

    if (!normalizedSlug) {
      return this.makeFailurePayload({
        slug: "",
        windowStart: expectedWindowStart,
        attempts: [],
        reason: "missing_slug",
        startedAtMs
      });
    }

    const cached = this.readCache(normalizedSlug);
    if (cached) return cached;

    const attempts = [];
    let result = null;

    try {
      result = await this.tryVatic(normalizedSlug, expectedWindowStart, attempts);
    } catch (error) {
      attempts.push({
        source: "vatic",
        ok: false,
        reason: String(error?.message || "vatic_fetch_failed")
      });
    }

    if (!result) {
      try {
        result = await this.tryGamma(normalizedSlug, expectedWindowStart, attempts);
      } catch (error) {
        attempts.push({
          source: "gamma_event_metadata",
          ok: false,
          reason: String(error?.message || "gamma_fetch_failed")
        });
      }
    }

    if (!result) {
      const failure = this.makeFailurePayload({
        slug: normalizedSlug,
        windowStart: expectedWindowStart,
        attempts,
        reason: "authoritative_target_unavailable",
        startedAtMs
      });
      this.writeCache(normalizedSlug, failure);
      this.logger.info(
        `[target-resolver] ${normalizedSlug} ok=false latencyMs=${failure.latencyMs} attempts=${JSON.stringify(failure.attempts)}`
      );
      return failure;
    }

    const payload = {
      ok: true,
      ...result,
      fetchedAt: new Date().toISOString(),
      attempts,
      latencyMs: this.now() - startedAtMs
    };
    this.writeCache(normalizedSlug, payload);
    this.logger.info(
      `[target-resolver] ${normalizedSlug} ok=true source=${payload.source} latencyMs=${payload.latencyMs} attempts=${JSON.stringify(payload.attempts)}`
    );
    return payload;
  }
}

module.exports = {
  TargetResolver
};
