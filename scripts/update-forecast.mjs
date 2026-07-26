import fs from "node:fs/promises";

const COLLECTION = "ch.meteoschweiz.ogd-local-forecasting";
const STAC = `https://data.geo.admin.ch/api/stac/v1/collections/${COLLECTION}`;
const POINTS = `https://data.geo.admin.ch/${COLLECTION}/ogd-local-forecasting_meta_point.csv`;
const TZ = "Europe/Zurich";
const PARAMS = ["dkl010h0", "fu3010h0", "fu3010h1"];

const LOCATIONS = [
  {
    id: "arth",
    label: "Arth",
    postcode: "6415",
    namePattern: /^Arth$/i,
    source_url: "https://www.meteoschweiz.admin.ch/lokalprognose/arth/6415.html#forecast-tab=wind-gust-peaks"
  },
  {
    id: "walchwil",
    label: "Walchwil",
    postcode: "6318",
    namePattern: /^Walchwil$/i,
    source_url: "https://www.meteoschweiz.admin.ch/lokalprognose/walchwil/6318.html#forecast-tab=wind-gust-peaks"
  },
  {
    id: "cham",
    label: "Cham",
    postcode: "6330",
    namePattern: /^Cham$/i,
    source_url: "https://www.meteoschweiz.admin.ch/lokalprognose/cham/6330.html#forecast-tab=wind-gust-peaks"
  },
  {
    id: "risch",
    label: "Risch",
    postcode: "6343",
    namePattern: /^Risch$/i,
    source_url: "https://www.meteoschweiz.admin.ch/lokalprognose/risch/6343.html#forecast-tab=wind-gust-peaks"
  },
  {
    id: "zug-marina",
    label: "Marina Zug",
    postcode: "6300",
    namePattern: /^Zug$/i,
    source_url: "https://www.meteoschweiz.admin.ch/lokalprognose/zug/6300.html#forecast-tab=wind-gust-peaks"
  }
];

console.log("Loading MeteoSwiss point metadata...");
const pointResponse = await fetch(POINTS);
if (!pointResponse.ok) throw new Error(`Point metadata unavailable (${pointResponse.status})`);
const pointText = new TextDecoder("iso-8859-1").decode(await pointResponse.arrayBuffer());
const pointRows = parseCsv(pointText);

const selectedLocations = LOCATIONS.map(location => ({
  ...location,
  point: getPoint(pointRows, location)
}));

const item = await getLatestItem();
const assetMap = pickLatestAssets(item.assets);

// Download each national parameter file only once, then extract all five points.
const seriesByLocation = Object.fromEntries(
  selectedLocations.map(location => [location.id, {}])
);

for (const param of PARAMS) {
  const href = assetMap[param];
  if (!href) throw new Error(`No latest asset found for ${param}`);

  console.log(`Downloading ${param}...`);
  const rows = await fetchCsv(href);

  for (const location of selectedLocations) {
    seriesByLocation[location.id][param] = extractPointSeries(
      rows,
      param,
      String(location.point.point_id),
      String(location.point.point_type_id)
    );
  }
}

const body = {
  source: "MeteoSwiss",
  updated_at: new Date().toISOString(),
  locations: selectedLocations.map(location => ({
    id: location.id,
    label: location.label,
    postcode: location.postcode,
    source_url: location.source_url,
    point_name: location.point.point_name,
    elevation_m: num(location.point.point_height_masl),
    latitude: num(location.point.point_latitude),
    longitude: num(location.point.point_longitude),
    forecast: mergeSeries(seriesByLocation[location.id]).slice(0, 120)
  }))
};

for (const location of body.locations) {
  if (!location.forecast.length) {
    throw new Error(`No forecast rows generated for ${location.label}`);
  }
  console.log(`${location.label}: ${location.forecast.length} rows`);
}

await fs.mkdir("docs", { recursive: true });
await fs.writeFile(
  "docs/forecast.json",
  JSON.stringify(body, null, 2) + "\n",
  "utf8"
);
console.log(`Wrote ${body.locations.length} locations to docs/forecast.json`);

async function getLatestItem() {
  for (let daysBack = 0; daysBack <= 2; daysBack++) {
    const d = new Date(Date.now() - daysBack * 86400000);
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(d);
    const v = Object.fromEntries(parts.map(p => [p.type, p.value]));
    const id = `${v.year}${v.month}${v.day}-ch`;
    const response = await fetch(`${STAC}/items/${id}`);
    if (response.ok) return response.json();
  }
  throw new Error("No recent MeteoSwiss STAC item available");
}

