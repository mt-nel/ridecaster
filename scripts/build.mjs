#!/usr/bin/env node
/**
 * Builds dist/:
 *   index.html       page that links styles.css and app.js
 *   styles.css, app.js
 *   standalone.html  the same page with CSS and JS inlined (one file to email or host anywhere)
 *
 * Inputs: data/route.gpx (resampled to ~1 km), data/stations.json, data/boundaries.json, data/translations.json, data/forecast.csv, src/*.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(root, path), 'utf8');

const EARTH_RADIUS_KM = 6371.0088;
const FINE_STEP_KM = 0.4;
const COARSE_STEP_KM = 1;
const ELEVATION_SMOOTHING_RADIUS = 3;

function parseGpx(gpx) {
  const pattern = /<trkpt lat="([\d.-]+)" lon="([\d.-]+)">\s*<ele>([\d.-]+)<\/ele>/g;
  return [...gpx.matchAll(pattern)].map((m) => ({ lat: Number(m[1]), lon: Number(m[2]), ele: Number(m[3]) }));
}

function haversineKm(a, b) {
  const toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLon = (b.lon - a.lon) * toRad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

/** Keeps a point every `stepKm`, always keeping the last one. Points carry their cumulative `km`. */
function thin(points, stepKm) {
  const kept = [];
  let next = 0;
  points.forEach((point, i) => {
    if (point.km >= next || i === points.length - 1) {
      kept.push(point);
      next = point.km + stepKm;
    }
  });
  return kept;
}

function buildRoute(gpx) {
  const raw = parseGpx(gpx);
  let km = 0;
  const withKm = raw.map((point, i) => {
    if (i > 0) km += haversineKm(raw[i - 1], point);
    return { ...point, km };
  });
  const coarse = thin(thin(withKm, FINE_STEP_KM), COARSE_STEP_KM);
  return coarse.map((point, i, all) => {
    const window = all.slice(Math.max(0, i - ELEVATION_SMOOTHING_RADIUS), i + ELEVATION_SMOOTHING_RADIUS + 1);
    const ele = window.reduce((sum, p) => sum + Math.round(p.ele), 0) / window.length;
    return [
      Number(point.lat.toFixed(4)),
      Number(point.lon.toFixed(4)),
      Number(point.km.toFixed(1)),
      Number(ele.toFixed(1)),
    ];
  });
}

/** Replaces the contents of <script ... id="..."> with `content` (function form avoids `$` patterns). */
function fillDataBlock(html, id, content) {
  const pattern = new RegExp(`(<script[^>]*id="${id}"[^>]*>)[\\s\\S]*?(</script>)`);
  if (!pattern.test(html)) throw new Error(`data block #${id} not found in src/index.html`);
  return html.replace(pattern, (_, open, close) => open + content + close);
}

const route = buildRoute(read('data/route.gpx'));
let page = read('src/index.html');
page = fillDataBlock(page, 'route-data', JSON.stringify(route));
page = fillDataBlock(page, 'stations-data', JSON.stringify(JSON.parse(read('data/stations.json'))));
page = fillDataBlock(page, 'boundaries-data', JSON.stringify(JSON.parse(read('data/boundaries.json'))));
page = fillDataBlock(page, 'translations-data', JSON.stringify(JSON.parse(read('data/translations.json'))));
page = fillDataBlock(page, 'forecast-data', read('data/forecast.csv'));

const css = read('src/styles.css');
const js = read('src/app.js');
const dist = join(root, 'dist');
mkdirSync(dist, { recursive: true });
writeFileSync(join(dist, 'index.html'), page);
copyFileSync(join(root, 'src/styles.css'), join(dist, 'styles.css'));
copyFileSync(join(root, 'src/app.js'), join(dist, 'app.js'));

const standalone = page
  .replace('<link rel="stylesheet" href="styles.css" />', () => `<style>\n${css}</style>`)
  .replace('<script src="app.js"></script>', () => `<script>\n${js}</script>`);
writeFileSync(join(dist, 'standalone.html'), standalone);

console.log(
  `route: ${route.at(-1)[2]} km, ${route.length} points -> dist/ (${Math.round(standalone.length / 1024)} KB standalone)`,
);
