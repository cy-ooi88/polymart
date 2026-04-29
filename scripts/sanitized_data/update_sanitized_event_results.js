const fs = require('fs');
const path = require('path');

const DATA_DIR = __dirname;
const API_BASE = 'https://gamma-api.polymarket.com';

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function toCsvLine(values) {
  return values
    .map((v) => {
      const s = String(v ?? '');
      if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
        return '"' + s.replace(/"/g, '""') + '"';
      }
      return s;
    })
    .join(',');
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length === 0) return { headers: [], rows: [] };

  const headers = parseCsvLine(lines[0]);
  const rows = lines.slice(1).map((line) => {
    const cols = parseCsvLine(line);
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = cols[idx] ?? '';
    });
    return row;
  });

  return { headers, rows };
}

function encodeCsv(headers, rows) {
  const out = [toCsvLine(headers)];
  for (const row of rows) {
    out.push(toCsvLine(headers.map((h) => row[h] ?? '')));
  }
  return out.join('\n') + '\n';
}

function decodeArrayField(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function getResultFromMarkets(markets) {
  if (!Array.isArray(markets) || markets.length === 0) return 'unknown';

  const winners = [];
  for (const market of markets) {
    const outcomes = decodeArrayField(market.outcomes);
    const prices = decodeArrayField(market.outcomePrices);

    if (!outcomes.length || !prices.length || outcomes.length !== prices.length) {
      winners.push(`${market.slug || market.id}:unknown`);
      continue;
    }

    const winnerIdx = prices.findIndex((p) => Number(p) === 1);
    if (winnerIdx >= 0) {
      winners.push(markets.length === 1 ? outcomes[winnerIdx] : `${market.slug || market.id}:${outcomes[winnerIdx]}`);
    } else {
      winners.push(markets.length === 1 ? 'unresolved' : `${market.slug || market.id}:unresolved`);
    }
  }

  if (markets.length === 1) return winners[0];
  return winners.join(' | ');
}

async function fetchEventBySlug(slug) {
  const res = await fetch(`${API_BASE}/events/slug/${encodeURIComponent(slug)}`);
  if (!res.ok) throw new Error(`slug lookup failed (${res.status})`);
  return res.json();
}

async function fetchEventById(id) {
  const res = await fetch(`${API_BASE}/events/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`id lookup failed (${res.status})`);
  return res.json();
}

async function fetchEvent(slug, id) {
  if (slug) {
    try {
      return await fetchEventBySlug(slug);
    } catch {
      // fallback to id
    }
  }
  if (id) return fetchEventById(id);
  throw new Error('missing slug and id');
}

function needsRefresh(resultValue) {
  const value = String(resultValue || '').trim().toLowerCase();
  return value === '' || value === 'unresolved';
}

async function processFile(filePath, unresolvedReport) {
  const original = fs.readFileSync(filePath, 'utf8');
  const { headers, rows } = parseCsv(original);
  if (!headers.length) return;

  if (!headers.includes('result')) {
    headers.push('result');
    for (const row of rows) row.result = row.result || '';
  }

  let changed = false;

  for (const row of rows) {
    const slug = (row.event_slug || '').trim();
    const id = (row.event_uuid || '').trim();

    if (!needsRefresh(row.result)) continue;

    try {
      const event = await fetchEvent(slug, id);
      const result = getResultFromMarkets(event.markets);
      row.result = result;
      changed = true;

      if (String(result).toLowerCase().includes('unresolved')) {
        unresolvedReport.push({ file: path.basename(filePath), event: slug || id || '(missing id)' });
      }
    } catch (err) {
      row.result = `error:${err.message}`;
      changed = true;
    }
  }

  if (changed) {
    fs.writeFileSync(filePath, encodeCsv(headers, rows), 'utf8');
  }

  console.log(`${path.basename(filePath)} -> ${changed ? 'updated' : 'no changes'}`);
}

async function main() {
  const files = fs
    .readdirSync(DATA_DIR)
    .filter((f) => /^events_sanitized_\d+_\d+\.csv$/.test(f))
    .sort();

  if (!files.length) {
    console.log('No events_sanitized_*.csv files found.');
    return;
  }

  const unresolvedReport = [];

  for (const file of files) {
    await processFile(path.join(DATA_DIR, file), unresolvedReport);
  }

  console.log('\nUnresolved report:');
  if (!unresolvedReport.length) {
    console.log('None');
    return;
  }

  for (const item of unresolvedReport) {
    console.log(`- ${item.file}: ${item.event}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
