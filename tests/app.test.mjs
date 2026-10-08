import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

/** A KNMI-shaped Open-Meteo answer: three days of steady west wind for every requested location. */
function fakeOpenMeteo(url) {
  const query = new URL(url).searchParams;
  const count = query.get('latitude').split(',').length;
  const start = Date.parse(`${query.get('start_date')}T00:00:00Z`);
  const time = Array.from({ length: 72 }, (_, h) => new Date(start + h * 3_600_000).toISOString().slice(0, 13) + ':00');
  const fill = (value) => time.map(() => value);
  const location = () => ({
    hourly: {
      time,
      wind_speed_10m: fill(12),
      wind_direction_10m: fill(270),
      wind_gusts_10m: fill(18),
      temperature_2m: fill(12),
      precipitation: fill(0.2),
      cloud_cover: fill(60),
    },
  });
  return count === 1 ? location() : Array.from({ length: count }, location);
}

/**
 * Loads the built page in jsdom and runs app.js for real. `fetch` is mocked; every requested URL is recorded.
 * @returns {Promise<{window: Window, urls: string[]}>}
 */
async function loadPage({ failing = false, storage, languages } = {}) {
  const urls = [];
  const fetch = async (url) => {
    urls.push(url);
    if (failing) throw new Error('network down');
    return { ok: true, status: 200, json: async () => fakeOpenMeteo(url) };
  };
  const file = fileURLToPath(new URL('../dist/index.html', import.meta.url));
  const dom = await JSDOM.fromFile(file, {
    runScripts: 'dangerously',
    resources: 'usable',
    beforeParse: (window) => {
      window.fetch = fetch;
      if (storage) Object.defineProperty(window, 'localStorage', { value: storage, configurable: true });
      if (languages) Object.defineProperty(window.navigator, 'languages', { value: languages, configurable: true });
    },
  });
  await new Promise((resolve) => dom.window.addEventListener('load', resolve));
  await settle();
  return { window: dom.window, urls };
}

const type = (window, id, value) => {
  const input = window.document.getElementById(id);
  input.value = value;
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
};
const choose = (window, id, value) => {
  const select = window.document.getElementById(id);
  select.value = value;
  select.dispatchEvent(new window.Event('change', { bubbles: true }));
};

const text = (window, id) => window.document.getElementById(id).textContent;

test('page renders map, charts, summary and station table', async () => {
  const { window } = await loadPage();
  const { document } = window;
  assert.ok(document.querySelectorAll('#map .route-segment').length > 200);
  for (const id of ['wind-chart', 'rain-chart', 'power-chart']) {
    assert.ok(document.querySelectorAll(`#${id} rect`).length > 50, id);
    assert.ok(document.querySelectorAll(`#${id} .tick-label`).length >= 3, `${id} has a y axis`);
  }
  assert.match(document.getElementById('summary').textContent, /average power/);
  assert.equal(document.querySelectorAll('#stations tr').length, 6);
  assert.equal(document.querySelectorAll('#speed-presets button').length, 7);
});

test('default scenario finishes in 24 hours', async () => {
  const { window } = await loadPage();
  assert.match(text(window, 'summary'), /24h 0\dm elapsed|24h 00m elapsed/);
});

test('typing a power switches to power mode and computes the speed', async () => {
  const { window } = await loadPage();
  type(window, 'wind-share', '0');
  type(window, 'power', '200');
  const speed = Number(window.document.getElementById('speed').value);
  assert.ok(speed > 30 && speed < 36, `speed ${speed}`);
});

test('moving the slider updates the readout and cursor', async () => {
  const { window } = await loadPage();
  type(window, 'position', '250');
  assert.match(text(window, 'position-label'), /km 250\.0/);
  assert.ok(window.document.querySelector('#wind-chart .cursor').getAttribute('x1') > 36);
});

test('a date without forecast shows a notice instead of weather', async () => {
  const { window } = await loadPage();
  choose(window, 'forecast-source', 'yr');
  type(window, 'start-date', '2026-11-20');
  assert.match(text(window, 'readout'), /No forecast/);
});

test('rain colouring can be switched on', async () => {
  const { window } = await loadPage();
  window.document.querySelector('#map-mode [data-mode="rain"]').click();
  assert.match(text(window, 'legend'), /moderate/);
});

test('KNMI via Open-Meteo is the default source', async () => {
  const { window, urls } = await loadPage();
  assert.equal(window.document.getElementById('forecast-source').value, 'knmi');
  assert.equal(urls.length, 1);
  assert.match(urls[0], /models=knmi_seamless/);
  assert.match(text(window, 'forecast-status'), /KNMI HARMONIE/);
  assert.match(window.document.getElementById('forecast-text').value, /^km,date,hour/);
  assert.doesNotMatch(text(window, 'readout'), /No forecast/);
  assert.ok(window.document.querySelectorAll('#map .station-dot').length === 7);
});

test('falls back to the saved Yr forecast when the KNMI request fails', async () => {
  const { window } = await loadPage({ failing: true });
  assert.match(text(window, 'forecast-status'), /unavailable \(network down\).*Yr\.no/);
  assert.doesNotMatch(text(window, 'readout'), /No forecast/);
});

