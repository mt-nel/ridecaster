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

test('Yr forecast payload converts wind and precipitation into app units', () => {
  const samples = app.parseYrForecast({
    properties: {
      timeseries: [
        {
          time: '2026-10-10T12:00:00Z',
          data: {
            instant: {
              details: {
                air_temperature: 12,
                cloud_area_fraction: 45,
                wind_from_direction: 225,
                wind_speed: 5.14444,
                wind_speed_of_gust: 7.71666,
              },
            },
            next_6_hours: { details: { precipitation_amount: 2 } },
          },
        },
      ],
    },
  });
  assert.equal(samples.length, 1);
  assert.equal(samples[0].time, Date.parse('2026-10-10T12:00:00Z'));
  assert.equal(samples[0].windKts, 10);
  assert.equal(samples[0].gustKts, 15);
  assert.equal(samples[0].rainMm3h, 1);
  assert.equal(samples[0].tempC, 12);
  assert.equal(samples[0].cloudPct, 45);
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
