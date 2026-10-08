import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const app = require('../src/app.js');

const dist = readFileSync(new URL('../dist/index.html', import.meta.url), 'utf8');
const block = (id) => dist.match(new RegExp(`id="${id}">([\\s\\S]*?)</script>`))[1];
const route = app.createRoute(JSON.parse(block('route-data')));
const weather = app.createWeather(app.parseForecast(block('forecast-data')));
const rider = { massKg: 86, cda: 0.33, crr: 0.0045 };
const plan = {
  mode: 'speed',
  speedKmh: 22.91,
  powerW: 150,
  startTime: Date.UTC(2026, 9, 10, 12, 0),
  stopsKm: [109, 211, 321, 402],
  stopMinutes: 30,
  rider,
  windShare: 0.7,
};

test('route is about 504 km with sensible segments', () => {
  assert.ok(Math.abs(route.totalKm - 504) < 2);
  assert.equal(route.segments.length, Math.ceil(route.totalKm));
  assert.ok(route.segments.every((s) => Math.abs(s.grade) <= 0.06));
});

test('route heads south-west on average', () => {
  const mean = route.segments.reduce((sum, s) => sum + s.bearing, 0) / route.segments.length;
  assert.ok(mean > 200 && mean < 240);
});

test('powerAtSpeed and speedAtPower are inverses', () => {
  const speed = 7;
  const power = app.powerAtSpeed(speed, 3, 0.01, rider);
  assert.ok(Math.abs(app.speedAtPower(power, 3, 0.01, rider) - speed) < 1e-3);
});

test('a headwind needs more power than a tailwind', () => {
  assert.ok(app.powerAtSpeed(7, 5, 0, rider) > app.powerAtSpeed(7, -5, 0, rider));
});

test('wind direction blends through north', () => {
  const a = { dir: 350, windKts: 10, gustKts: 10, tempC: 10, rainMm3h: 0, cloudPct: 0 };
  const mixed = app.blendSamples(a, { ...a, dir: 10 }, 0.5);
  assert.ok(mixed.dir < 1 || mixed.dir > 359);
});

test('forecast lookup returns null far outside the forecast', () => {
  assert.equal(weather.at(100, Date.UTC(2026, 9, 1)), null);
  assert.ok(weather.at(100, Date.UTC(2026, 9, 10, 15)));
});

test('24 h scenario: 22.91 km/h with four 30 min stops finishes in 24 h', () => {
  const ride = app.simulate(route, weather, plan);
  const elapsedHours = (ride.times.at(-1) - plan.startTime) / 3_600_000;
  assert.ok(Math.abs(elapsedHours - 24) < 0.05);
  assert.ok(ride.averagePowerW > 120 && ride.averagePowerW < 200);
});

test('stops add exactly their length to the elapsed time', () => {
  const without = app.simulate(route, weather, { ...plan, stopsKm: [] });
  const withStops = app.simulate(route, weather, plan);
  assert.ok(Math.abs(withStops.times.at(-1) - without.times.at(-1) - 4 * 30 * 60_000) < 1);
});

test('power mode is slower into the wind than in calm air', () => {
  const windy = app.simulate(route, weather, { ...plan, mode: 'power', powerW: 150 });
  const calm = app.simulate(route, weather, { ...plan, mode: 'power', powerW: 150, windShare: 0 });
  assert.ok(windy.ridingHours > calm.ridingHours);
});

test('stationStatus reports early, ok and late', () => {
  const midnight = Date.UTC(2026, 9, 10);
  const station = { opens: 15, closes: 17 };
  assert.equal(app.stationStatus(midnight + 14 * 3_600_000, midnight, station).state, 'early');
  assert.equal(app.stationStatus(midnight + 16 * 3_600_000, midnight, station).state, 'ok');
  assert.deepEqual(app.stationStatus(midnight + 18 * 3_600_000, midnight, station), { state: 'late', minutes: 60 });
});

test('formatDuration rolls minutes over correctly', () => {
  assert.equal(app.formatDuration(1.999), '2h 00m');
  assert.equal(app.formatDuration(22.5), '22h 30m');
});

const sampleResponse = (extra = {}) => ({
  hourly: {
    time: ['2026-10-10T11:00', '2026-10-10T12:00', '2026-10-10T13:00'],
    wind_speed_10m: [10, 12, null],
    wind_direction_10m: [270, 250, null],
    wind_gusts_10m: [15, 18, null],
    temperature_2m: [12, 13, null],
    precipitation: [0, 0.5, null],
    cloud_cover: [40, 60, null],
    ...extra,
  },
});

test('parseOpenMeteo converts units, skips empty hours and handles one or many locations', () => {
  const one = app.parseOpenMeteo(sampleResponse(), [0]);
  assert.equal(one.get(0).length, 2);
  assert.equal(one.get(0)[1].time, Date.UTC(2026, 9, 10, 12));
  assert.equal(one.get(0)[1].rainMm3h, 1.5);
  assert.equal(one.get(0)[1].windKts, 12);
  const many = app.parseOpenMeteo([sampleResponse(), sampleResponse()], [0, 100]);
  assert.deepEqual([...many.keys()], [0, 100]);
});

test('parseOpenMeteo accepts model-suffixed variable names', () => {
  const response = sampleResponse();
  response.hourly.wind_speed_10m_knmi_seamless = response.hourly.wind_speed_10m;
  delete response.hourly.wind_speed_10m;
  assert.equal(app.parseOpenMeteo(response, [0]).get(0)[0].windKts, 10);
});

