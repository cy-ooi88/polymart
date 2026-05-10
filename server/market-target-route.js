"use strict";

async function resolveMarketTargetResponse({ adapter, targetResolver, slug }) {
  let normalizedSlug = String(slug || "").trim();
  if (!normalizedSlug) {
    const market = await adapter.getCurrentMarket();
    normalizedSlug = String(market?.slug || "").trim();
  }

  if (!normalizedSlug) {
    return {
      statusCode: 400,
      payload: {
        ok: false,
        slug: "",
        message: "Could not resolve current market slug"
      }
    };
  }

  const payload = await targetResolver.resolveBySlug(normalizedSlug);
  return {
    statusCode: payload.ok ? 200 : 503,
    payload
  };
}

module.exports = {
  resolveMarketTargetResponse
};
