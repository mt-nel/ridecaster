'use strict';

/**
 * Coast to Coast: weather and power along the route.
 *
 * Layout of this file:
 *   1. constants
 *   2. pure model: route geometry, forecast, physics, ride simulation (exported for tests)
 *   3. formatting and colour helpers
 *   4. view: SVG map and charts, readouts
 *   5. controller: reads the inputs, wires events, starts the app
 */
(function () {
  // ------------------------------------------------------------------ constants
  const DEG = Math.PI / 180;
  const MS_PER_MINUTE = 60_000;
  const MS_PER_HOUR = 3_600_000;
  const MS_PER_DAY = 86_400_000;
  const KNOTS_TO_MS = 0.514444;
  const KNOTS_TO_KMH = 1.852;
  const GRAVITY = 9.81;

  const BEARING_SPAN_KM = 3;
  const GRADE_SPAN_KM = 1.5;
  const MAX_GRADE = 0.06;
  const FORECAST_MARGIN_MS = 3 * MS_PER_HOUR;
  const SAMPLE_STEP_KM = 2;
  const TARGET_HOURS = 24;
  const SPEED_PRESETS_KMH = [22, 25, 27, 30, 33, 36];
  const DEFAULT_START_DATE = '2026-10-10';
  const DEFAULT_LANGUAGE = 'en';
  const LANGUAGE_STORAGE_KEY = 'coast-to-coast-language';
  const LOCALES = Object.freeze({ nl: 'nl-NL', en: 'en-GB' });
  const RELOAD_DELAY_MS = 400;
  const RAIN_RATE_FACTOR = 3; // hourly mm -> mm per 3 hours, the unit of the forecast rows

  /** KNMI HARMONIE AROME (about 2.5 days, then ECMWF) through Open-Meteo's forecast API. */
  const OPEN_METEO = Object.freeze({
    url: 'https://api.open-meteo.com/v1/forecast',
    hourly: [
      'wind_speed_10m',
      'wind_direction_10m',
      'wind_gusts_10m',
      'temperature_2m',
      'precipitation',
      'cloud_cover',
    ],
    timezone: 'Europe/Amsterdam',
    pointCount: 7,
    spanDays: 2,
  });
  /** Sources served by Open-Meteo: source id -> model. GFS is the model behind Windfinder's forecast. */
  const LIVE_SOURCES = Object.freeze({
    knmi: { model: 'knmi_seamless', name: 'KNMI' },
    gfs: { model: 'gfs_global', name: 'GFS' },
  });

  const PHYSICS = Object.freeze({
    airDensity: 1.24,
    drivetrainEfficiency: 0.975,
    minSpeedMs: 0.3,
    maxSpeedMs: 25,
    solverIterations: 40,
  });
  /** Rain thresholds in mm per 3 hours. */
  const RAIN = Object.freeze({ dry: 0.3, light: 3, moderate: 7.5, fullScale: 6 });
  const HEADWIND = Object.freeze({ neutralKmh: 2, colourScaleKmh: 22, chartLimitKmh: 24 });

  const NO_DATA_COLOUR = '#8a9a9c';
  const POWER_COLOUR = '#6b8a91';
  const COLOURS = Object.freeze({
    neutral: [138, 154, 156],
    head: [216, 69, 47],
    tail: [28, 124, 140],
    rainLight: [110, 190, 240],
    rainHeavy: [90, 50, 190],
  });

  /**
   * Temperature palette: [position 0..1 along the scale, rgb]. The scale itself is fitted to the temperatures
   * on the route (see fitTemperatureScale), so small differences stay visible.
   */
  const TEMPERATURE_PALETTE = Object.freeze([
    [0, [44, 90, 200]],
    [0.25, [50, 165, 200]],
    [0.5, [225, 190, 40]],
    [0.75, [240, 125, 45]],
    [1, [200, 45, 40]],
  ]);
  const TEMPERATURE_MIN_SPAN = 6;
  const DEFAULT_TEMPERATURE_SCALE = Object.freeze({ low: 0, high: 26 });
  const TEMPERATURE_AXIS_STEP = 5;

  const MAP = Object.freeze({ width: 600, height: 640, margin: 40, referenceLat: 52.4, tickKm: 50, labelInset: 14 });
  const LABEL_HALF_CHAR_PX = 3.8; // about half the width of one character of a province name
  const CHART = Object.freeze({ width: 600, padLeft: 36 });

  // ------------------------------------------------------------------ small helpers
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const lerp = (a, b, fraction) => a + (b - a) * fraction;
  const pad2 = (value) => String(value).padStart(2, '0');

  // ------------------------------------------------------------------ model: route
  /**
   * @typedef {[number, number, number, number]} RoutePoint  latitude, longitude, km from start, elevation in m
   * @typedef {{startKm: number, lengthKm: number, bearing: number, grade: number}} Segment
   */

  /**
   * Wraps the route points and precomputes ~1 km segments with bearing and grade.
   * @param {RoutePoint[]} points
   */
  function createRoute(points) {
    const totalKm = points.at(-1)[2];

    function pointAt(km) {
      const target = clamp(km, 0, totalKm);
      let low = 0;
      let high = points.length - 1;
      while (high - low > 1) {
        const middle = (low + high) >> 1;
        if (points[middle][2] <= target) low = middle;
        else high = middle;
      }
      const a = points[low];
      const b = points[high];
      const fraction = b[2] > a[2] ? (target - a[2]) / (b[2] - a[2]) : 0;
      return { lat: lerp(a[0], b[0], fraction), lon: lerp(a[1], b[1], fraction), ele: lerp(a[3], b[3], fraction) };
    }

    /** Direction of travel in degrees, smoothed over a few km. */
    function bearingAt(km) {
      const from = pointAt(km - BEARING_SPAN_KM);
      const to = pointAt(km + BEARING_SPAN_KM);
      const lat1 = from.lat * DEG;
      const lat2 = to.lat * DEG;
      const dLon = (to.lon - from.lon) * DEG;
      const y = Math.sin(dLon) * Math.cos(lat2);
      const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
      return (Math.atan2(y, x) / DEG + 360) % 360;
    }

    /** @type {Segment[]} */
    const segments = [];
    for (let startKm = 0; startKm < Math.ceil(totalKm); startKm += 1) {
      const lengthKm = Math.min(1, totalKm - startKm);
      const midKm = startKm + lengthKm / 2;
      const rise = pointAt(midKm + GRADE_SPAN_KM).ele - pointAt(midKm - GRADE_SPAN_KM).ele;
      const grade = clamp(rise / (2 * GRADE_SPAN_KM * 1000), -MAX_GRADE, MAX_GRADE);
      segments.push({ startKm, lengthKm, bearing: bearingAt(midKm), grade });
    }
    return { points, totalKm, segments, pointAt, bearingAt };
  }

  // ------------------------------------------------------------------ model: forecast
  /**
   * @typedef {{time: number, dir: number, windKts: number, gustKts: number, tempC: number,
   *            rainMm3h: number, cloudPct: number}} WeatherSample  dir is where the wind comes FROM, in degrees
   */

  /**
   * Parses forecast rows: km, date, hour, dir, kts, gust, temp, rain, cloud. Other lines are ignored.
   * @param {string} text
   * @returns {Map<number, WeatherSample[]>} samples per forecast point (km), sorted by time
   */
  function parseForecast(text) {
    const byKm = new Map();
    for (const line of text.split('\n')) {
      const cells = line.trim().split(/[,;\t]+/);
      if (cells.length < 9 || Number.isNaN(Number(cells[0]))) continue;
      const [year, month, day] = cells[1].split('-').map(Number);
      const km = Number(cells[0]);
      const sample = {
        time: Date.UTC(year, month - 1, day, Number(cells[2])),
        dir: Number(cells[3]),
        windKts: Number(cells[4]),
        gustKts: Number(cells[5]),
        tempC: Number(cells[6]),
        rainMm3h: Number(cells[7]),
        cloudPct: Number(cells[8]),
      };
      if (!byKm.has(km)) byKm.set(km, []);
      byKm.get(km).push(sample);
    }
    for (const samples of byKm.values()) samples.sort((a, b) => a.time - b.time);
    return byKm;
  }

  /** Positions of the forecast points: evenly spaced from start to finish. */
  function forecastPointKms(totalKm, count = OPEN_METEO.pointCount) {
    return Array.from({ length: count }, (_, i) => Number(((i * totalKm) / (count - 1)).toFixed(1)));
  }

  function addDays(isoDate, days) {
    const [year, month, day] = isoDate.split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
  }

  /** Builds the Open-Meteo request: one multi-location call, local times, wind in knots. */
  function buildOpenMeteoUrl(locations, startDate, model = LIVE_SOURCES.knmi.model) {
    const params = new URLSearchParams({
      latitude: locations.map((p) => p.lat.toFixed(4)).join(','),
      longitude: locations.map((p) => p.lon.toFixed(4)).join(','),
      hourly: OPEN_METEO.hourly.join(','),
      models: model,
      wind_speed_unit: 'kn',
      timezone: OPEN_METEO.timezone,
      start_date: startDate,
      end_date: addDays(startDate, OPEN_METEO.spanDays),
    });
    return `${OPEN_METEO.url}?${params}`;
  }

  /** Series for one variable; tolerates a model suffix such as wind_speed_10m_knmi_seamless. */
  function hourlySeries(hourly, name) {
    const key = name in hourly ? name : Object.keys(hourly).find((k) => k.startsWith(`${name}_`));
    return key ? hourly[key] : [];
  }

  /**
   * Converts an Open-Meteo response (one object, or an array for several locations) to forecast samples.
   * Hours without wind values are skipped. Times are local clock times, kept as UTC like the rest of the app.
   * @param {object|object[]} response
   * @param {number[]} kms route position of each requested location, in request order
   * @returns {Map<number, WeatherSample[]>}
   */
  function parseOpenMeteo(response, kms) {
    const results = Array.isArray(response) ? response : [response];
    const byKm = new Map();
    results.forEach((result, i) => {
      const hourly = result.hourly ?? {};
      const col = Object.fromEntries(OPEN_METEO.hourly.map((name) => [name, hourlySeries(hourly, name)]));
      const samples = [];
      (hourly.time ?? []).forEach((stamp, h) => {
        const [year, month, day] = stamp.slice(0, 10).split('-').map(Number);
        const wind = col.wind_speed_10m[h];
        const dir = col.wind_direction_10m[h];
        if (wind == null || dir == null) return;
        samples.push({
          time: Date.UTC(year, month - 1, day, Number(stamp.slice(11, 13))),
          dir,
          windKts: wind,
          gustKts: col.wind_gusts_10m[h] ?? wind,
          tempC: col.temperature_2m[h] ?? 0,
          rainMm3h: (col.precipitation[h] ?? 0) * RAIN_RATE_FACTOR,
          cloudPct: col.cloud_cover[h] ?? 0,
        });
      });
      if (samples.length > 0) byKm.set(kms[i], samples);
    });
    return byKm;
  }

  /**
   * Fetches a forecast from Open-Meteo (see LIVE_SOURCES) for points along the route.
   * @returns {Promise<Map<number, WeatherSample[]>>}
   * @throws {Error} with a readable message when the request fails or returns no usable data
   */
  async function fetchOpenMeteoForecast(route, startDate, source = 'knmi', fetchFn = globalThis.fetch) {
    const kms = forecastPointKms(route.totalKm);
    const response = await fetchFn(
      buildOpenMeteoUrl(
        kms.map((km) => route.pointAt(km)),
        startDate,
        LIVE_SOURCES[source].model,
      ),
    );
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.error) throw new Error(body.reason ?? `Open-Meteo answered ${response.status}`);
    const byKm = parseOpenMeteo(body, kms);
    if (byKm.size === 0) throw new Error('Open-Meteo returned no data for these dates');
    return byKm;
  }

  /** Inverse of parseForecast: forecast rows as editable text. */
  function toForecastCsv(byKm) {
    const rows = [];
    for (const [km, samples] of [...byKm.entries()].sort((x, y) => x[0] - y[0])) {
      for (const s of samples) {
        const iso = new Date(s.time).toISOString();
        const values = [s.dir, s.windKts, s.gustKts, s.tempC, s.rainMm3h].map((v) => Number(v.toFixed(2)));
        rows.push([km, iso.slice(0, 10), Number(iso.slice(11, 13)), ...values, Math.round(s.cloudPct)].join(','));
      }
    }
    return ['km,date,hour,dir,kts,gust,temp,rain,cloud', ...rows].join('\n');
  }

  /** Linear blend of two samples; wind direction is blended as a vector so 350 and 10 give 0. */
  function blendSamples(a, b, fraction) {
    const sin = lerp(Math.sin(a.dir * DEG), Math.sin(b.dir * DEG), fraction);
    const cos = lerp(Math.cos(a.dir * DEG), Math.cos(b.dir * DEG), fraction);
    return {
      dir: (Math.atan2(sin, cos) / DEG + 360) % 360,
      windKts: lerp(a.windKts, b.windKts, fraction),
      gustKts: lerp(a.gustKts, b.gustKts, fraction),
      tempC: lerp(a.tempC, b.tempC, fraction),
      rainMm3h: lerp(a.rainMm3h, b.rainMm3h, fraction),
      cloudPct: lerp(a.cloudPct, b.cloudPct, fraction),
    };
  }

  /**
   * Weather lookup by position and time: interpolates in time at each forecast point,
   * then in space between the two neighbouring points.
   * @param {Map<number, WeatherSample[]>} byKm
   */
  function createWeather(byKm) {
    const stationKms = [...byKm.keys()].sort((a, b) => a - b);

    function atStation(samples, time) {
      const first = samples[0];
      const last = samples.at(-1);
      if (time < first.time - FORECAST_MARGIN_MS || time > last.time + FORECAST_MARGIN_MS) return null;
      if (time <= first.time) return first;
      if (time >= last.time) return last;
      const next = samples.findIndex((sample) => sample.time >= time);
      const before = samples[next - 1];
      return blendSamples(before, samples[next], (time - before.time) / (samples[next].time - before.time));
    }

    /** @returns {WeatherSample|null} null when no forecast covers this time */
    function at(km, time) {
      const available = [];
      for (const stationKm of stationKms) {
        const sample = atStation(byKm.get(stationKm), time);
        if (sample) available.push({ km: stationKm, sample });
      }
      if (available.length === 0) return null;
      if (km <= available[0].km) return available[0].sample;
      if (km >= available.at(-1).km) return available.at(-1).sample;
      const i = available.findIndex((item, j) => j < available.length - 1 && km >= item.km && km < available[j + 1].km);
      const [a, b] = [available[i], available[i + 1]];
      return blendSamples(a.sample, b.sample, (km - a.km) / (b.km - a.km));
    }

    const coverage = () => stationKms.map((km) => ({ km, from: byKm.get(km)[0].time, to: byKm.get(km).at(-1).time }));

    return { stationKms, at, coverage };
  }

  // ------------------------------------------------------------------ model: physics
  /**
   * @typedef {{massKg: number, cda: number, crr: number}} Rider  total mass, drag area (m2), rolling resistance
   */

  /**
   * Mechanical power at the pedals for a steady ground speed.
   * @param {number} speed ground speed in m/s
   * @param {number} headwind m/s, negative for a tailwind
   * @param {number} grade rise over run
   * @param {Rider} rider
   */
  function powerAtSpeed(speed, headwind, grade, rider) {
    const airSpeed = speed + headwind;
    const aero = 0.5 * PHYSICS.airDensity * rider.cda * airSpeed * Math.abs(airSpeed);
    const rolling = rider.crr * rider.massKg * GRAVITY;
    const climbing = rider.massKg * GRAVITY * grade;
    return ((aero + rolling + climbing) * speed) / PHYSICS.drivetrainEfficiency;
  }

  /** Inverse of powerAtSpeed, solved by bisection. Returns m/s. */
  function speedAtPower(power, headwind, grade, rider) {
    let low = PHYSICS.minSpeedMs;
    let high = PHYSICS.maxSpeedMs;
    for (let i = 0; i < PHYSICS.solverIterations; i += 1) {
      const middle = (low + high) / 2;
      if (powerAtSpeed(middle, headwind, grade, rider) > power) high = middle;
      else low = middle;
    }
    return (low + high) / 2;
  }

  /** Wind component along the direction of travel in m/s (positive = headwind). */
  function headwindMs(sample, bearing) {
    return sample.windKts * KNOTS_TO_MS * Math.cos((sample.dir - bearing) * DEG);
  }

  // ------------------------------------------------------------------ model: ride simulation
  /**
   * @typedef {object} Plan
   * @property {'speed'|'power'} mode what is held constant
   * @property {number} speedKmh used in speed mode
   * @property {number} powerW used in power mode (speed then varies with wind and grade)
   * @property {number} startTime ms, wall-clock time stored as UTC
   * @property {number[]} stopsKm positions of the stops
   * @property {number} stopMinutes length of each stop
   * @property {Rider} rider
   * @property {number} windShare share of the forecast wind that reaches the rider (0..1)
   */

  /**
   * Rides the route segment by segment, looking up the weather at the time of arrival.
   * @param {ReturnType<typeof createRoute>} route
   * @param {ReturnType<typeof createWeather>} weather
   * @param {Plan} plan
   */
  function simulate(route, weather, plan) {
    const times = [plan.startTime];
    const arrivals = [];
    const speeds = [];
    const powers = [];
    let time = plan.startTime;
    let ridingMs = 0;
    let workMs = 0;

    for (const segment of route.segments) {
      const endKm = segment.startKm + segment.lengthKm;
      const sample = weather.at(segment.startKm + segment.lengthKm / 2, time);
      const headwind = sample ? headwindMs(sample, segment.bearing) * plan.windShare : 0;
      const speed =
        plan.mode === 'speed' ? plan.speedKmh / 3.6 : speedAtPower(plan.powerW, headwind, segment.grade, plan.rider);
      const power = Math.max(0, powerAtSpeed(speed, headwind, segment.grade, plan.rider));
      const durationMs = (segment.lengthKm * 1000 * 1000) / speed;

      speeds.push(speed);
      powers.push(power);
      ridingMs += durationMs;
      workMs += power * durationMs;
      time += durationMs;
      arrivals.push(time);
      if (plan.stopsKm.some((km) => segment.startKm < km && km <= endKm)) time += plan.stopMinutes * MS_PER_MINUTE;
      times.push(time);
    }

    const lastIndex = route.segments.length - 1;
    const indexAt = (km) => Math.min(Math.floor(km), lastIndex);
    return {
      times,
      arrivals,
      speeds,
      powers,
      ridingHours: ridingMs / MS_PER_HOUR,
      averagePowerW: workMs / ridingMs,
      indexAt,
      /** Clock time at a position (includes waiting at a stop on the same segment). */
      timeAt(km) {
        const i = indexAt(km);
        const fraction = clamp((km - route.segments[i].startKm) / route.segments[i].lengthKm, 0, 1);
        return lerp(times[i], times[i + 1], fraction);
      },
      /** Arrival time at a position, before any stop there. */
      arrivalAt(km) {
        return arrivals[Math.min(Math.ceil(km) - 1, lastIndex)];
      },
    };
  }

  /** Everything the view needs to know about one position on the route. */
  function describePoint(route, weather, ride, km) {
    const time = ride.timeAt(km);
    const sample = weather.at(km, time);
    const bearing = route.bearingAt(km);
    const index = ride.indexAt(km);
    const point = {
      km,
      time,
      bearing,
      weather: sample,
      speedKmh: ride.speeds[index] * 3.6,
      powerW: ride.powers[index],
    };
    if (!sample) return point;
    const windKmh = sample.windKts * KNOTS_TO_KMH;
    const angle = (sample.dir - bearing) * DEG;
    return { ...point, windKmh, headwindKmh: windKmh * Math.cos(angle), crosswindKmh: windKmh * Math.sin(angle) };
  }

  /**
   * Compares an arrival with a refreshment station's window.
   * @param {number} arrivalMs
   * @param {number} dayStartMs midnight of the start day
   * @param {{opens: number, closes: number}} station hours since that midnight (may exceed 24)
   * @returns {{state: 'early'|'ok'|'late', minutes: number}}
   */
  function stationStatus(arrivalMs, dayStartMs, station) {
    const hours = (arrivalMs - dayStartMs) / MS_PER_HOUR;
    if (hours < station.opens) return { state: 'early', minutes: Math.round((station.opens - hours) * 60) };
    if (hours > station.closes) return { state: 'late', minutes: Math.round((hours - station.closes) * 60) };
    return { state: 'ok', minutes: 0 };
  }

  // ------------------------------------------------------------------ formatting and colours
  /** Picks the stored language if supported, else the first supported browser language, else English. */
  function detectLanguage(stored, browserLanguages, supported) {
    if (supported.includes(stored)) return stored;
    const codes = browserLanguages.map((tag) => String(tag).toLowerCase().split('-')[0]);
    return codes.find((code) => supported.includes(code)) ?? DEFAULT_LANGUAGE;
  }

  /**
   * Returns t(key, params): looks the key up in the language, then in English, then returns the key itself.
   * {name} placeholders are replaced from params.
   * @param {Record<string, Record<string, string>>} dictionaries
   * @param {string} language
   */
  function createTranslator(dictionaries, language) {
    const primary = dictionaries[language] ?? {};
    const fallback = dictionaries[DEFAULT_LANGUAGE] ?? {};
    return (key, params = {}) =>
      String(primary[key] ?? fallback[key] ?? key).replace(/\{(\w+)\}/g, (match, name) =>
        name in params ? String(params[name]) : match,
      );
  }

  /** Date and time formatters for a language. Times are wall-clock times stored as UTC. */
  function createFormatters(language) {
    const locale = LOCALES[language] ?? LOCALES[DEFAULT_LANGUAGE];
    const dateTime = new Intl.DateTimeFormat(locale, {
      timeZone: 'UTC',
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
    const dayClock = new Intl.DateTimeFormat(locale, {
      timeZone: 'UTC',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
    return { dateTime: (ms) => dateTime.format(ms), dayClock: (ms) => dayClock.format(ms) };
  }

  const defaultDuration = ({ h, m }) => `${h}h ${m}m`;
  /** @param {(parts: {h: number, m: string}) => string} format builds the text, e.g. from a translation */
  function formatDuration(hours, format = defaultDuration) {
    const minutes = Math.round(hours * 60);
    return format({ h: Math.floor(minutes / 60), m: pad2(minutes % 60) });
  }
  const formatClockHour = (hours) => `${pad2(Math.floor(hours) % 24)}:00`;
  const compassLabel = (degrees, t) =>
    `${t('compass').split(',')[Math.round(degrees / 22.5) % 16]} (${Math.round(degrees)}°)`;

  function skyLabel(sample, t) {
    if (sample.rainMm3h >= RAIN.dry) return t('sky.rain');
    if (sample.cloudPct > 85) return t('sky.overcast');
    if (sample.cloudPct > 50) return t('sky.mostlyCloudy');
    return t(sample.cloudPct > 20 ? 'sky.partlyCloudy' : 'sky.clear');
  }

  function rainLabel(mm3h, t) {
    if (mm3h < RAIN.dry) return t('rain.dry');
    if (mm3h < RAIN.light) return t('rain.light');
    return t(mm3h < RAIN.moderate ? 'rain.moderate' : 'rain.heavy');
  }

  const mixColour = (from, to, amount) =>
    `rgb(${from.map((channel, i) => Math.round(lerp(channel, to[i], amount))).join(',')})`;

  function headwindColour(kmh) {
    if (kmh == null) return NO_DATA_COLOUR;
    const amount = clamp(kmh / HEADWIND.colourScaleKmh, -1, 1);
    return mixColour(COLOURS.neutral, amount > 0 ? COLOURS.head : COLOURS.tail, Math.abs(amount));
  }

  function rainColour(mm3h) {
    if (mm3h == null || mm3h < RAIN.dry) return NO_DATA_COLOUR;
    return mixColour(COLOURS.rainLight, COLOURS.rainHeavy, Math.min(1, mm3h / RAIN.fullScale));
  }

  /** Colour scale spanning the route's temperatures, at least TEMPERATURE_MIN_SPAN wide and centred on them. */
  function fitTemperatureScale(temps) {
    if (temps.length === 0) return DEFAULT_TEMPERATURE_SCALE;
    const min = Math.min(...temps);
    const max = Math.max(...temps);
    const span = Math.max(max - min, TEMPERATURE_MIN_SPAN);
    const middle = (min + max) / 2;
    return { low: middle - span / 2, high: middle + span / 2 };
  }

  function temperatureColour(tempC, scale = DEFAULT_TEMPERATURE_SCALE) {
    if (tempC == null) return NO_DATA_COLOUR;
    const position = clamp((tempC - scale.low) / (scale.high - scale.low), 0, 1);
    const upper = TEMPERATURE_PALETTE.findIndex(([stop]) => position <= stop);
    if (upper <= 0) return mixColour(TEMPERATURE_PALETTE[0][1], TEMPERATURE_PALETTE[0][1], 0);
    const [lowerStop, lowerRgb] = TEMPERATURE_PALETTE[upper - 1];
    const [upperStop, upperRgb] = TEMPERATURE_PALETTE[upper];
    return mixColour(lowerRgb, upperRgb, (position - lowerStop) / (upperStop - lowerStop));
  }

  // ------------------------------------------------------------------ view helpers
  function tag(name, attributes, inner = '') {
    const attrs = Object.entries(attributes)
      .map(([key, value]) => ` ${key}="${value}"`)
      .join('');
    return `<${name}${attrs}>${inner}</${name}>`;
  }
  const fixed1 = (value) => value.toFixed(1);
  const windfinderUrl = (lat, lon) => `https://www.windfinder.com/#9/${lat.toFixed(4)}/${lon.toFixed(4)}`;

  function createProjector(points) {
    const lats = points.map((p) => p[0]);
    const lons = points.map((p) => p[1]);
    const [minLat, maxLat, minLon, maxLon] = [
      Math.min(...lats),
      Math.max(...lats),
      Math.min(...lons),
      Math.max(...lons),
    ];
    const lonScale = Math.cos(MAP.referenceLat * DEG);
    const scale = Math.min(
      (MAP.width - 2 * MAP.margin) / ((maxLon - minLon) * lonScale),
      (MAP.height - 2 * MAP.margin) / (maxLat - minLat),
    );
    const offsetX = (MAP.width - (maxLon - minLon) * lonScale * scale) / 2;
    const offsetY = (MAP.height - (maxLat - minLat) * scale) / 2;
    return (lat, lon) => [offsetX + (lon - minLon) * lonScale * scale, offsetY + (maxLat - lat) * scale];
  }

  /**
   * SVG for the land and borders under the route: country fills, dashed province borders, country borders and
   * province names. The projection is fixed, so this is built once.
   * @param {{countries: {code: string, rings: number[][][]}[], provinces: {name: string, label: number[], rings: number[][][]}[]}} boundaries
   *        rings are [lon, lat] pairs
   * @param {(lat: number, lon: number) => number[]} project
   */
  function renderBoundaries(boundaries, project) {
    const path = (rings) =>
      rings
        .map((ring) => {
          const points = ring.map(([lon, lat]) => project(lat, lon).map(fixed1).join(' '));
          return `M${points.join('L')}Z`;
        })
        .join('');
    const fills = boundaries.countries.map((c) =>
      tag('path', { class: `country-fill country-fill--${c.code.toLowerCase()}`, d: path(c.rings) }),
    );
    const provinces = boundaries.provinces.map((p) => tag('path', { class: 'province', d: path(p.rings) }));
    const lines = boundaries.countries.map((c) => tag('path', { class: 'country-line', d: path(c.rings) }));
    const labels = boundaries.provinces
      .map((p) => {
        const [x, y] = project(p.label[1], p.label[0]);
        const half = p.name.length * LABEL_HALF_CHAR_PX;
        const visible = x > -half && x < MAP.width + half && y > MAP.labelInset && y < MAP.height - MAP.labelInset;
        // keep the whole name on the map even when its province is mostly off-screen
        const labelX = clamp(x, MAP.labelInset + half, MAP.width - MAP.labelInset - half);
        return visible ? tag('text', { class: 'province-label', x: fixed1(labelX), y: fixed1(y) }, p.name) : '';
      })
      .join('');
    return fills.join('') + provinces.join('') + lines.join('') + labels;
  }

  const chartX = (km, totalKm) => CHART.padLeft + (km / totalKm) * (CHART.width - CHART.padLeft);

  /** Dotted vertical lines at the stops. */
  function stopLines(stopsKm, totalKm, height) {
    return stopsKm
      .map((km) => {
        const x = fixed1(chartX(km, totalKm));
        return tag('line', { class: 'stop-line', x1: x, x2: x, y1: 0, y2: height });
      })
      .join('');
  }

  /**
   * Draws a bar chart with a y axis. `bars` holds one entry per sample, or null where there is no data.
   * @param {SVGElement} svg
   * @param {{height: number, baseline: number, pxPerUnit: number, limits: [number, number], minBarPx: number,
   *          ticks: number[], signedTicks?: boolean, captions: {text: string, y: number, class: string}[],
   *          bars: ({value: number, colour: string}|null)[]}} spec
   * @param {{stopsKm: number[], totalKm: number}} context
   */
  function drawChart(svg, spec, context) {
    const { height, baseline, pxPerUnit, limits, minBarPx, origin = 0 } = spec;
    const barWidth = (CHART.width - CHART.padLeft) / spec.bars.length;
    const grid = spec.ticks
      .map((value) => {
        const y = fixed1(baseline - (value - origin) * pxPerUnit);
        const label = (spec.signedTicks && value > 0 ? '+' : '') + value;
        return (
          tag('line', {
            class: value === origin ? 'gridline' : 'gridline gridline--dashed',
            x1: CHART.padLeft,
            x2: CHART.width,
            y1: y,
            y2: y,
          }) + tag('text', { class: 'tick-label', x: CHART.padLeft - 4, y: Number(y) + 3.5 }, label)
        );
      })
      .join('');
    const captions = spec.captions
      .map((caption) => tag('text', { class: caption.class, x: CHART.padLeft + 4, y: caption.y }, caption.text))
      .join('');
    const bars = spec.bars
      .map((bar, i) => {
        if (!bar) return '';
        const px = (clamp(bar.value, limits[0], limits[1]) - origin) * pxPerUnit;
        if (Math.abs(px) <= minBarPx) return '';
        return tag('rect', {
          x: fixed1(CHART.padLeft + i * barWidth),
          y: fixed1(px > 0 ? baseline - px : baseline),
          width: fixed1(barWidth + 0.3),
          height: fixed1(Math.abs(px)),
          fill: bar.colour,
        });
      })
      .join('');
    const cursor = tag('line', { class: 'cursor', y1: 0, y2: height });
    svg.innerHTML = grid + captions + stopLines(context.stopsKm, context.totalKm, height) + bars + cursor;
  }

  /** Chart definitions: one place for geometry and scales. */
  function chartSpecs(samples, temperatureScale, t) {
    const limit = HEADWIND.chartLimitKmh;
    const peakPower = Math.max(...samples.map((s) => s.powerW));
    const powerTop = Math.max(150, peakPower);
    const powerStep = powerTop > 400 ? 100 : powerTop > 200 ? 50 : 25;
    const powerTicks = [];
    for (let value = 0; value <= powerTop; value += powerStep) powerTicks.push(value);

    const temps = samples.filter((s) => s.weather).map((s) => s.weather.tempC);
    const tempLow = temps.length
      ? Math.min(0, Math.floor(Math.min(...temps) / TEMPERATURE_AXIS_STEP) * TEMPERATURE_AXIS_STEP)
      : 0;
    const tempHigh = temps.length
      ? Math.max(
          tempLow + 2 * TEMPERATURE_AXIS_STEP,
          Math.ceil(Math.max(...temps) / TEMPERATURE_AXIS_STEP) * TEMPERATURE_AXIS_STEP,
        )
      : 20;
    const tempTicks = [];
    for (let value = tempLow; value <= tempHigh; value += TEMPERATURE_AXIS_STEP) tempTicks.push(value);
    const tempCaption = temps.length
      ? t('caption.temperature', { low: Math.round(Math.min(...temps)), high: Math.round(Math.max(...temps)) })
      : t('caption.temperatureNone');

    return {
      wind: {
        height: 120,
        baseline: 60,
        pxPerUnit: 48 / limit,
        limits: [-limit, limit],
        minBarPx: 0,
        ticks: [-20, -10, 0, 10, 20],
        signedTicks: true,
        captions: [
          { text: t('caption.headwind'), y: 10, class: 'chart-label chart-label--head' },
          { text: t('caption.tailwind'), y: 117, class: 'chart-label chart-label--tail' },
        ],
        bars: samples.map((s) => (s.weather ? { value: s.headwindKmh, colour: headwindColour(s.headwindKmh) } : null)),
      },
      rain: {
        height: 80,
        baseline: 70,
        pxPerUnit: 54 / RAIN.fullScale,
        limits: [0, RAIN.fullScale],
        minBarPx: 0.5,
        ticks: [0, 2, 4, 6],
        captions: [{ text: t('caption.rain'), y: 10, class: 'chart-label' }],
        bars: samples.map((s) =>
          s.weather ? { value: s.weather.rainMm3h, colour: rainColour(s.weather.rainMm3h) } : null,
        ),
      },
      temperature: {
        height: 100,
        baseline: 90,
        pxPerUnit: 76 / (tempHigh - tempLow),
        origin: tempLow,
        limits: [tempLow, tempHigh],
        minBarPx: 0.5,
        ticks: tempTicks,
        captions: [{ text: tempCaption, y: 10, class: 'chart-label' }],
        bars: samples.map((s) =>
          s.weather ? { value: s.weather.tempC, colour: temperatureColour(s.weather.tempC, temperatureScale) } : null,
        ),
      },
      power: {
        height: 100,
        baseline: 90,
        pxPerUnit: 76 / powerTop,
        limits: [0, powerTop],
        minBarPx: 0.5,
        ticks: powerTicks,
        captions: [{ text: t('caption.power', { peak: Math.round(peakPower) }), y: 10, class: 'chart-label' }],
        bars: samples.map((s) => ({ value: s.powerW, colour: POWER_COLOUR })),
      },
    };
  }

  /** Aggregates used by the summary text. */
  function summariseSamples(samples) {
    const withWeather = samples.filter((s) => s.weather);
    const wet = withWeather.filter((s) => s.weather.rainMm3h >= RAIN.dry);
    const heaviest = withWeather.reduce(
      (best, s) => (s.weather.rainMm3h > (best?.weather.rainMm3h ?? 0) ? s : best),
      null,
    );
    const temps = withWeather.map((s) => s.weather.tempC);
    return {
      measured: withWeather.length,
      tempMin: Math.min(...temps),
      tempMax: Math.max(...temps),
      missingShare: 1 - withWeather.length / samples.length,
      meanHeadwindKmh: withWeather.reduce((sum, s) => sum + s.headwindKmh, 0) / (withWeather.length || 1),
      wetShare: wet.length / (withWeather.length || 1),
      heaviest,
    };
  }

  const swatch = (modifier, colour) =>
    tag('i', { class: `swatch ${modifier}`.trim(), ...(colour ? { style: `background:${colour}` } : {}) });
  /** Legend entries for the temperature colouring: five labelled steps of the fitted scale. */
  function temperatureLegend(scale) {
    return TEMPERATURE_PALETTE.map(([position]) => {
      const tempC = scale.low + position * (scale.high - scale.low);
      return ['', `${Math.round(tempC)} °C`, temperatureColour(tempC, scale)];
    });
  }
  /** Legend entries per map colouring: [swatch class, label, optional colour]. */
  const LEGENDS = {
    wind: [
      ['swatch--head', 'legend.headwind'],
      ['swatch--tail', 'legend.tailwind'],
      ['', 'legend.crosswind'],
    ],
    rain: [
      ['', 'legend.dry'],
      ['swatch--light', 'legend.light'],
      ['swatch--moderate', 'legend.moderate'],
      ['swatch--heavy', 'legend.heavy'],
    ],
  };

  // ------------------------------------------------------------------ view + controller
  /**
   * @param {object} dom  element references (see queryDom)
   * @param {{route: RoutePoint[], stations: object, forecast: string}} data
   */
  function createApp(dom, data) {
    const route = createRoute(data.route);
    const project = createProjector(route.points);
    const boundaryLayer = renderBoundaries(data.boundaries, project);
    const finish = data.stations.stations.at(-1);
    const stations = data.stations.stations.map((s) => ({ ...s, km: s.km ?? route.totalKm }));
    let t = createTranslator(data.translations, data.language);
    let fmt = createFormatters(data.language);
    const state = {
      language: data.language,
      status: { loading: null, notes: [], spans: [] },
      weather: createWeather(new Map()),
      mapMode: 'wind',
      paceMode: 'speed',
      ride: null,
      samples: [],
      plan: null,
      temperatureScale: DEFAULT_TEMPERATURE_SCALE,
      source: 'knmi',
      loadId: 0,
      reloadTimer: null,
    };
    const chartContext = () => ({ stopsKm: state.plan.stopsKm, totalKm: route.totalKm });

    /** Shows which source is loaded and what it covers, in the current language. */
    function renderStatus() {
      const { loading, notes, spans } = state.status;
      if (loading) {
        dom.forecastStatus.textContent = t('status.loading', { name: loading });
        return;
      }
      const range = spans.length
        ? t('status.covers', {
            from: fmt.dateTime(Math.min(...spans.map((s) => s.from))),
            to: fmt.dateTime(Math.max(...spans.map((s) => s.to))),
          })
        : t('status.noRows');
      dom.forecastStatus.textContent = [...notes.map(({ key, params }) => t(key, params)), range].join(' ');
      dom.coverage.textContent =
        spans
          .map((s) => t('coverage.item', { km: s.km, from: fmt.dateTime(s.from), to: fmt.dateTime(s.to) }))
          .join('; ') || t('coverage.none');
    }

    function setForecast(byKm, notes) {
      state.weather = createWeather(byKm);
      state.status = { loading: null, notes, spans: state.weather.coverage() };
      renderStatus();
    }

    /** Loads the selected source, falling back to the saved Yr forecast if a live one fails. Stale answers are ignored. */
    async function loadForecast() {
      const loadId = (state.loadId += 1);
      const source = dom.forecastSource.value;
      state.source = source;
      let byKm;
      let notes = [{ key: `source.${source}` }];
      if (source in LIVE_SOURCES) {
        const { name } = LIVE_SOURCES[source];
        state.status = { loading: name, notes: [], spans: [] };
        renderStatus();
        try {
          byKm = await fetchOpenMeteoForecast(route, dom.startDate.value || DEFAULT_START_DATE, source);
        } catch (error) {
          byKm = parseForecast(data.forecast);
          notes = [{ key: 'source.unavailable', params: { name, message: error.message } }, { key: 'source.yr' }];
        }
      } else {
        byKm = parseForecast(source === 'yr' ? data.forecast : dom.forecastText.value);
      }
      if (loadId !== state.loadId) return;
      if (source !== 'custom') dom.forecastText.value = toForecastCsv(byKm);
      setForecast(byKm, notes);
      render();
    }

    function scheduleReload() {
      clearTimeout(state.reloadTimer);
      state.reloadTimer = setTimeout(loadForecast, RELOAD_DELAY_MS);
    }

    const number = (input, fallback) => Number(input.value) || fallback;

    function readPlan() {
      const [year, month, day] = (dom.startDate.value || DEFAULT_START_DATE).split('-').map(Number);
      const [hour, minute] = (dom.startTime.value || '12:00').split(':').map(Number);
      return {
        mode: state.paceMode,
        speedKmh: Math.max(5, number(dom.speed, 22.9)),
        powerW: Math.max(20, number(dom.power, 150)),
        startTime: Date.UTC(year, month - 1, day, hour, minute),
        stopsKm: dom.stopsKm.value
          .split(/[ ,;]+/)
          .map(Number)
          .filter((km) => km > 0 && km < route.totalKm),
        stopMinutes: Math.max(0, number(dom.stopMinutes, 0)),
        riderKg: number(dom.riderKg, 75),
        windShare: Math.max(0, Number(dom.windShare.value) / 100 || 0),
        rider: {
          massKg: number(dom.riderKg, 75) + number(dom.kitKg, 11),
          cda: Number(dom.cda.value),
          crr: Number(dom.crr.value),
        },
      };
    }

    function setActive(container, attribute, value) {
      for (const button of container.querySelectorAll('button')) {
        button.classList.toggle('is-active', button.dataset[attribute] === value);
      }
    }

    function setPace(mode) {
      state.paceMode = mode;
      setActive(dom.paceMode, 'pace', mode);
      dom.speed.classList.toggle('is-computed', mode === 'power');
      dom.power.classList.toggle('is-computed', mode === 'speed');
    }

    function updatePresets() {
      for (const button of dom.presets.children) {
        button.classList.toggle('is-active', parseFloat(button.textContent) === Number(dom.speed.value));
      }
    }

    // --- rendering
    function renderMap() {
      const { samples, plan } = state;
      const at = (km) => {
        const p = route.pointAt(km);
        return project(p.lat, p.lon);
      };
      const colourOf = (s) => {
        if (state.mapMode === 'rain') return rainColour(s.weather?.rainMm3h);
        if (state.mapMode === 'temperature') return temperatureColour(s.weather?.tempC, state.temperatureScale);
        return headwindColour(s.headwindKmh);
      };
      const coords = ([x, y]) => `${fixed1(x)},${fixed1(y)}`;
      let svg =
        boundaryLayer +
        tag('polyline', {
          class: 'route-base',
          points: route.points.map((p) => coords(project(p[0], p[1]))).join(' '),
        });
      for (let i = 0; i < samples.length - 1; i += 1) {
        const [x1, y1] = at(samples[i].km);
        const [x2, y2] = at(samples[i + 1].km);
        svg += tag('line', {
          class: 'route-segment',
          x1: fixed1(x1),
          y1: fixed1(y1),
          x2: fixed1(x2),
          y2: fixed1(y2),
          stroke: colourOf(samples[i]),
        });
      }
      for (let km = MAP.tickKm; km < route.totalKm; km += MAP.tickKm) {
        const [x, y] = at(km);
        svg +=
          tag('circle', { class: 'km-dot', cx: x, cy: y, r: 2.5 }) +
          tag('text', { class: 'map-label map-label--mute', x: x + 7, y: y + 4 }, km);
      }
      for (const km of state.weather.stationKms) {
        const [x, y] = at(km);
        svg += tag('circle', { class: 'station-dot', cx: x, cy: y, r: 6 });
      }
      const [startX, startY] = at(0);
      const [endX, endY] = at(route.totalKm);
      svg += tag(
        'text',
        { class: 'map-label map-label--major', 'text-anchor': 'end', x: startX - 10, y: startY - 8 },
        t('map.start', { name: data.stations.start }),
      );
      svg += tag(
        'text',
        { class: 'map-label map-label--major', x: endX + 10, y: endY + 14 },
        t('map.finish', { name: finish.name }),
      );
      for (const km of plan.stopsKm) {
        const [x, y] = at(km);
        svg += tag('rect', { class: 'stop-box', x: x - 5, y: y - 5, width: 10, height: 10, rx: 2 });
      }
      for (const station of stations.filter((s) => s.km < route.totalKm - 1)) {
        const [x, y] = at(station.km);
        svg += tag('text', { class: 'map-label', x: x + 9, y: y - 8 }, station.name);
      }
      dom.map.innerHTML = svg + tag('g', { id: 'map-marker' });
      dom.map.setAttribute('aria-label', t('map.aria', { mode: t(`mode.name.${state.mapMode}`) }));
      const legendItems =
        state.mapMode === 'temperature'
          ? temperatureLegend(state.temperatureScale)
          : LEGENDS[state.mapMode].map(([modifier, key]) => [modifier, t(key)]);
      const fixedItems = [
        ['swatch--stop', t('legend.stop')],
        ['swatch--province', t('legend.province')],
        ['swatch--country', t('legend.country')],
      ];
      dom.legend.innerHTML = [...fixedItems, ...legendItems]
        .map(([modifier, label, colour]) => `<span>${swatch(modifier, colour)}${label}</span>`)
        .join('');
    }

    function renderSummary() {
      const { plan, ride, samples } = state;
      const stats = summariseSamples(samples);
      const finishTime = ride.times.at(-1);
      const speedKmh = route.totalKm / ride.ridingHours;
      const strong = (text) => tag('b', { class: 'strong' }, text);
      const duration = (hours) => formatDuration(hours, (parts) => t('duration', parts));
      const lines = [
        t('summary.trip', {
          km: strong(`${route.totalKm.toFixed(0)} km`),
          riding: duration(ride.ridingHours),
          stops: plan.stopsKm.length,
          minutes: plan.stopMinutes,
          finish: strong(fmt.dateTime(finishTime)),
          elapsed: duration((finishTime - plan.startTime) / MS_PER_HOUR),
        }),
        t('summary.averages', {
          speed: strong(`${fixed1(speedKmh)} ${t('unit.kmh')}`),
          power: strong(`${Math.round(ride.averagePowerW)} W`),
          wkg: fixed1(ride.averagePowerW / plan.riderKg),
        }),
      ];
      if (stats.measured) {
        const sign = stats.meanHeadwindKmh >= 0 ? '+' : '';
        lines.push(
          t('summary.headwind', { value: `${sign}${fixed1(stats.meanHeadwindKmh)}` }),
          t('summary.temperature', { low: Math.round(stats.tempMin), high: Math.round(stats.tempMax) }),
          stats.wetShare
            ? t('summary.rain', {
                share: Math.round(stats.wetShare * 100),
                rate: fixed1(stats.heaviest.weather.rainMm3h / 3),
                km: stats.heaviest.km.toFixed(0),
              })
            : t('summary.dry'),
        );
      }
      let html = lines.join('<br>');
      if (stats.missingShare > 0) {
        html += `<div class="warn">${t('summary.missing', { share: Math.round(stats.missingShare * 100) })}</div>`;
      }
      dom.summary.innerHTML = html;
      if (state.paceMode === 'speed') dom.power.value = Math.round(ride.averagePowerW);
      else dom.speed.value = fixed1(speedKmh);
    }

    function renderStations() {
      const { plan, ride } = state;
      const dayStart = Math.floor(plan.startTime / MS_PER_DAY) * MS_PER_DAY;
      const rows = stations
        .map((station) => {
          const arrival = ride.arrivalAt(station.km);
          const status = stationStatus(arrival, dayStart, station);
          const name = station === stations.at(-1) ? t('map.finish', { name: station.name }) : station.name;
          return (
            `<tr><td>${name}</td><td>${Math.round(station.km)}</td><td>${formatClockHour(station.opens)} / ${formatClockHour(station.closes)}</td>` +
            `<td>${fmt.dayClock(arrival)}</td><td class="status status--${status.state}">${t(`stationStatus.${status.state}`, { m: status.minutes })}</td></tr>`
          );
        })
        .join('');
      const header = ['station', 'km', 'times', 'arrive', 'status']
        .map((c) => `<th>${t(`stations.col.${c}`)}</th>`)
        .join('');
      dom.stations.innerHTML = `<table><tr>${header}</tr>${rows}</table><p class="note">${t('stations.note')}</p>`;
    }

    function renderReadout(point) {
      const sample = point.weather;
      if (!sample) {
        dom.readout.innerHTML =
          `<div class="big">${t('readout.noForecast', { time: fmt.dateTime(point.time) })}</div>` +
          `<p class="warn">${t('readout.noForecastHint')}</p>`;
        return;
      }
      const head = point.headwindKmh;
      const tone = head > HEADWIND.neutralKmh ? 'big--head' : head < -HEADWIND.neutralKmh ? 'big--tail' : '';
      const headline =
        Math.abs(head) < HEADWIND.neutralKmh
          ? t('readout.crosswind')
          : t(head > 0 ? 'readout.headwind' : 'readout.tailwind', { n: Math.abs(head).toFixed(0) });
      const kmh = t('unit.kmh');
      const cell = (key, value) => `<div><span>${t(key)}</span>${value}</div>`;
      const gust =
        sample.gustKts > sample.windKts + 0.05 ? `${(sample.gustKts * KNOTS_TO_KMH).toFixed(0)} ${kmh}` : t('cell.na');
      const context = t('readout.context', {
        dir: compassLabel(point.bearing, t),
        from: compassLabel(sample.dir, t),
        sky: skyLabel(sample, t),
      });
      dom.readout.innerHTML =
        `<div class="big ${tone}">${headline}</div>` +
        `<div class="muted">${context}</div>` +
        '<div class="grid">' +
        cell('cell.speed', `<b>${fixed1(point.speedKmh)} ${kmh}</b>`) +
        cell('cell.power', `<b>${Math.round(point.powerW)} W</b>`) +
        cell(
          'cell.wind',
          `<b>${point.windKmh.toFixed(0)} ${kmh}</b> <small>(${sample.windKts.toFixed(0)} ${t('unit.kts')})</small>`,
        ) +
        cell('cell.gusts', `<b>${gust}</b>`) +
        cell('cell.crosswind', `<b>${Math.abs(point.crosswindKmh).toFixed(0)} ${kmh}</b>`) +
        cell('cell.temperature', `<b>${sample.tempC.toFixed(0)} °C</b>`) +
        cell(
          'cell.rain',
          `<b>${rainLabel(sample.rainMm3h, t)}</b> <small>(${fixed1(sample.rainMm3h / 3)} ${t('unit.mmh')})</small>`,
        ) +
        cell('cell.cloud', `<b>${sample.cloudPct.toFixed(0)}%</b>`) +
        '</div>';
    }

    /** Moves the marker, chart cursors and readout to the slider position (cheap; no re-simulation). */
    function updateCursor() {
      const km = Number(dom.position.value);
      const point = describePoint(route, state.weather, state.ride, km);
      const [x, y] = project(route.pointAt(km).lat, route.pointAt(km).lon);
      dom.positionLabel.textContent = `km ${fixed1(km)} · ${fmt.dateTime(point.time)}`;
      const arrow = point.weather
        ? tag(
            'g',
            { transform: `translate(${x} ${y}) rotate(${(point.weather.dir + 180) % 360}) scale(1.5)` },
            tag('path', { class: 'marker-arrow', d: 'M0,-16 L5,-5 L1.5,-5 L1.5,10 L-1.5,10 L-1.5,-5 L-5,-5Z' }),
          )
        : '';
      const marker = dom.map.querySelector('#map-marker');
      if (marker) marker.innerHTML = tag('circle', { class: 'marker-ring', cx: x, cy: y, r: 11 }) + arrow;
      for (const svg of Object.values(dom.charts)) {
        const cursor = svg.querySelector('.cursor');
        if (cursor) {
          cursor.setAttribute('x1', chartX(km, route.totalKm));
          cursor.setAttribute('x2', chartX(km, route.totalKm));
        }
      }
      renderReadout(point);
      const { lat, lon } = route.pointAt(km);
      dom.windfinderLink.href = windfinderUrl(lat, lon);
      dom.windfinderLink.textContent = t('windfinder.link', { km: km.toFixed(0) });
    }

    function render() {
      state.plan = readPlan();
      state.ride = simulate(route, state.weather, state.plan);
      const count = Math.ceil(route.totalKm / SAMPLE_STEP_KM);
      state.samples = Array.from({ length: count + 1 }, (_, i) =>
        describePoint(route, state.weather, state.ride, Math.min(route.totalKm, i * SAMPLE_STEP_KM)),
      );
      state.temperatureScale = fitTemperatureScale(state.samples.filter((s) => s.weather).map((s) => s.weather.tempC));
      renderMap();
      const specs = chartSpecs(state.samples, state.temperatureScale, t);
      for (const [name, svg] of Object.entries(dom.charts)) drawChart(svg, specs[name], chartContext());
      renderSummary();
      renderStations();
      updateCursor();
    }

    // --- language
    function buildPresets() {
      dom.presets.replaceChildren();
      const addPreset = (label, onClick) => {
        const button = document.createElement('button');
        button.textContent = label;
        button.addEventListener('click', () => {
          onClick();
          setPace('speed');
          updatePresets();
          render();
        });
        dom.presets.appendChild(button);
      };
      for (const kmh of SPEED_PRESETS_KMH) {
        addPreset(t('preset.kmh', { n: kmh }), () => {
          dom.speed.value = kmh;
        });
      }
      addPreset(t('preset.finish24'), () => {
        const { stopsKm, stopMinutes } = readPlan();
        dom.speed.value = (route.totalKm / Math.max(1, TARGET_HOURS - (stopsKm.length * stopMinutes) / 60)).toFixed(2);
      });
      updatePresets();
    }

    /** Writes the translated text of everything marked with data-i18n, data-i18n-html or data-i18n-aria. */
    function applyStaticTranslations() {
      document.documentElement.lang = state.language;
      document.title = t('page.title');
      for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = t(node.dataset.i18n);
      for (const node of document.querySelectorAll('[data-i18n-html]')) node.innerHTML = t(node.dataset.i18nHtml);
      for (const node of document.querySelectorAll('[data-i18n-aria]')) {
        node.setAttribute('aria-label', t(node.dataset.i18nAria));
      }
      for (const button of dom.langSwitch.querySelectorAll('button')) {
        const active = button.dataset.lang === state.language;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-pressed', String(active));
      }
    }

    function setLanguage(language, { persist = true } = {}) {
      state.language = language;
      t = createTranslator(data.translations, language);
      fmt = createFormatters(language);
      applyStaticTranslations();
      buildPresets();
      if (state.plan) {
        renderStatus();
        render();
      }
      if (persist) data.onLanguageChange?.(language);
    }

    // --- events
    function init() {
      dom.position.max = route.totalKm;
      dom.windfinderPoints.innerHTML = forecastPointKms(route.totalKm)
        .map((km) => {
          const { lat, lon } = route.pointAt(km);
          return `<a href="${windfinderUrl(lat, lon)}" target="_blank" rel="noopener">km ${Math.round(km)}</a>`;
        })
        .join(' · ');

      const inputs = [
        dom.speed,
        dom.power,
        dom.startDate,
        dom.startTime,
        dom.stopsKm,
        dom.stopMinutes,
        dom.riderKg,
        dom.kitKg,
        dom.cda,
        dom.crr,
        dom.windShare,
      ];
      for (const input of inputs) {
        input.addEventListener('input', () => {
          if (input === dom.speed) setPace('speed');
          if (input === dom.power) setPace('power');
          updatePresets();
          render();
          if (input === dom.startDate && state.source in LIVE_SOURCES) scheduleReload();
        });
      }
      dom.forecastSource.addEventListener('change', loadForecast);
      dom.paceMode.addEventListener('click', (event) => {
        if (event.target.dataset.pace) {
          setPace(event.target.dataset.pace);
          render();
        }
      });
      dom.mapMode.addEventListener('click', (event) => {
        if (!event.target.dataset.mode) return;
        state.mapMode = event.target.dataset.mode;
        setActive(dom.mapMode, 'mode', state.mapMode);
        renderMap();
        updateCursor();
      });
      dom.position.addEventListener('input', updateCursor);
      dom.langSwitch.addEventListener('click', (event) => {
        const button = event.target.closest('button[data-lang]');
        if (button) setLanguage(button.dataset.lang);
      });
      dom.applyForecast.addEventListener('click', () => {
        dom.forecastSource.value = 'custom';
        loadForecast();
      });
      for (const svg of Object.values(dom.charts)) {
        svg.addEventListener('click', (event) => {
          const rect = svg.getBoundingClientRect();
          const x = ((event.clientX - rect.left) / rect.width) * CHART.width;
          dom.position.value = clamp((x - CHART.padLeft) / (CHART.width - CHART.padLeft), 0, 1) * route.totalKm;
          updateCursor();
        });
      }
      setLanguage(state.language, { persist: false });
      setPace('speed');
      updatePresets();
      render();
      loadForecast();
    }

    return { init };
  }

  function queryDom() {
    const byId = (id) => document.getElementById(id);
    return {
      map: byId('map'),
      legend: byId('legend'),
      mapMode: byId('map-mode'),
      position: byId('position'),
      positionLabel: byId('position-label'),
      paceMode: byId('pace-mode'),
      speed: byId('speed'),
      power: byId('power'),
      presets: byId('speed-presets'),
      startDate: byId('start-date'),
      startTime: byId('start-time'),
      stopsKm: byId('stops-km'),
      stopMinutes: byId('stop-minutes'),
      riderKg: byId('rider-kg'),
      kitKg: byId('kit-kg'),
      cda: byId('cda'),
      crr: byId('crr'),
      windShare: byId('wind-share'),
      summary: byId('summary'),
      readout: byId('readout'),
      stations: byId('stations'),
      forecastText: byId('forecast-text'),
      langSwitch: document.querySelector('.lang-switch'),
      forecastSource: byId('forecast-source'),
      forecastStatus: byId('forecast-status'),
      coverage: byId('coverage'),
      applyForecast: byId('apply-forecast'),
      windfinderLink: byId('windfinder-link'),
      windfinderPoints: byId('windfinder-points'),
      charts: {
        wind: byId('wind-chart'),
        rain: byId('rain-chart'),
        temperature: byId('temperature-chart'),
        power: byId('power-chart'),
      },
    };
  }

  function readStoredLanguage() {
    try {
      return localStorage.getItem(LANGUAGE_STORAGE_KEY);
    } catch {
      return null; // storage is blocked (private mode, some file:// setups)
    }
  }

  function storeLanguage(language) {
    try {
      localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
    } catch {
      // not persisted; the choice still applies for this visit
    }
  }

  function start() {
    const text = (id) => document.getElementById(id).textContent;
    const translations = JSON.parse(text('translations-data'));
    const browserLanguages = navigator.languages?.length ? navigator.languages : [navigator.language ?? ''];
    createApp(queryDom(), {
      route: JSON.parse(text('route-data')),
      stations: JSON.parse(text('stations-data')),
      boundaries: JSON.parse(text('boundaries-data')),
      forecast: text('forecast-data').trim(),
      translations,
      language: detectLanguage(readStoredLanguage(), browserLanguages, Object.keys(translations)),
      onLanguageChange: storeLanguage,
    }).init();
  }

  // ------------------------------------------------------------------ entry point
  const model = {
    createRoute,
    parseForecast,
    createWeather,
    simulate,
    describePoint,
    powerAtSpeed,
    speedAtPower,
    stationStatus,
    formatDuration,
    blendSamples,
    parseOpenMeteo,
    buildOpenMeteoUrl,
    forecastPointKms,
    fetchOpenMeteoForecast,
    toForecastCsv,
    temperatureColour,
    fitTemperatureScale,
    createTranslator,
    detectLanguage,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = model;
  else start();
})();
