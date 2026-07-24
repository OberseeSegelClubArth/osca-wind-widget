const COLLECTION = "ch.meteoschweiz.ogd-local-forecasting";
const STAC = `https://data.geo.admin.ch/api/stac/v1/collections/${COLLECTION}`;
const POINTS = `https://data.geo.admin.ch/${COLLECTION}/ogd-local-forecasting_meta_point.csv`;
const TZ = "Europe/Zurich";
const PARAMS = ["dkl010h0", "fu3010h0", "fu3010h1"];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
    if (url.pathname !== "/forecast") {
      return cors(json({ ok: true, service: "OSCA MeteoSwiss wind proxy", endpoint: "/forecast" }));
    }

    try {
      const postcode = url.searchParams.get("postcode") || "6415";
      const hours = clamp(Number(url.searchParams.get("hours") || 72), 12, 120);
      const cacheKey = new Request(`${url.origin}/forecast?postcode=${encodeURIComponent(postcode)}&hours=${hours}`);
      const cache = caches.default;
      const cached = await cache.match(cacheKey);
      if (cached) return cached;

      const point = await getPoint(postcode);
      const item = await getTodayItem();
      const assetMap = pickLatestAssets(item.assets);

      const series = {};
      for (const param of PARAMS) {
        const href = assetMap[param];
        if (!href) throw new Error(`No latest asset found for ${param}`);
        series[param] = await fetchPoiSeries(href, param, String(point.point_id), String(point.point_type_id));
      }

      const merged = mergeSeries(series).slice(0, hours);
      const body = {
        source: "MeteoSwiss",
        source_url: "https://www.meteoschweiz.admin.ch/lokalprognose/arth/6415.html#forecast-tab=wind-gust-peaks",
        location: {
          name: point.point_name || "Arth",
          postcode,
          elevation_m: num(point.point_height_masl),
          latitude: num(point.point_latitude),
          longitude: num(point.point_longitude)
        },
        updated_at: new Date().toISOString(),
        forecast: merged
      };

      const response = cors(json(body, {
        headers: { "Cache-Control": "public, max-age=900, s-maxage=1800" }
      }));
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
      return response;
    } catch (error) {
      return cors(json({ error: error.message || String(error) }, { status: 500 }));
    }
  }
};

async function getTodayItem() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date());
  const val = Object.fromEntries(parts.map(p => [p.type, p.value]));
  const id = `${val.year}${val.month}${val.day}-ch`;

  let r = await fetch(`${STAC}/items/${id}`);
  if (r.ok) return r.json();

  // Midnight/publication fallback: inspect yesterday's item.
  const yesterday = new Date(Date.now() - 86400000);
  const yp = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(yesterday);
  const yv = Object.fromEntries(yp.map(p => [p.type, p.value]));
  r = await fetch(`${STAC}/items/${yv.year}${yv.month}${yv.day}-ch`);
  if (!r.ok) throw new Error(`MeteoSwiss STAC item unavailable (${r.status})`);
  return r.json();
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
  const text = decodeLatin1(await r.arrayBuffer());
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
  const text = decodeLatin1(await r.arrayBuffer());
  const rows = parseCsv(text);

  return rows
    .filter(x => String(x.point_id).trim() === pointId &&
                 String(x.point_type_id).trim() === pointTypeId)
    .map(x => ({
      time: utcStampToIso(String(x.date || x.time || "")),
      value: num(x[param])
    }))
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
  // MeteoSwiss CSV is semicolon-delimited. This handles quoted fields.
  const out = []; let cur = ""; let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (quoted && line[i + 1] === '"') { cur += '"'; i++; }
      else quoted = !quoted;
    } else if (c === ";" && !quoted) {
      out.push(cur); cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

function utcStampToIso(s) {
  if (!/^\d{12}$/.test(s)) return null;
  const y=s.slice(0,4), m=s.slice(4,6), d=s.slice(6,8), h=s.slice(8,10), min=s.slice(10,12);
  return `${y}-${m}-${d}T${h}:${min}:00Z`;
}

function decodeLatin1(buf) {
  return new TextDecoder("iso-8859-1").decode(buf);
}
function num(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}
function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function json(data, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { ...init, headers });
}
function cors(response) {
  const h = new Headers(response.headers);
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type");
  return new Response(response.body, { status: response.status, headers: h });
}