test('choosing Yr uses the saved data without a network request', async () => {
  const { window, urls } = await loadPage();
  choose(window, 'forecast-source', 'yr');
  await settle();
  assert.equal(urls.length, 1);
  assert.match(text(window, 'forecast-status'), /Yr\.no \/ MET Norway/);
  assert.equal(window.document.querySelectorAll('#map .station-dot').length, 3);
});

test('changing the start date reloads KNMI for the new dates', async () => {
  const { window, urls } = await loadPage();
  type(window, 'start-date', '2026-10-12');
  await settle(700);
  assert.equal(urls.length, 2);
  assert.match(urls[1], /start_date=2026-10-12/);
  assert.match(urls[1], /end_date=2026-10-14/);
});

test('pasted data replaces the forecast and selects the custom source', async () => {
  const { window } = await loadPage();
  window.document.getElementById('forecast-text').value = '0,2026-10-10,12,270,30,40,10,0,50';
  window.document.getElementById('apply-forecast').click();
  await settle();
  assert.equal(window.document.getElementById('forecast-source').value, 'custom');
  assert.match(text(window, 'forecast-status'), /Pasted data/);
  assert.match(text(window, 'readout'), /56 km\/h/);
});

test('GFS, the model behind Windfinder, can be chosen and is fetched live', async () => {
  const { window, urls } = await loadPage();
  choose(window, 'forecast-source', 'gfs');
  await settle();
  assert.equal(urls.length, 2);
  assert.match(urls[1], /models=gfs_global/);
  assert.match(text(window, 'forecast-status'), /GFS.*Windfinder/);
  assert.doesNotMatch(text(window, 'readout'), /No forecast/);
});