test('buildOpenMeteoUrl asks for the KNMI model in knots and local time', () => {
  const url = new URL(
    app.buildOpenMeteoUrl(
      [
        { lat: 53.3374, lon: 6.2988 },
        { lat: 51.5, lon: 3.48 },
      ],
      '2026-10-10',
    ),
  );
  assert.equal(url.origin + url.pathname, 'https://api.open-meteo.com/v1/forecast');
  assert.equal(url.searchParams.get('models'), 'knmi_seamless');
  assert.equal(url.searchParams.get('wind_speed_unit'), 'kn');
  assert.equal(url.searchParams.get('timezone'), 'Europe/Amsterdam');
  assert.equal(url.searchParams.get('latitude'), '53.3374,51.5000');
  assert.equal(url.searchParams.get('start_date'), '2026-10-10');
  assert.equal(url.searchParams.get('end_date'), '2026-10-12');
});

test('forecastPointKms spreads points from start to finish', () => {
  const kms = app.forecastPointKms(504);
  assert.equal(kms.length, 7);
  assert.deepEqual([kms[0], kms.at(-1)], [0, 504]);
});

test('fetchOpenMeteoForecast returns samples, and throws readable errors', async () => {
  const ok = async () => ({ ok: true, status: 200, json: async () => Array(7).fill(sampleResponse()) });
  assert.equal((await app.fetchOpenMeteoForecast(route, '2026-10-10', 'knmi', ok)).size, 7);
  const bad = async () => ({
    ok: false,
    status: 400,
    json: async () => ({ error: true, reason: 'date out of range' }),
  });
  await assert.rejects(app.fetchOpenMeteoForecast(route, '2026-10-10', 'knmi', bad), /date out of range/);
  const empty = async () => ({ ok: true, status: 200, json: async () => Array(7).fill({ hourly: { time: [] } }) });
  await assert.rejects(app.fetchOpenMeteoForecast(route, '2026-10-10', 'knmi', empty), /no data/);
});

test('toForecastCsv round-trips through parseForecast', () => {
  const byKm = app.parseOpenMeteo(sampleResponse(), [171]);
  const again = app.parseForecast(app.toForecastCsv(byKm));
  assert.equal(again.get(171).length, 2);
  assert.equal(again.get(171)[1].rainMm3h, 1.5);
  assert.equal(again.get(171)[1].time, byKm.get(171)[1].time);
});

test('the GFS source asks Open-Meteo for the GFS global model', async () => {
  let requested;
  const spy = async (url) => {
    requested = new URL(url);
    return { ok: true, status: 200, json: async () => Array(7).fill(sampleResponse()) };
  };
  await app.fetchOpenMeteoForecast(route, '2026-10-10', 'gfs', spy);
  assert.equal(requested.searchParams.get('models'), 'gfs_global');
  assert.equal(requested.searchParams.get('wind_speed_unit'), 'kn');
});

test('temperatureColour runs from blue (cold) to red (warm) and flags missing data', () => {
  const channels = (colour) => colour.match(/\d+/g).map(Number);
  const [coldR, , coldB] = channels(app.temperatureColour(-5));
  const [warmR, , warmB] = channels(app.temperatureColour(30));
  assert.ok(coldB > coldR && warmR > warmB);
  assert.deepEqual(channels(app.temperatureColour(0)), channels(app.temperatureColour(-10)));
  assert.equal(app.temperatureColour(null), '#8a9a9c');
});

test('fitTemperatureScale keeps a minimum span so small differences stay visible', () => {
  const scale = app.fitTemperatureScale([11, 14]);
  assert.ok(scale.high - scale.low >= 6);
  assert.equal((scale.low + scale.high) / 2, 12.5);
  const channels = (colour) => colour.match(/\d+/g).map(Number);
  assert.notDeepEqual(channels(app.temperatureColour(11, scale)), channels(app.temperatureColour(14, scale)));
});

const translations = JSON.parse(readFileSync(new URL('../data/translations.json', import.meta.url), 'utf8'));
const placeholders = (text) =>
  [...text.matchAll(/\{(\w+)\}/g)]
    .map((m) => m[1])
    .sort()
    .join(',');

test('detectLanguage prefers a stored choice, then the browser, then English', () => {
  const supported = ['nl', 'en'];
  assert.equal(app.detectLanguage('nl', ['en-US'], supported), 'nl');
  assert.equal(app.detectLanguage(null, ['nl-NL', 'en'], supported), 'nl');
  assert.equal(app.detectLanguage(null, ['fr-FR', 'nl'], supported), 'nl');
  assert.equal(app.detectLanguage('de', ['de-DE'], supported), 'en');
  assert.equal(app.detectLanguage(null, [], supported), 'en');
});

test('createTranslator fills placeholders and falls back to English, then to the key', () => {
  const t = app.createTranslator({ en: { a: 'Hello {name}', b: 'Only English' }, nl: { a: 'Hallo {name}' } }, 'nl');
  assert.equal(t('a', { name: 'Anna' }), 'Hallo Anna');
  assert.equal(t('b'), 'Only English');
  assert.equal(t('missing.key'), 'missing.key');
  assert.equal(t('a'), 'Hallo {name}');
});

test('both languages have the same keys, no empty text, and the same placeholders', () => {
  const { en, nl } = translations;
  assert.deepEqual(Object.keys(nl).sort(), Object.keys(en).sort());
  for (const key of Object.keys(en)) {
    assert.ok(en[key].trim() && nl[key].trim(), `${key} is empty`);
    assert.equal(placeholders(nl[key]), placeholders(en[key]), `${key} placeholders differ`);
  }
  assert.equal(en.compass.split(',').length, 16);
  assert.equal(nl.compass.split(',').length, 16);
});

test('formatDuration can use a translated format', () => {
  assert.equal(
    app.formatDuration(22.5, ({ h, m }) => `${h} u ${m} min`),
    '22 u 30 min',
  );
});