function pickLatestAssets(assets) {
  const keys = Object.keys(assets);

  // MeteoSwiss does not always publish every parameter at exactly the same
  // timestamp. Pick the newest available file independently for each
  // parameter instead of forcing one global run timestamp.
  return Object.fromEntries(
    PARAMS.map(param => {
      const candidates = keys
        .filter(key => key.includes(param))
        .map(key => ({
          key,
          run: (key.match(/\.(\d{12})\./) || [])[1] || ""
        }))
        .filter(item => item.run)
        .sort((a, b) => b.run.localeCompare(a.run));

      const latest = candidates[0];
      return [param, latest ? assets[latest.key].href : null];
    })
  );
}

function getPoint(rows, location) {
  const candidates = rows.filter(row =>
    String(row.postal_code || "").trim() === location.postcode &&
    String(row.point_type_id || "").trim() === "2"
  );

  const exact = candidates.find(row =>
    location.namePattern.test(String(row.point_name || "").trim())
  );

  const point = exact || candidates[0];
  if (!point) {
    throw new Error(`No MeteoSwiss point found for ${location.label} (${location.postcode})`);
  }

  console.log(`${location.label} uses MeteoSwiss point "${point.point_name}"`);
  return point;
}

async function fetchCsv(href) {
  const response = await fetch(href);
  if (!response.ok) throw new Error(`Forecast file unavailable (${response.status})`);
  const text = new TextDecoder("iso-8859-1").decode(await response.arrayBuffer());
  return parseCsv(text);
}

function extractPointSeries(rows, param, pointId, pointTypeId) {
  return rows
    .filter(row =>
      String(row.point_id || "").trim() === pointId &&
      String(row.point_type_id || "").trim() === pointTypeId
    )
    .map(row => {
      const timestamp =
        row.date ||
        row.time ||
        row.reference_timestamp ||
        row.reference_datetime ||
        Object.values(row).find(value => /^\d{12}$/.test(String(value).trim()));

      const rawValue =
        row[param] ??
        row.value ??
        Object.entries(row)
          .filter(([key, value]) =>
            ![
              "point_id", "point_type_id", "date", "time",
              "reference_timestamp", "reference_datetime"
            ].includes(key) &&
            value !== "" &&
            Number.isFinite(Number(String(value).replace(",", ".")))
          )
          .map(([, value]) => value)
          .at(-1);

      return {
        time: utcStampToIso(String(timestamp || "").trim()),
        value: num(rawValue)
      };
    })
    .filter(row => row.time && row.value !== null);
}

function mergeSeries(series) {
  const map = new Map();

  for (const [param, rows] of Object.entries(series)) {
    for (const row of rows) {
      if (!map.has(row.time)) map.set(row.time, { time: row.time });
      map.get(row.time)[param] = row.value;
    }
  }

  return [...map.values()]
    .sort((a, b) => a.time.localeCompare(b.time))
    .filter(row => new Date(row.time).getTime() >= Date.now() - 3600000)
    .map(row => ({
      time: row.time,
      direction_deg: row.dkl010h0 ?? null,
      wind_kmh: row.fu3010h0 ?? null,
      gust_kmh: row.fu3010h1 ?? null
    }));
}

function parseCsv(text) {
  const lines = text.replace(/\r/g, "").split("\n").filter(Boolean);
  if (!lines.length) return [];

  const headers = splitLine(lines[0]);
  return lines.slice(1).map(line => {
    const values = splitLine(line);
    const row = {};
    headers.forEach((header, index) => {
      row[header] = values[index] ?? "";
    });
    return row;
  });
}

function splitLine(line) {
  const values = [];
  let current = "";
  let quoted = false;

  for (let index = 0; index < line.length; index++) {
    const char = line[index];

    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index++;
      } else {
        quoted = !quoted;
      }
    } else if (char === ";" && !quoted) {
      values.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  values.push(current);
  return values;
}

function utcStampToIso(value) {
  if (!/^\d{12}$/.test(value)) return null;
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(8, 10)}:${value.slice(10, 12)}:00Z`;
}

function num(value) {
  if (value === undefined || value === null || value === "") return null;
  const result = Number(String(value).replace(",", "."));
  return Number.isFinite(result) ? result : null;
}
