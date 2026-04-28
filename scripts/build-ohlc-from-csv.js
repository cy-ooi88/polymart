#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const DEFAULT_INTERVALS = [5, 10, 15, 20, 30];
const EVENTS_FILE_RE = /^events_(.+)\.csv$/i;

function parseArgs(argv) {
  const options = {
    intervals: DEFAULT_INTERVALS,
    events: null,
    prices: null,
    outDir: __dirname
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--intervals") {
      const value = argv[i + 1] || "";
      i += 1;
      const parsed = value
        .split(",")
        .map((x) => Number(x.trim()))
        .filter((x) => Number.isFinite(x) && x > 0);
      if (!parsed.length) {
        throw new Error("--intervals must contain comma-separated positive numbers, e.g. 5,10,15");
      }
      options.intervals = parsed;
      continue;
    }

    if (arg === "--events") {
      options.events = argv[i + 1] || null;
      i += 1;
      continue;
    }

    if (arg === "--prices") {
      options.prices = argv[i + 1] || null;
      i += 1;
      continue;
    }

    if (arg === "--out-dir") {
      options.outDir = argv[i + 1] || __dirname;
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function toCsvCell(value) {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (!/[",\r\n]/.test(s)) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

function writeCsv(filePath, headers, rows) {
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => toCsvCell(row[h])).join(","));
  }
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cell += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      continue;
    }

    if (ch === ",") {
      row.push(cell);
      cell = "";
      continue;
    }

    if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }

    if (ch === "\r") {
      continue;
    }

    cell += ch;
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  if (!rows.length) return [];
  const headers = rows[0].map((x) => x.trim());

  return rows
    .slice(1)
    .filter((r) => r.some((x) => String(x).trim() !== ""))
    .map((r) => {
      const obj = {};
      headers.forEach((h, idx) => {
        obj[h] = r[idx] !== undefined ? r[idx] : "";
      });
      return obj;
    });
}

function parseIsoMs(value) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function parseNumeric(value) {
  if (value === null || value === undefined) return null;
  const n = Number(String(value).trim());
  return Number.isFinite(n) ? n : null;
}

function sanitizeEvents(eventRows) {
  const eventMap = new Map();
  for (const evt of eventRows) {
    const id = String(evt.event_uuid || "").trim();
    if (!id) continue;

    if (!eventMap.has(id)) {
      eventMap.set(id, evt);
    }
  }

  return eventMap;
}

function sanitizePriceRows(priceRows, eventMap) {
  const deduped = [];
  const seen = new Set();

  for (const row of priceRows) {
    const eventUuid = String(row.event_uuid || "").trim();
    if (!eventUuid || !eventMap.has(eventUuid)) continue;

    const ts = parseIsoMs(row.timestamp);
    if (!Number.isFinite(ts)) continue;

    const px = parseNumeric(row.current_price);
    if (!Number.isFinite(px)) continue;

    const key = `${eventUuid}|${ts}|${px}`;
    if (seen.has(key)) continue;
    seen.add(key);

    deduped.push({
      ...row,
      event_uuid: eventUuid,
      _timestamp_ms: ts,
      _current_price: px
    });
  }

  return deduped;
}

function candlePriority(candle) {
  const bucketMs = parseIsoMs(candle.bucket_start);
  const eventMs = parseIsoMs(candle.event_timestamp);
  const distance = Number.isFinite(bucketMs) && Number.isFinite(eventMs) ? Math.abs(bucketMs - eventMs) : Number.POSITIVE_INFINITY;
  const samples = Number(candle.samples) || 0;
  return { distance, samples, eventMs: Number.isFinite(eventMs) ? eventMs : -1 };
}

function pickPreferredCandle(current, candidate) {
  const a = candlePriority(current);
  const b = candlePriority(candidate);

  if (b.distance !== a.distance) return b.distance < a.distance ? candidate : current;
  if (b.samples !== a.samples) return b.samples > a.samples ? candidate : current;
  if (b.eventMs !== a.eventMs) return b.eventMs > a.eventMs ? candidate : current;
  return candidate;
}

function dedupeCandles(candles) {
  const byBucket = new Map();

  for (const candle of candles) {
    const key = candle.bucket_start;
    if (!byBucket.has(key)) {
      byBucket.set(key, candle);
      continue;
    }

    byBucket.set(key, pickPreferredCandle(byBucket.get(key), candle));
  }

  return Array.from(byBucket.values()).sort((a, b) => a.bucket_start.localeCompare(b.bucket_start));
}

