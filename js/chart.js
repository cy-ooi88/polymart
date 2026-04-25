import { FIVE_MIN_SECONDS, MAX_CHART_POINTS } from "./constants.js";
import { logPriceTick } from "./data-logger.js";
import { dom } from "./dom.js";
import { formatDelta, formatUsd } from "./formatters.js";
import { state } from "./state.js";

function chartTargetPrice() {
  if (Number.isFinite(state.targetPriceCanonical)) return state.targetPriceCanonical;
  return Number.isFinite(state.targetPriceFallback) ? state.targetPriceFallback : null;
}

function chartTargetSourceLabel() {
  if (Number.isFinite(state.targetPriceCanonical)) return "CL";
  if (Number.isFinite(state.targetPriceFallback)) return "FB";
  return "";
}

export function updateTargetDisplay() {
  const activeTarget = chartTargetPrice();
  dom.priceToBeatEl.textContent = Number.isFinite(activeTarget)
    ? `$${formatUsd(activeTarget)}`
    : "$--";
  dom.canonicalPriceEl.textContent = Number.isFinite(state.targetPriceCanonical)
    ? `$${formatUsd(state.targetPriceCanonical)}`
    : "$--";
  dom.fallbackPriceEl.textContent = Number.isFinite(state.targetPriceFallback)
    ? `$${formatUsd(state.targetPriceFallback)}`
    : "$--";
  renderPriceDelta();
  drawChart();
}

function renderPriceDelta() {
  const activeTarget = chartTargetPrice();
  if (!Number.isFinite(state.latestPrice) || !Number.isFinite(activeTarget)) {
    dom.deltaEl.textContent = "";
    dom.deltaEl.classList.remove("positive", "negative");
    return;
  }

  const diff = state.latestPrice - activeTarget;
  const direction = diff >= 0 ? "positive" : "negative";
  const arrow = diff >= 0 ? "+" : "-";

  dom.deltaEl.classList.remove("positive", "negative");
  dom.deltaEl.classList.add(direction);
  dom.deltaEl.textContent = `${arrow} $${formatDelta(Math.abs(diff))}`;
}

export function setupChart() {
  state.chartCtx = dom.chartEl.getContext("2d");
  resizeChart();
  window.addEventListener("resize", resizeChart);
}

function resizeChart() {
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(320, Math.floor(dom.chartEl.clientWidth));
  const height = Math.max(220, Math.floor(dom.chartEl.clientHeight));
  dom.chartEl.width = Math.floor(width * dpr);
  dom.chartEl.height = Math.floor(height * dpr);
  state.chartDpr = dpr;
  drawChart();
}

function computeYRange(points, targetPrice) {
  const values = points.map((pt) => pt.p);
  if (Number.isFinite(targetPrice)) values.push(targetPrice);
  if (!values.length) return null;

  let min = Math.min(...values);
  let max = Math.max(...values);
  if (min === max) {
    const bump = Math.max(Math.abs(min) * 0.0008, 1);
    min -= bump;
    max += bump;
  }

  const currentRef = points.length ? points[points.length - 1].p : targetPrice;
  const minSpan = Math.max(Math.abs(Number(currentRef) || 0) * 0.0009, 2.5);
  const span = max - min;
  if (span < minSpan) {
    const center = (min + max) / 2;
    min = center - minSpan / 2;
    max = center + minSpan / 2;
  }

  const paddedSpan = max - min;
  const pad = Math.max(0.6, paddedSpan * 0.12);
  min -= pad;
  max += pad;

  if (Number.isFinite(targetPrice)) {
    if (targetPrice <= min) min = targetPrice - 0.9;
    if (targetPrice >= max) max = targetPrice + 0.9;
  }

  return { min, max };
}

function maybeSetCanonicalTarget(timestampMs, price) {
  if (!Number.isFinite(state.targetPriceCanonicalAnchorMs)) return false;
  const t = Number(timestampMs);
  const p = Number(price);
  if (!Number.isFinite(t) || !Number.isFinite(p)) return false;

  const anchorMs = state.targetPriceCanonicalAnchorMs;
  if (t < anchorMs) return false;

  const shouldReplace = !Number.isFinite(state.targetPriceCanonicalTs)
    || t < state.targetPriceCanonicalTs;

  if (!shouldReplace) return false;
  state.targetPriceCanonical = p;
  state.targetPriceCanonicalTs = t;
  return true;
}