test('the forecast box links to Windfinder at every forecast point', async () => {
  const { window } = await loadPage();
  const links = [...window.document.querySelectorAll('#windfinder-points a')];
  assert.equal(links.length, 7);
  assert.match(links[0].href, /windfinder\.com\/#9\/53\.3\d+\/6\.2\d+/);
});

test('the map shows country and province outlines under the route', async () => {
  const { window } = await loadPage();
  const { document } = window;
  assert.equal(document.querySelectorAll('#map .country-fill').length, 3);
  assert.equal(document.querySelectorAll('#map .country-line').length, 3);
  assert.equal(document.querySelectorAll('#map .province').length, 12);
  const labels = [...document.querySelectorAll('#map .province-label')].map((node) => node.textContent);
  for (const name of ['Friesland', 'Flevoland', 'Zeeland']) assert.ok(labels.includes(name), name);
  const children = [...document.getElementById('map').children];
  const firstRoute = children.findIndex((node) => node.classList.contains('route-base'));
  const lastOutline = children.findLastIndex((node) => node.classList.contains('province-label'));
  assert.ok(lastOutline < firstRoute, 'outlines are drawn below the route');
  assert.match(text(window, 'legend'), /province.*country border/);
});

test('a temperature chart with its own axis is drawn', async () => {
  const { document } = (await loadPage()).window;
  const chart = document.getElementById('temperature-chart');
  assert.ok(chart.querySelectorAll('rect').length > 50);
  const ticks = [...chart.querySelectorAll('.tick-label')].map((node) => Number(node.textContent));
  assert.ok(ticks.length >= 3 && ticks[0] === 0, ticks.join());
  assert.match(chart.querySelector('.chart-label').textContent, /temperature, °C · 12 to 12 °C/);
});

test('the map can be coloured by temperature', async () => {
  const { window } = await loadPage();
  choose(window, 'forecast-source', 'yr');
  await settle();
  window.document.querySelector('#map-mode [data-mode="temperature"]').click();
  const strokes = new Set(
    [...window.document.querySelectorAll('#map .route-segment')].map((n) => n.getAttribute('stroke')),
  );
  assert.ok(strokes.size > 1, 'temperature varies along the route');
  assert.match(text(window, 'legend'), /\d+ °C.*\d+ °C.*\d+ °C/);
  assert.match(window.document.getElementById('map').getAttribute('aria-label'), /temperature/);
  assert.match(text(window, 'summary'), /Temperature \d+ to \d+ °C/);
});

const translations = JSON.parse(readFileSync(new URL('../data/translations.json', import.meta.url), 'utf8'));
const clickLanguage = async (window, language) => {
  window.document.querySelector(`.lang-switch [data-lang="${language}"]`).click();
  await settle();
};
const fakeStorage = (initial = {}) => {
  const values = { ...initial };
  return { getItem: (key) => values[key] ?? null, setItem: (key, value) => (values[key] = String(value)), values };
};
const squash = (value) => value.replace(/\s+/g, ' ').trim();

test('the page starts in English with a flag button for each language', async () => {
  const { window } = await loadPage();
  const { document } = window;
  assert.equal(document.documentElement.lang, 'en');
  const buttons = [...document.querySelectorAll('.lang-switch button')];
  assert.deepEqual(
    buttons.map((b) => b.dataset.lang),
    ['nl', 'en'],
  );
  assert.ok(
    buttons.every((b) => b.querySelector('svg')),
    'flags are inline SVG',
  );
  assert.deepEqual(
    buttons.map((b) => b.getAttribute('aria-pressed')),
    ['false', 'true'],
  );
  assert.equal(text(window, 'forecast-status').includes('KNMI HARMONIE (2 km)'), true);
});

test('choosing the Dutch flag translates the whole page', async () => {
  const { window } = await loadPage();
  await clickLanguage(window, 'nl');
  const { document } = window;
  assert.equal(document.documentElement.lang, 'nl');
  assert.equal(document.title, translations.nl['page.title']);
  assert.equal(document.querySelector('h1').textContent, translations.nl['header.title']);
  assert.equal(document.querySelector('.lang-switch [data-lang="nl"]').getAttribute('aria-pressed'), 'true');
  assert.match(text(window, 'summary'), /Gemiddelde snelheid.*gemiddeld vermogen/);
  assert.match(text(window, 'readout'), /Rijrichting .*wind uit/);
  assert.match(text(window, 'legend'), /tegenwind.*rugwind/);
  assert.match(document.getElementById('map').getAttribute('aria-label'), /Routekaart gekleurd op tegenwind/);
  assert.match(document.querySelector('#wind-chart .chart-label').textContent, /tegenwind, km\/u/);
  assert.match(text(window, 'stations'), /Post.*Jij komt aan/);
  assert.match(text(window, 'stations'), /Zoutelande \(finish\)/);
  assert.match(text(window, 'forecast-status'), /KNMI HARMONIE \(2 km\).*Beslaat/);
  assert.equal([...document.querySelectorAll('#speed-presets button')].at(-1).textContent, '24 u finish');
  assert.match(text(window, 'position-label'), /okt/);
  assert.equal(document.querySelector('option[value="knmi"]').textContent, translations.nl['source.option.knmi']);
});

test('switching back to English restores the English text', async () => {
  const { window } = await loadPage();
  await clickLanguage(window, 'nl');
  await clickLanguage(window, 'en');
  assert.equal(window.document.documentElement.lang, 'en');
  assert.equal(window.document.querySelector('h1').textContent, translations.en['header.title']);
  assert.match(text(window, 'summary'), /average power/);
});

test('the language choice is stored and used on the next visit', async () => {
  const storage = fakeStorage();
  const first = await loadPage({ storage });
  await clickLanguage(first.window, 'nl');
  assert.equal(storage.values['coast-to-coast-language'], 'nl');
  const second = await loadPage({ storage });
  assert.equal(second.window.document.documentElement.lang, 'nl');
  assert.match(text(second.window, 'summary'), /Gemiddelde snelheid/);
});

test('a Dutch browser starts in Dutch without storing anything', async () => {
  const storage = fakeStorage();
  const { window } = await loadPage({ storage, languages: ['nl-NL', 'nl'] });
  assert.equal(window.document.documentElement.lang, 'nl');
  assert.deepEqual(storage.values, {});
});

test('the forecast status is retranslated after a failed live request too', async () => {
  const { window } = await loadPage({ failing: true });
  await clickLanguage(window, 'nl');
  assert.match(text(window, 'forecast-status'), /KNMI-voorspelling niet beschikbaar \(network down\).*Yr\.no/);
});

test('the English text in index.html matches data/translations.json', () => {
  const source = readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
  const { document } = new JSDOM(source).window;
  const { en } = translations;
  const asHtml = (value) => {
    const holder = document.createElement('div');
    holder.innerHTML = value;
    return squash(holder.innerHTML);
  };
  for (const node of document.querySelectorAll('[data-i18n]')) {
    assert.equal(squash(node.textContent), en[node.dataset.i18n], node.dataset.i18n);
  }
  for (const node of document.querySelectorAll('[data-i18n-html]')) {
    assert.equal(squash(node.innerHTML), asHtml(en[node.dataset.i18nHtml]), node.dataset.i18nHtml);
  }
  for (const node of document.querySelectorAll('[data-i18n-aria]')) {
    assert.equal(node.getAttribute('aria-label'), en[node.dataset.i18nAria], node.dataset.i18nAria);
  }
});

test('every translation key is used, and every key the code uses exists', () => {
  const source = readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
  const code = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  const keys = Object.keys(translations.en);
  const dynamic = ['source.', 'mode.name.', 'stationStatus.', 'stations.col.'];
  for (const key of keys) {
    const used =
      code.includes(`'${key}'`) || source.includes(`"${key}"`) || dynamic.some((prefix) => key.startsWith(prefix));
    assert.ok(used, `${key} is never used`);
  }
  for (const [, key] of code.matchAll(/\bt\('([\w.]+)'/g)) assert.ok(keys.includes(key), `${key} is missing`);
  for (const [, key] of source.matchAll(/data-i18n(?:-html|-aria)?="([\w.]+)"/g)) assert.ok(keys.includes(key), key);
});
