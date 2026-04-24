export function formatUsd(n) {
  if (!Number.isFinite(n)) return "--";
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function formatDelta(n) {
  if (!Number.isFinite(n)) return "--";
  return n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

export function formatShareLabel(sharePrice) {
  if (!Number.isFinite(sharePrice)) return "--";
  return `${Math.round(sharePrice * 100)}c`;
}

function etTimeParts(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
    hour12: true
  }).formatToParts(date);

  const out = { hour: "", minute: "", dayPeriod: "" };
  parts.forEach((part) => {
    if (part.type === "hour") out.hour = part.value;
    if (part.type === "minute") out.minute = part.value;
    if (part.type === "dayPeriod") out.dayPeriod = part.value.toUpperCase();
  });
  return out;
}

export function formatEventWindowEt(startSec, endSec) {
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) return "Loading current event...";

  const startDate = new Date(startSec * 1000);
  const endDate = new Date(endSec * 1000);
  const dateLabel = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric"
  }).format(startDate);

  const start = etTimeParts(startDate);
  const end = etTimeParts(endDate);
  return `${dateLabel}, ${start.hour}:${start.minute}-${end.hour}:${end.minute}${end.dayPeriod} ET`;
}
