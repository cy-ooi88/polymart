"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveMarketTargetResponse } = require("../market-target-route");

test("uses explicit slug when provided", async () => {
  const adapter = {
    async getCurrentMarket() {
      throw new Error("should not be called");
    }
  };
  const targetResolver = {
    async resolveBySlug(slug) {
      return { ok: true, slug, priceToBeat: 123, source: "vatic_chainlink_slug", authoritative: true };
    }
  };

  const result = await resolveMarketTargetResponse({
    adapter,
    targetResolver,
    slug: "btc-updown-5m-100"
  });

  assert.equal(result.statusCode, 200);
  assert.equal(result.payload.ok, true);
  assert.equal(result.payload.slug, "btc-updown-5m-100");
});

test("resolves slug from adapter when slug query is missing", async () => {
  const adapter = {
    async getCurrentMarket() {
      return { slug: "btc-updown-5m-200" };
    }
  };
  const targetResolver = {
    async resolveBySlug(slug) {
      return { ok: true, slug, priceToBeat: 222, source: "gamma_event_metadata", authoritative: true };
    }
  };

  const result = await resolveMarketTargetResponse({
    adapter,
    targetResolver,
    slug: ""
  });

  assert.equal(result.statusCode, 200);
  assert.equal(result.payload.slug, "btc-updown-5m-200");
});

test("returns 400 when slug cannot be resolved", async () => {
  const adapter = {
    async getCurrentMarket() {
      return { slug: "" };
    }
  };
  const targetResolver = {
    async resolveBySlug() {
      throw new Error("should not be called");
    }
  };

  const result = await resolveMarketTargetResponse({
    adapter,
    targetResolver,
    slug: ""
  });

  assert.equal(result.statusCode, 400);
  assert.equal(result.payload.ok, false);
});

test("returns 503 when resolver cannot provide authoritative target", async () => {
  const adapter = {
    async getCurrentMarket() {
      return { slug: "btc-updown-5m-300" };
    }
  };
  const targetResolver = {
    async resolveBySlug(slug) {
      return { ok: false, slug, reason: "authoritative_target_unavailable" };
    }
  };

  const result = await resolveMarketTargetResponse({
    adapter,
    targetResolver,
    slug: ""
  });

  assert.equal(result.statusCode, 503);
  assert.equal(result.payload.ok, false);
  assert.equal(result.payload.reason, "authoritative_target_unavailable");
});
