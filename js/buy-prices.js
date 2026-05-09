import { getCurrentMarketPrice } from "./bullpen-api.js";
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

export async function refreshBuyPrices() {
  if (!state.currentSlug) return;
  try {
    const response = await getCurrentMarketPrice(state.currentSlug);
    const price = response.price || {};
    state.upAsk = Number.isFinite(Number(price.upAsk)) ? Number(price.upAsk) : null;
    state.downAsk = Number.isFinite(Number(price.downAsk)) ? Number(price.downAsk) : null;
    state.upBid = Number.isFinite(Number(price.upBid)) ? Number(price.upBid) : null;
    state.downBid = Number.isFinite(Number(price.downBid)) ? Number(price.downBid) : null;
    updateBuyButtons();
    updateSellButtons();
    logPriceTick("buy_up", state.upAsk);
    logPriceTick("buy_down", state.downAsk);
    logPriceTick("sell_up", state.upBid);
    logPriceTick("sell_down", state.downBid);
  } catch (err) {
    setStatus(`Price update failed: ${err.message}`, "warn");
  }
}