function discoverPairs(baseDir) {
  const names = fs.readdirSync(baseDir);
  const pairs = [];

  for (const name of names) {
    const m = name.match(EVENTS_FILE_RE);
    if (!m) continue;

    const suffix = m[1];
    const eventsPath = path.join(baseDir, name);
    const pricesPath = path.join(baseDir, `price_data_${suffix}.csv`);

    if (!fs.existsSync(pricesPath)) {
      console.warn(`[skip] Missing matching price file for ${name}`);
      continue;
    }

    pairs.push({ suffix, eventsPath, pricesPath });
  }

  return pairs.sort((a, b) => a.suffix.localeCompare(b.suffix));
}

function aggregateOhlc(priceRows, eventMap, intervalSec) {
  const intervalMs = intervalSec * 1000;
  const buckets = new Map();

  for (const row of priceRows) {
    const eventUuid = row.event_uuid;
    const ts = row._timestamp_ms;
    const px = row._current_price;

    const bucketStart = Math.floor(ts / intervalMs) * intervalMs;
    const key = `${eventUuid}|${bucketStart}`;

    let candle = buckets.get(key);
    if (!candle) {
      const evt = eventMap.get(eventUuid);
      candle = {
        event_uuid: eventUuid,
        event_slug: evt.event_slug || "",
        event_timestamp: evt.event_timestamp || "",
        bucket_start: new Date(bucketStart).toISOString(),
        bucket_end: new Date(bucketStart + intervalMs).toISOString(),
        open: px,
        high: px,
        low: px,
        close: px,
        open_ts_ms: ts,
        close_ts_ms: ts,
        samples: 1
      };
      buckets.set(key, candle);
      continue;
    }

    if (ts < candle.open_ts_ms) {
      candle.open_ts_ms = ts;
      candle.open = px;
    }
    if (ts >= candle.close_ts_ms) {
      candle.close_ts_ms = ts;
      candle.close = px;
    }

    if (px > candle.high) candle.high = px;
    if (px < candle.low) candle.low = px;
    candle.samples += 1;
  }

  return dedupeCandles(
    Array.from(buckets.values()).map((c) => ({
      event_uuid: c.event_uuid,
      event_slug: c.event_slug,
      event_timestamp: c.event_timestamp,
      bucket_start: c.bucket_start,
      bucket_end: c.bucket_end,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      samples: c.samples
    }))
  );
}

function processPair(pair, intervals, outDir) {
  const eventsText = fs.readFileSync(pair.eventsPath, "utf8");
  const pricesText = fs.readFileSync(pair.pricesPath, "utf8");

  const eventRows = parseCsv(eventsText);
  const priceRows = parseCsv(pricesText);

  const eventMap = sanitizeEvents(eventRows);
  const sanitizedPriceRows = sanitizePriceRows(priceRows, eventMap);

  if (!eventMap.size) {
    console.warn(`[skip] No event_uuid rows in ${path.basename(pair.eventsPath)}`);
    return;
  }

  if (!sanitizedPriceRows.length) {
    console.warn(`[skip] No price rows in ${path.basename(pair.pricesPath)}`);
    return;
  }

  const headers = [
    "event_uuid",
    "event_slug",
    "event_timestamp",
    "bucket_start",
    "bucket_end",
    "open",
    "high",
    "low",
    "close",
    "samples"
  ];

  for (const intervalSec of intervals) {
    const candles = aggregateOhlc(sanitizedPriceRows, eventMap, intervalSec);
    const outPath = path.join(outDir, `ohlc_${intervalSec}s_${pair.suffix}.csv`);
    writeCsv(outPath, headers, candles);
    console.log(`[ok] ${path.basename(outPath)} (${candles.length} rows)`);
  }
}

function main() {
  const opts = parseArgs(process.argv);
  const outDir = path.resolve(opts.outDir);

  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  let pairs = [];
  if (opts.events || opts.prices) {
    if (!opts.events || !opts.prices) {
      throw new Error("When using --events/--prices, both must be provided.");
    }

    const eventsPath = path.resolve(opts.events);
    const pricesPath = path.resolve(opts.prices);
    const eventsName = path.basename(eventsPath);
    const m = eventsName.match(EVENTS_FILE_RE);
    const suffix = m ? m[1] : "manual";
    pairs = [{ suffix, eventsPath, pricesPath }];
  } else {
    pairs = discoverPairs(__dirname);
  }

  if (!pairs.length) {
    console.log("No matching events_*.csv / price_data_*.csv pairs found.");
    return;
  }

  for (const pair of pairs) {
    processPair(pair, opts.intervals, outDir);
  }

  console.log("[done] OHLC aggregation complete.");
}

main();
