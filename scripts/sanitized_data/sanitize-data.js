const fs = require('fs');
const path = require('path');

const scriptsDir = path.resolve(__dirname, '..');
const outputDir = __dirname;

function parseCsv(content) {
  const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) return { headers: [], rows: [] };

  const headers = lines[0].split(',');
  const rows = lines.slice(1).map((line) => {
    const values = line.split(',');
    const obj = {};
    for (let i = 0; i < headers.length; i += 1) {
      obj[headers[i]] = values[i] ?? '';
    }
    return obj;
  });

  return { headers, rows };
}

function toCsv(headers, rows) {
  const out = [headers.join(',')];
  for (const row of rows) {
    out.push(headers.map((h) => row[h] ?? '').join(','));
  }
  return `${out.join('\n')}\n`;
}

function isEventDenseEnough(priceRows) {
  if (priceRows.length < 2) return false;

  const timestamps = priceRows
    .map((r) => Date.parse(r.timestamp))
    .filter((ms) => Number.isFinite(ms))
    .sort((a, b) => a - b);

  if (timestamps.length < 2) return false;

  let maxDeltaSeconds = 0;
  for (let i = 1; i < timestamps.length; i += 1) {
    const deltaSeconds = (timestamps[i] - timestamps[i - 1]) / 1000;
    if (deltaSeconds > maxDeltaSeconds) maxDeltaSeconds = deltaSeconds;
  }

  const durationSeconds = (timestamps[timestamps.length - 1] - timestamps[0]) / 1000;
  const avgRowsPerSecond = timestamps.length / Math.max(1, durationSeconds);

  return maxDeltaSeconds <= 3 && avgRowsPerSecond >= 1;
}

function suffixFromEventsName(fileName) {
  const m = fileName.match(/^events_(.+)\.csv$/);
  return m ? m[1] : null;
}

function run() {
  const files = fs.readdirSync(scriptsDir);
  const eventsFiles = files.filter((f) => /^events_.+\.csv$/.test(f));

  if (eventsFiles.length === 0) {
    console.log('No events_*.csv files found.');
    return;
  }

  for (const eventsFile of eventsFiles) {
    const suffix = suffixFromEventsName(eventsFile);
    if (!suffix) continue;

    const priceFile = `price_data_${suffix}.csv`;
    const eventsPath = path.join(scriptsDir, eventsFile);
    const pricePath = path.join(scriptsDir, priceFile);

    if (!fs.existsSync(pricePath)) {
      console.log(`Skipping ${eventsFile}: missing ${priceFile}`);
      continue;
    }

    const eventsCsv = parseCsv(fs.readFileSync(eventsPath, 'utf8'));
    const priceCsv = parseCsv(fs.readFileSync(pricePath, 'utf8'));

    if (eventsCsv.rows.length === 0) {
      console.log(`Skipping ${eventsFile}: no event rows.`);
      continue;
    }

    const firstEventUuid = eventsCsv.rows[0].event_uuid;

    // Ignore the first event in events file.
    const trimmedEvents = eventsCsv.rows.slice(1);

    // Ignore price rows belonging to the first event_uuid.
    const trimmedPrice = priceCsv.rows.filter((r) => r.event_uuid !== firstEventUuid);

    const priceByUuid = new Map();
    for (const row of trimmedPrice) {
      if (!priceByUuid.has(row.event_uuid)) priceByUuid.set(row.event_uuid, []);
      priceByUuid.get(row.event_uuid).push(row);
    }

    const keepUuids = new Set();
    for (const eventRow of trimmedEvents) {
      const uuid = eventRow.event_uuid;
      const rows = priceByUuid.get(uuid) || [];
      if (isEventDenseEnough(rows)) keepUuids.add(uuid);
    }

    const sanitizedEvents = trimmedEvents.filter((r) => keepUuids.has(r.event_uuid));
    const sanitizedPrice = trimmedPrice.filter((r) => keepUuids.has(r.event_uuid));

    const outEvents = path.join(outputDir, `events_sanitized_${suffix}.csv`);
    const outPrice = path.join(outputDir, `price_data_sanitized_${suffix}.csv`);

    fs.writeFileSync(outEvents, toCsv(eventsCsv.headers, sanitizedEvents), 'utf8');
    fs.writeFileSync(outPrice, toCsv(priceCsv.headers, sanitizedPrice), 'utf8');

    console.log(
      `Processed ${suffix}: kept ${sanitizedEvents.length}/${trimmedEvents.length} events, wrote ${path.basename(outEvents)} and ${path.basename(outPrice)}`
    );
  }
}

run();
