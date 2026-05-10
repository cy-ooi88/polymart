"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { TargetResolver } = require("../target-resolver");

function response(status, data) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return data;
    }
  };
}

function makeFetch(responders) {
  return async (url) => {
    for (const responder of responders) {
      if (url.includes(responder.match)) return responder.reply(url);
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
}

test("vatic success is preferred and returned as authoritative canonical", async () => {
  const fetchImpl = makeFetch([
    {
      match: "api.vatic.trading",
      reply: () => response(200, {
        marketType: "5min",
        windowStart: 1778398800,
        source: "chainlink",
        price: 80763.5589804055
      })
    }
  ]);

  const resolver = new TargetResolver({ fetchImpl, logger: { info() {} } });
  const result = await resolver.resolveBySlug("btc-updown-5m-1778398800");

  assert.equal(result.ok, true);
  assert.equal(result.source, "vatic_chainlink_slug");
  assert.equal(result.authoritative, true);
  assert.equal(result.windowStart, 1778398800);
  assert.equal(result.priceToBeat, 80763.5589804055);
});

test("falls back to gamma eventMetadata when vatic is unavailable", async () => {
  const fetchImpl = makeFetch([
    {
      match: "api.vatic.trading",
      reply: () => response(503, { message: "temporary outage" })
    },
    {
      match: "gamma-api.polymarket.com/events",
      reply: () => response(200, [
        {
          slug: "btc-updown-5m-1778397600",
          eventMetadata: {
            priceToBeat: 80747.53974661793
          }
        }
      ])
    }
  ]);

  const resolver = new TargetResolver({ fetchImpl, logger: { info() {} } });
  const result = await resolver.resolveBySlug("btc-updown-5m-1778397600");

  assert.equal(result.ok, true);
  assert.equal(result.source, "gamma_event_metadata");
  assert.equal(result.authoritative, true);
  assert.equal(result.priceToBeat, 80747.53974661793);
});

test("returns ok=false when both vatic and gamma fail to provide a target", async () => {
  const fetchImpl = makeFetch([
    {
      match: "api.vatic.trading",
      reply: () => response(500, { message: "down" })
    },
    {
      match: "gamma-api.polymarket.com/events",
      reply: () => response(200, [
        {
          slug: "btc-updown-5m-1778397900",
          eventMetadata: {}
        }
      ])
    }
  ]);

  const resolver = new TargetResolver({ fetchImpl, logger: { info() {} } });
  const result = await resolver.resolveBySlug("btc-updown-5m-1778397900");

  assert.equal(result.ok, false);
  assert.equal(result.reason, "authoritative_target_unavailable");
  assert.equal(result.priceToBeat, null);
  assert.ok(Array.isArray(result.attempts));
  assert.ok(result.attempts.length >= 2);
});

test("rejects mismatched vatic windowStart and does not accept that target", async () => {
  const fetchImpl = makeFetch([
    {
      match: "api.vatic.trading",
      reply: () => response(200, {
        marketType: "5min",
        windowStart: 1778398500,
        source: "chainlink",
        price: 80770.12
      })
    },
    {
      match: "gamma-api.polymarket.com/events",
      reply: () => response(503, { message: "down" })
    }
  ]);

  const resolver = new TargetResolver({ fetchImpl, logger: { info() {} } });
  const result = await resolver.resolveBySlug("btc-updown-5m-1778398800");

  assert.equal(result.ok, false);
  assert.equal(result.reason, "authoritative_target_unavailable");
  assert.ok(result.attempts.some((attempt) => attempt.reason === "window_start_mismatch"));
});