function drawChart() {
  if (!state.chartCtx) return;
  const ctx = state.chartCtx;
  const dpr = state.chartDpr || 1;
  const width = dom.chartEl.width / dpr;
  const height = dom.chartEl.height / dpr;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const pad = { left: 12, right: 76, top: 12, bottom: 16 };
  const chartW = width - pad.left - pad.right;
  const chartH = height - pad.top - pad.bottom;
  if (chartW <= 0 || chartH <= 0) return;

  const bg = ctx.createLinearGradient(0, 0, 0, height);
  bg.addColorStop(0, "#0d1728");
  bg.addColorStop(1, "#0a111b");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);

  const points = state.pricePoints;
  const activeTarget = chartTargetPrice();
  const yRange = computeYRange(points, activeTarget);
  if (!yRange) {
    ctx.fillStyle = "#7d8ea8";
    ctx.font = "600 16px Manrope, Segoe UI, sans-serif";
    ctx.fillText("Waiting for BTC price updates...", 16, 30);
    dom.targetTagEl.style.display = "none";
    return;
  }

  const fallbackEnd = Number.isFinite(state.currentWindowEndSec) ? state.currentWindowEndSec * 1000 : Date.now();
  const fallbackStart = Number.isFinite(state.currentWindowStartSec)
    ? state.currentWindowStartSec * 1000
    : fallbackEnd - (FIVE_MIN_SECONDS * 1000);

  const tMin = points.length ? Math.min(fallbackStart, points[0].t) : fallbackStart;
  const tMaxBase = points.length ? Math.max(fallbackEnd, points[points.length - 1].t) : fallbackEnd;
  const tMax = Math.max(tMin + 1000, tMaxBase);
  const tSpan = tMax - tMin;

  const xOf = (t) => pad.left + ((t - tMin) / tSpan) * chartW;
  const yOf = (v) => pad.top + (1 - (v - yRange.min) / (yRange.max - yRange.min)) * chartH;

  ctx.strokeStyle = "#1e2c45";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i += 1) {
    const y = pad.top + (i / 4) * chartH;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(width - pad.right, y);
    ctx.stroke();
  }

  ctx.fillStyle = "#7d8ea8";
  ctx.font = "600 12px Manrope, Segoe UI, sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  for (let i = 0; i <= 3; i += 1) {
    const ratio = i / 3;
    const value = yRange.max - ratio * (yRange.max - yRange.min);
    const y = pad.top + ratio * chartH;
    ctx.fillText(`$${formatUsd(value)}`, width - pad.right + 10, y);
  }

  if (Number.isFinite(activeTarget)) {
    const y = yOf(activeTarget);
    ctx.save();
    ctx.setLineDash([7, 5]);
    ctx.strokeStyle = "rgba(170, 126, 70, 0.95)";
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(width - pad.right, y);
    ctx.stroke();
    ctx.restore();

    dom.targetTagEl.style.display = "inline-flex";
    const sourceLabel = chartTargetSourceLabel();
    dom.targetTagEl.textContent = sourceLabel ? `Target ${sourceLabel}` : "Target";
    const top = Math.max(6, Math.min(height - 36, y - 14));
    dom.targetTagEl.style.top = `${top}px`;
  } else {
    dom.targetTagEl.style.display = "none";
  }

  if (points.length >= 2) {
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#f7a600";

    ctx.beginPath();
    points.forEach((pt, i) => {
      const x = xOf(pt.t);
      const y = yOf(pt.p);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    const fill = ctx.createLinearGradient(0, pad.top, 0, pad.top + chartH);
    fill.addColorStop(0, "rgba(247, 166, 0, 0.14)");
    fill.addColorStop(1, "rgba(247, 166, 0, 0.01)");

    ctx.beginPath();
    points.forEach((pt, i) => {
      const x = xOf(pt.t);
      const y = yOf(pt.p);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    const lastX = xOf(points[points.length - 1].t);
    const firstX = xOf(points[0].t);
    ctx.lineTo(lastX, pad.top + chartH);
    ctx.lineTo(firstX, pad.top + chartH);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();

    const last = points[points.length - 1];
    const lx = xOf(last.t);
    const ly = yOf(last.p);
    ctx.strokeStyle = "rgba(247, 166, 0, 0.95)";
    ctx.fillStyle = "rgba(247, 166, 0, 0.22)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(lx, ly, 10, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(lx, ly, 3.4, 0, Math.PI * 2);
    ctx.fillStyle = "#f7a600";
    ctx.fill();
  } else if (points.length === 1) {
    const x = xOf(points[0].t);
    const y = yOf(points[0].p);
    ctx.fillStyle = "#f7a600";
    ctx.beginPath();
    ctx.arc(x, y, 3.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

export function addPricePoint(timestampMs, price) {
  const rawT = Number.isFinite(timestampMs) ? timestampMs : Date.now();
  const t = rawT < 1e12 ? rawT * 1000 : rawT;
  const p = Number(price);
  if (!Number.isFinite(t) || !Number.isFinite(p)) return;

  const last = state.pricePoints[state.pricePoints.length - 1];
  if (last && t <= last.t + 150) {
    last.t = Math.max(last.t, t);
    last.p = p;
  } else {
    state.pricePoints.push({ t, p });
  }

  if (state.pricePoints.length > MAX_CHART_POINTS) {
    state.pricePoints = state.pricePoints.slice(state.pricePoints.length - MAX_CHART_POINTS);
  }

  state.latestPrice = p;
  logPriceTick("current_price", p, t);
  dom.btcEl.textContent = `$${formatUsd(p)}`;
  const canonicalChanged = maybeSetCanonicalTarget(t, p);
  if (canonicalChanged) {
    updateTargetDisplay();
  } else {
    renderPriceDelta();
    drawChart();
  }
}
