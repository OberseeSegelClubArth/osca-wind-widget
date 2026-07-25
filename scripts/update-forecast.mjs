import fs from "node:fs/promises";

const COLLECTION = "ch.meteoschweiz.ogd-local-forecasting";
const STAC = `https://data.geo.admin.ch/api/stac/v1/collections/${COLLECTION}`;
const POINTS = `https://data.geo.admin.ch/${COLLECTION}/ogd-local-forecasting_meta_point.csv`;
const TZ = "Europe/Zurich";
const PARAMS = ["dkl010h0", "fu3010h0", "fu3010h1"];
const POSTCODE = "6415";

const point = await getPoint(POSTCODE);
const item = await getLatestItem();
const assetMap = pickLatestAssets(item.assets);

const series = {};
for (const param of PARAMS) {
  const href = assetMap[param];
  if (!href) throw new Error(`No latest asset found for ${param}`);
  series[param] = await fetchPoiSeries(
    href, param, String(point.point_id), String(point.point_type_id)
  );
}

const body = {
  source: "MeteoSwiss",
  source_url: "https://www.meteoschweiz.admin.ch/lokalprognose/arth/6415.html#forecast-tab=wind-gust-peaks",
  location: {
    name: point.point_name || "Arth",
    postcode: POSTCODE,
    elevation_m: num(point.point_height_masl),
    latitude: num(point.point_latitude),
    longitude: num(point.point_longitude)
  },
  updated_at: new Date().toISOString(),
  forecast: mergeSeries(series).slice(0, 120)
};

await fs.mkdir("docs", { recursive: true });
await fs.writeFile("docs/forecast.json", JSON.stringify(body, null, 2) + "\n", "utf8");
console.log(`Wrote ${body.forecast.length} forecast rows to docs/forecast.json`);

async function getLatestItem() {
  for (let daysBack = 0; daysBack <= 2; daysBack++) {
    const d = new Date(Date.now() - daysBack * 86400000);
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit"
    }).formatToParts(d);
    const v = Object.fromEntries(parts.map(p => [p.type, p.value]));
    const id = `${v.year}${v.month}${v.day}-ch`;
    const r = await fetch(`${STAC}/items/${id}`);
    if (r.ok) return r.json();
  }
  throw new Error("No recent MeteoSwiss STAC item available");
}

function pickLatestAssets(assets) {
  const keys = Object.keys(assets);
  const runs = keys
    .map(k => (k.match(/\.(\d{12})\./) || [])[1])
    .filter(Boolean)
    .sort();
  if (!runs.length) throw new Error("Could not identify MeteoSwiss forecast run");
  const latest = runs[runs.length - 1];

  const out = {};
  for (const param of PARAMS) {
    const key = keys.find(k => k.includes(param) && k.includes(`.${latest}.`));
    if (key) out[param] = assets[key].href;
  }
  return out;
}

async function getPoint(postcode) {
  const r = await fetch(POINTS);
  if (!r.ok) throw new Error(`Point metadata unavailable (${r.status})`);
  const text = new TextDecoder("iso-8859-1").decode(await r.arrayBuffer());
  const rows = parseCsv(text);
  const exact = rows.find(x =>
    String(x.postal_code || "").trim() === String(postcode) &&
    String(x.point_type_id || "").trim() === "2" &&
    /arth/i.test(String(x.point_name || ""))
  );
  const fallback = rows.find(x =>
    String(x.postal_code || "").trim() === String(postcode) &&
    String(x.point_type_id || "").trim() === "2"
  );
  const point = exact || fallback;
  if (!point) throw new Error(`No MeteoSwiss forecast point found for postcode ${postcode}`);
  return point;
}

async function fetchPoiSeries(href, param, pointId, pointTypeId) {
  const r = await fetch(href);
  if (!r.ok) throw new Error(`${param} unavailable (${r.status})`);
  const text = new TextDecoder("iso-8859-1").decode(await r.arrayBuffer());
  const rows = parseCsv(text);

  return rows
    .filter(x =>
      String(x.point_id).trim() === pointId &&
      String(x.point_type_id).trim() === pointTypeId
    )
    .map(x => {
      const timestamp =
        x.date ||
        x.time ||
        x.reference_timestamp ||
        x.reference_datetime ||
        Object.values(x).find(v => /^\\d{12}$/.test(String(v).trim()));

      const rawValue =
        x[param] ??
        x.value ??
        Object.entries(x)
          .filter(([key, value]) =>
            !["point_id", "point_type_id", "date", "time",
              "reference_timestamp", "reference_datetime"].includes(key) &&
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
    .filter(x => x.time && x.value !== null);
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
    .filter(x => new Date(x.time).getTime() >= Date.now() - 3600000)
    .map(x => ({
      time: x.time,
      direction_deg: x.dkl010h0 ?? null,
      wind_kmh: x.fu3010h0 ?? null,
      gust_kmh: x.fu3010h1 ?? null
    }));
}

function parseCsv(text) {
  const lines = text.replace(/\r/g, "").split("\n").filter(Boolean);
  if (!lines.length) return [];
  const headers = splitLine(lines[0]);
  return lines.slice(1).map(line => {
    const vals = splitLine(line);
    const obj = {};
    headers.forEach((h, i) => obj[h] = vals[i] ?? "");
    return obj;
  });
}

function splitLine(line) {
  const out = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (c === ";" && !quoted) {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

function utcStampToIso(s) {
  if (!/^\d{12}$/.test(s)) return null;
  return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}T${s.slice(8,10)}:${s.slice(10,12)}:00Z`;
}

function num(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}