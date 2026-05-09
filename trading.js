// trading.js - Bullpen-backed trading actions routed through the local adapter

import {
  runBullpenApprove,
  runBullpenPreflight,
  submitBuyOrder,
  submitSellOrder
} from "./js/bullpen-api.js";

export function placeBuyOrder({ slug, side, amountUsd }) {
  return submitBuyOrder({ slug, side, amountUsd });
}

export function placeSellOrder({ slug, side, amountUsd }) {
  return submitSellOrder({ slug, side, amountUsd });
}

export function runPreflightCheck() {
  return runBullpenPreflight();
}

export function runApprovalFlow() {
  return runBullpenApprove();
}
