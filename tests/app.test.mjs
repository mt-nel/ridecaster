import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

/** Loads the built page in jsdom, runs app.js for real and returns the window once it has loaded. */
async function loadPage(fetchImpl) {
  const file = fileURLToPath(new URL('../dist/index.html', import.meta.url));
  const options = { runScripts: 'dangerously', resources: 'usable' };
  if (fetchImpl) options.beforeParse = (window) => (window.fetch = fetchImpl);
  const dom = await JSDOM.fromFile(file, options);
  await new Promise((resolve) => dom.window.addEventListener('load', resolve));
  return dom.window;
}

const type = (window, id, value) => {
  const input = window.document.getElementById(id);
  input.value = value;
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
};
const text = (window, id) => window.document.getElementById(id).textContent;

test('page renders map, charts, summary and station table', async () => {
  const { document } = await loadPage();
  assert.ok(document.querySelectorAll('#map .route-segment').length > 200);
  for (const id of ['wind-chart', 'rain-chart', 'power-chart']) {
    assert.ok(document.querySelectorAll(`#${id} rect`).length > 50, id);
    assert.ok(document.querySelectorAll(`#${id} .tick-label`).length >= 3, `${id} has a y axis`);
  }
  assert.match(document.getElementById('summary').textContent, /average power/);
  assert.equal(document.querySelectorAll('#stations tr').length, 6);
  assert.equal(document.querySelectorAll('#speed-presets button').length, 7);
});

test('language selector translates static and generated content into Dutch', async () => {
  const window = await loadPage();
  window.document.querySelector('#language-control [data-language="nl"]').click();

  assert.equal(window.document.documentElement.lang, 'nl');
  assert.equal(
    window.document.querySelector('#language-control [data-language="nl"]').getAttribute('aria-pressed'),
    'true',
  );
  assert.equal(
    window.document.querySelector('#language-control [data-language="en"]').getAttribute('aria-pressed'),
    'false',
  );
  assert.equal(window.document.querySelector('h2').textContent, 'Tegenwind langs de route');
  assert.match(text(window, 'summary'), /Gemiddelde snelheid/);
  assert.match(text(window, 'readout'), /Temperatuur/);
  assert.equal(window.document.querySelector('#stations th').textContent, 'Post');
});

test('default scenario finishes in 24 hours', async () => {
  const window = await loadPage();
  assert.match(text(window, 'summary'), /24h 0\dm elapsed|24h 00m elapsed/);
});

test('loads live Yr forecasts for three route points', async () => {
  const requests = [];
  const window = await loadPage(async (url) => {
    requests.push(new URL(url));
    return {
      ok: true,
      json: async () => ({
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
                    wind_speed: 5,
                  },
                },
                next_1_hours: { details: { precipitation_amount: 0 } },
              },
            },
          ],
        },
      }),
    };
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(requests.length, 3);
  assert.ok(requests.every((url) => url.hostname === 'api.met.no'));
  assert.ok(requests.every((url) => /^-?\d+\.\d{4}$/.test(url.searchParams.get('lat'))));
  assert.match(text(window, 'weather-status'), /Live forecast from MET Norway/);
  assert.match(text(window, 'readout'), /12 °C/);
});

test('typing a power switches to power mode and computes the speed', async () => {
  const window = await loadPage();
  type(window, 'power', '200');
  const speed = Number(window.document.getElementById('speed').value);
  assert.ok(speed > 23 && speed < 28, `speed ${speed}`);
});

test('moving the slider updates the readout and cursor', async () => {
  const window = await loadPage();
  type(window, 'position', '250');
  assert.match(text(window, 'position-label'), /km 250\.0/);
  assert.ok(window.document.querySelector('#wind-chart .cursor').getAttribute('x1') > 36);
});

test('a date without forecast shows a notice instead of weather', async () => {
  const window = await loadPage();
  type(window, 'start-date', '2026-11-20');
  assert.match(text(window, 'readout'), /No forecast/);
});

test('rain colouring can be switched on', async () => {
  const window = await loadPage();
  window.document.querySelector('#map-mode [data-mode="rain"]').click();
  assert.match(text(window, 'legend'), /moderate/);
});
