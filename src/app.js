'use strict';

/**
 * RideCast: weather and power along the route.
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

  const MAP = Object.freeze({ width: 600, height: 640, margin: 40, referenceLat: 52.4, tickKm: 50 });
  const CHART = Object.freeze({ width: 600, padLeft: 36 });
  const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

  const STRINGS = {
    en: {
      languageLabel: 'Language',
      title: 'RideCast: weather on your ride',
      pageTitle: 'RideCast – weather on the route',
      preset24: '24 h finish',
      intro:
        'Set your speed or power, then drag the slider to see your position and the wind and weather you will meet. Live forecast from <a href="https://api.met.no/weatherapi/locationforecast/2.0/documentation" target="_blank" rel="noopener">MET Norway</a> under <a href="https://api.met.no/doc/License" target="_blank" rel="noopener">CC BY 4.0</a>; values are converted to app units and interpolated between three route points.',
      colourRouteBy: 'Colour route by',
      wind: 'Wind',
      rain: 'Rain',
      mapAria: 'Route map coloured by headwind',
      positionOnRoute: 'Position on route:',
      headwindTitle: 'Headwind along the route',
      headwindAria: 'Headwind profile',
      rainTitle: 'Rain along the route',
      rainAria: 'Rain profile',
      powerTitle: 'Power needed along the route',
      powerAria: 'Power profile',
      yourRide: 'Your ride',
      paceBy: 'Pace by',
      speed: 'Speed',
      power: 'Power',
      averageSpeed: 'Average speed (km/h)',
      averagePower: 'Average power (W)',
      startDate: 'Start date',
      startTime: 'Start time',
      stopsAtKm: 'Stops at km (comma-separated)',
      minutesPerStop: 'Minutes per stop',
      riderWeight: 'Rider weight (kg)',
      bikeKitWeight: 'Bike + kit (kg)',
      ridingPosition: 'Riding position',
      aeroDrops: 'Aero / drops',
      onHoods: 'On the hoods',
      upright: 'Upright',
      roadSurface: 'Road surface',
      smoothAsphalt: 'Smooth asphalt',
      mixed: 'Mixed',
      rough: 'Rough',
      windShare: 'Wind at rider (% of forecast)',
      atThisPoint: 'At this point',
      refreshmentStations: 'Refreshment stations',
      forecastDataTitle: 'Forecast data (paste more from Windfinder)',
      forecastHelp:
        'One row per forecast step: station km, date, hour, wind direction, wind and gust in knots, temperature, rain and cloud. Live data is requested at km 0, 171 and 504. Coverage depends on the selected date; MET Norway typically publishes about nine days ahead. If live data is unavailable, the bundled CSV remains below. Windfinder shows where the wind comes from.',
      applyData: 'Apply data',
      openSpot: 'Open a spot:',
      stop: 'stop',
      headwind: 'headwind',
      tailwind: 'tailwind',
      crosswindNoData: 'crosswind / no data',
      dryNoData: 'dry / no data',
      light: 'light',
      moderate: 'moderate',
      heavy: 'heavy',
      noValidRows: 'No valid rows',
      bundledForecast: 'Using bundled forecast while live data loads.',
      liveUnavailable: 'Live forecast unavailable; using bundled forecast data.',
      loadingLive: 'Loading live forecast from MET Norway...',
      liveFetched: 'Live forecast from MET Norway, fetched {date} UTC.',
      livePartial: 'Live forecast loaded for {loaded} of {total} route points; bundled data fills the rest.',
      coverage: 'km {km}: {from} to {to}',
      start: 'start',
      finish: 'finish',
      riding: 'riding',
      stops: 'stops',
      elapsed: 'elapsed',
      averageSpeedShort: 'Average speed',
      averagePowerShort: 'average power',
      averageHeadwind: 'Average headwind component:',
      negativeTailwind: '(negative = tailwind)',
      rainOnAbout: 'Rain on about',
      routeHeaviest: '% of the route, heaviest {rain} mm/h near km {km}',
      dryWholeRoute: 'Dry along the whole route at these times',
      missingForecast:
        'No forecast loaded for {share}% of the route at these times. Change the date or paste forecast data below.',
      earlyBy: 'early by {minutes} min',
      lateBy: 'late by {minutes} min',
      inWindow: 'in window',
      station: 'Station',
      times: 'Times',
      youArrive: 'You arrive',
      status: 'Status',
      stationNote:
        'Times are the two clock times the organiser lists per station, read here as a window. Stop positions follow the stage lengths: 109, 102, 110, 81 and 99 km.',
      noForecastAt: 'No forecast for {date}',
      noForecastHelp:
        'Yr forecasts cover about 9 days ahead. Pick a date inside the loaded data, or paste race-day values under “Forecast data”.',
      mostlyCrosswind: 'Mostly crosswind',
      windFrom: 'wind from',
      overcast: 'Overcast',
      cloudy: 'Mostly cloudy',
      partlyCloudy: 'Partly cloudy',
      clear: 'Clear',
      dry: 'Dry',
      lightRain: 'Light rain',
      moderateRain: 'Moderate rain',
      heavyRain: 'Heavy rain',
      gusts: 'Gusts',
      crosswind: 'Crosswind',
      temperature: 'Temperature',
      cloud: 'Cloud',
      headwindChart: 'headwind, km/h',
      tailwindChart: 'tailwind, km/h',
      rainChart: 'rain, mm per 3 h (6 or more = top of scale)',
      powerChart: 'power, W · peak {peak} W (0 = coasting)',
      hoursShort: 'h',
      minutesShort: 'm',
      windfinderMap: 'Windfinder map at km {km}',
    },
    nl: {
      languageLabel: 'Taal',
      title: 'RideCast: het weer tijdens je rit',
      pageTitle: 'RideCast – het weer op de route',
      preset24: 'Finish in 24 u',
      intro:
        'Stel je snelheid of vermogen in en versleep de schuifregelaar om je positie en het weer en de wind onderweg te bekijken. Liveverwachting van <a href="https://api.met.no/weatherapi/locationforecast/2.0/documentation" target="_blank" rel="noopener">MET Norway</a> onder <a href="https://api.met.no/doc/License" target="_blank" rel="noopener">CC BY 4.0</a>; waarden zijn omgerekend naar app-eenheden en geïnterpoleerd tussen drie routepunten.',
      colourRouteBy: 'Kleur route op',
      wind: 'Wind',
      rain: 'Regen',
      mapAria: 'Routekaart gekleurd op tegenwind',
      positionOnRoute: 'Positie op route:',
      headwindTitle: 'Tegenwind langs de route',
      headwindAria: 'Profiel van tegenwind',
      rainTitle: 'Regen langs de route',
      rainAria: 'Regenprofiel',
      powerTitle: 'Benodigd vermogen langs de route',
      powerAria: 'Vermogensprofiel',
      yourRide: 'Jouw rit',
      paceBy: 'Rit op basis van',
      speed: 'Snelheid',
      power: 'Vermogen',
      averageSpeed: 'Gemiddelde snelheid (km/u)',
      averagePower: 'Gemiddeld vermogen (W)',
      startDate: 'Startdatum',
      startTime: 'Starttijd',
      stopsAtKm: 'Stops op km (gescheiden door komma’s)',
      minutesPerStop: 'Minuten per stop',
      riderWeight: 'Gewicht fietser (kg)',
      bikeKitWeight: 'Fiets + uitrusting (kg)',
      ridingPosition: 'Fietshouding',
      aeroDrops: 'Aero / onderin de beugels',
      onHoods: 'Op de grepen',
      upright: 'Rechtop',
      roadSurface: 'Wegdek',
      smoothAsphalt: 'Glad asfalt',
      mixed: 'Gemengd',
      rough: 'Ruw',
      windShare: 'Wind bij fietser (% van verwachting)',
      atThisPoint: 'Op dit punt',
      refreshmentStations: 'Verzorgingsposten',
      forecastDataTitle: 'Verwachtingsgegevens (plak meer uit Windfinder)',
      forecastHelp:
        'Eén regel per verwachtingsmoment: post-km, datum, uur, windrichting, wind en windstoten in knopen, temperatuur, regen en bewolking. Livegegevens worden bij km 0, 171 en 504 opgevraagd. De dekking hangt af van de gekozen datum; MET Norway publiceert meestal ongeveer negen dagen vooruit. Als livegegevens ontbreken, blijft de meegeleverde CSV hieronder beschikbaar. Windfinder toont waar de wind vandaan komt.',
      applyData: 'Gegevens toepassen',
      openSpot: 'Open een locatie:',
      stop: 'stop',
      headwind: 'tegenwind',
      tailwind: 'meewind',
      crosswindNoData: 'zijwind / geen gegevens',
      dryNoData: 'droog / geen gegevens',
      light: 'licht',
      moderate: 'matig',
      heavy: 'zwaar',
      noValidRows: 'Geen geldige regels',
      bundledForecast: 'Meegeleverde verwachting wordt gebruikt terwijl livegegevens laden.',
      liveUnavailable: 'Liveverwachting niet beschikbaar; meegeleverde gegevens worden gebruikt.',
      loadingLive: 'Liveverwachting van MET Norway laden...',
      liveFetched: 'Liveverwachting van MET Norway, opgehaald op {date} UTC.',
      livePartial:
        'Liveverwachting geladen voor {loaded} van {total} routepunten; de rest komt uit de meegeleverde gegevens.',
      coverage: 'km {km}: {from} tot {to}',
      start: 'start',
      finish: 'finish',
      riding: 'fietsen',
      stops: 'stops',
      elapsed: 'verstreken',
      averageSpeedShort: 'Gemiddelde snelheid',
      averagePowerShort: 'gemiddeld vermogen',
      averageHeadwind: 'Gemiddelde tegenwindcomponent:',
      negativeTailwind: '(negatief = meewind)',
      rainOnAbout: 'Regen op ongeveer',
      routeHeaviest: '% van de route, meeste regen {rain} mm/u bij km {km}',
      dryWholeRoute: 'Op deze tijden blijft het de hele route droog',
      missingForecast:
        'Geen verwachting voor {share}% van de route op deze tijden. Wijzig de datum of plak hieronder gegevens.',
      earlyBy: '{minutes} min te vroeg',
      lateBy: '{minutes} min te laat',
      inWindow: 'binnen tijdvenster',
      station: 'Post',
      times: 'Tijden',
      youArrive: 'Aankomst',
      status: 'Status',
      stationNote:
        'Per post staan hier de twee door de organisatie vermelde tijden, opgevat als tijdvenster. De stoplocaties volgen de etappelengtes: 109, 102, 110, 81 en 99 km.',
      noForecastAt: 'Geen verwachting voor {date}',
      noForecastHelp:
        'Yr-verwachtingen gaan ongeveer 9 dagen vooruit. Kies een datum binnen de geladen gegevens of plak wedstrijddagwaarden onder “Verwachtingsgegevens”.',
      mostlyCrosswind: 'Overwegend zijwind',
      windFrom: 'wind uit',
      overcast: 'Zwaar bewolkt',
      cloudy: 'Overwegend bewolkt',
      partlyCloudy: 'Licht bewolkt',
      clear: 'Helder',
      dry: 'Droog',
      lightRain: 'Lichte regen',
      moderateRain: 'Matige regen',
      heavyRain: 'Zware regen',
      gusts: 'Windstoten',
      crosswind: 'Zijwind',
      temperature: 'Temperatuur',
      cloud: 'Bewolking',
      headwindChart: 'tegenwind, km/u',
      tailwindChart: 'meewind, km/u',
      rainChart: 'regen, mm per 3 u (6 of meer = maximum)',
      powerChart: 'vermogen, W · piek {peak} W (0 = uitrollen)',
      hoursShort: 'u',
      minutesShort: 'm',
      windfinderMap: 'Windfinder-kaart op km {km}',
    },
  };

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

  /** Converts MET Norway Locationforecast data into the app's weather samples. */
  function parseYrForecast(payload) {
    const timeseries = payload?.properties?.timeseries;
    if (!Array.isArray(timeseries)) return [];
    const intervals = [
      ['next_1_hours', 1],
      ['next_6_hours', 6],
      ['next_12_hours', 12],
    ];
    return timeseries
      .flatMap(({ time, data }) => {
        const instant = data?.instant?.details;
        if (!instant) return [];
        const windMs = instant.wind_speed;
        const direction = instant.wind_from_direction;
        const temperature = instant.air_temperature;
        const timestamp = Date.parse(time);
        if (![windMs, direction, temperature, timestamp].every(Number.isFinite)) return [];

        let precipitation = 0;
        let intervalHours = 1;
        for (const [key, hours] of intervals) {
          const amount = data[key]?.details?.precipitation_amount;
          if (Number.isFinite(amount)) {
            precipitation = amount;
            intervalHours = hours;
            break;
          }
        }
        const gustMs = instant.wind_speed_of_gust;
        return [
          {
            time: timestamp,
            dir: direction,
            windKts: windMs / KNOTS_TO_MS,
            gustKts: Number.isFinite(gustMs) ? gustMs / KNOTS_TO_MS : windMs / KNOTS_TO_MS,
            tempC: temperature,
            rainMm3h: (precipitation * 3) / intervalHours,
            cloudPct: Number.isFinite(instant.cloud_area_fraction) ? instant.cloud_area_fraction : 0,
          },
        ];
      })
      .sort((a, b) => a.time - b.time);
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
  function formatDuration(hours) {
    const minutes = Math.round(hours * 60);
    return `${Math.floor(minutes / 60)}h ${pad2(minutes % 60)}m`;
  }
  const formatClockHour = (hours) => `${pad2(Math.floor(hours) % 24)}:00`;
  const compassLabel = (degrees) => `${COMPASS[Math.round(degrees / 22.5) % 16]} (${Math.round(degrees)}°)`;

  function skyLabel(sample, translate) {
    if (sample.rainMm3h >= RAIN.dry) return translate('rain');
    if (sample.cloudPct > 85) return translate('overcast');
    if (sample.cloudPct > 50) return translate('cloudy');
    return sample.cloudPct > 20 ? translate('partlyCloudy') : translate('clear');
  }

  function rainLabel(mm3h, translate) {
    if (mm3h < RAIN.dry) return translate('dry');
    if (mm3h < RAIN.light) return translate('lightRain');
    return mm3h < RAIN.moderate ? translate('moderateRain') : translate('heavyRain');
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

  // ------------------------------------------------------------------ view helpers
  function tag(name, attributes, inner = '') {
    const attrs = Object.entries(attributes)
      .map(([key, value]) => ` ${key}="${value}"`)
      .join('');
    return `<${name}${attrs}>${inner}</${name}>`;
  }
  const fixed1 = (value) => value.toFixed(1);

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
    const { height, baseline, pxPerUnit, limits, minBarPx } = spec;
    const barWidth = (CHART.width - CHART.padLeft) / spec.bars.length;
    const grid = spec.ticks
      .map((value) => {
        const y = fixed1(baseline - value * pxPerUnit);
        const label = (spec.signedTicks && value > 0 ? '+' : '') + value;
        return (
          tag('line', {
            class: value ? 'gridline gridline--dashed' : 'gridline',
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
        const px = clamp(bar.value, limits[0], limits[1]) * pxPerUnit;
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
  function chartSpecs(samples, translate) {
    const limit = HEADWIND.chartLimitKmh;
    const peakPower = Math.max(...samples.map((s) => s.powerW));
    const powerTop = Math.max(150, peakPower);
    const powerStep = powerTop > 400 ? 100 : powerTop > 200 ? 50 : 25;
    const powerTicks = [];
    for (let value = 0; value <= powerTop; value += powerStep) powerTicks.push(value);

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
          { text: translate('headwindChart'), y: 10, class: 'chart-label chart-label--head' },
          { text: translate('tailwindChart'), y: 117, class: 'chart-label chart-label--tail' },
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
        captions: [{ text: translate('rainChart'), y: 10, class: 'chart-label' }],
        bars: samples.map((s) =>
          s.weather ? { value: s.weather.rainMm3h, colour: rainColour(s.weather.rainMm3h) } : null,
        ),
      },
      power: {
        height: 100,
        baseline: 90,
        pxPerUnit: 76 / powerTop,
        limits: [0, powerTop],
        minBarPx: 0.5,
        ticks: powerTicks,
        captions: [{ text: translate('powerChart', { peak: Math.round(peakPower) }), y: 10, class: 'chart-label' }],
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
    return {
      measured: withWeather.length,
      missingShare: 1 - withWeather.length / samples.length,
      meanHeadwindKmh: withWeather.reduce((sum, s) => sum + s.headwindKmh, 0) / (withWeather.length || 1),
      wetShare: wet.length / (withWeather.length || 1),
      heaviest,
    };
  }

  const swatch = (modifier) => tag('i', { class: `swatch ${modifier}`.trim() });
  const LEGENDS = {
    wind: [
      ['swatch--head', 'headwind'],
      ['swatch--tail', 'tailwind'],
      ['', 'crosswindNoData'],
    ],
    rain: [
      ['', 'dryNoData'],
      ['swatch--light', 'light'],
      ['swatch--moderate', 'moderate'],
      ['swatch--heavy', 'heavy'],
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
    const finish = data.stations.stations.at(-1);
    const stations = data.stations.stations.map((s) => ({ ...s, km: s.km ?? route.totalKm }));
    let savedLanguage;
    try {
      savedLanguage = localStorage.getItem('ride-cast-language');
    } catch {
      savedLanguage = null;
    }
    const state = {
      weather: null,
      mapMode: 'wind',
      paceMode: 'speed',
      ride: null,
      samples: [],
      plan: null,
      language: savedLanguage === 'nl' ? 'nl' : 'en',
      weatherStatus: 'bundledForecast',
      weatherStatusValues: {},
    };
    let dateTimeFormat;
    let dayClockFormat;
    const translate = (key, values = {}) =>
      (STRINGS[state.language][key] || STRINGS.en[key] || key).replace(/\{(\w+)\}/g, (_, name) => values[name] ?? '');
    const updateDateFormats = () => {
      const locale = state.language === 'nl' ? 'nl-NL' : 'en-GB';
      dateTimeFormat = new Intl.DateTimeFormat(locale, {
        timeZone: 'UTC',
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      });
      dayClockFormat = new Intl.DateTimeFormat(locale, {
        timeZone: 'UTC',
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
      });
    };
    const applyStaticTranslations = () => {
      document.documentElement.lang = state.language;
      for (const element of document.querySelectorAll('[data-i18n]')) {
        element.textContent = translate(element.dataset.i18n);
      }
      for (const element of document.querySelectorAll('[data-i18n-html]')) {
        element.innerHTML = translate(element.dataset.i18nHtml);
      }
      for (const element of document.querySelectorAll('[data-i18n-prefix]')) {
        element.firstChild.nodeValue = `${translate(element.dataset.i18nPrefix)} `;
      }
      for (const element of document.querySelectorAll('[data-i18n-aria]')) {
        element.setAttribute('aria-label', translate(element.dataset.i18nAria));
      }
      document.title = translate('pageTitle');
      const finishPreset = dom.presets.lastElementChild;
      if (finishPreset) finishPreset.textContent = translate('preset24');
      for (const button of dom.languageControl.querySelectorAll('[data-language]')) {
        const selected = button.dataset.language === state.language;
        button.classList.toggle('is-active', selected);
        button.setAttribute('aria-pressed', String(selected));
      }
    };
    const setWeatherStatus = (key, values = {}) => {
      state.weatherStatus = key;
      state.weatherStatusValues = values;
      dom.weatherStatus.textContent = translate(key, values);
    };
    updateDateFormats();
    const forecastKms = [...new Set([0, 171, Math.round(route.totalKm)])];
    const chartContext = () => ({ stopsKm: state.plan.stopsKm, totalKm: route.totalKm });

    function renderCoverage() {
      dom.coverage.textContent =
        state.weather
          .coverage()
          .map((c) =>
            translate('coverage', { km: c.km, from: dateTimeFormat.format(c.from), to: dateTimeFormat.format(c.to) }),
          )
          .join('; ') || translate('noValidRows');
    }

    function updateForecast(byKm) {
      state.weather = createWeather(byKm);
      renderCoverage();
    }

    function loadForecast() {
      updateForecast(parseForecast(dom.forecastText.value));
    }

    async function loadLiveForecast() {
      if (typeof fetch !== 'function') {
        setWeatherStatus('liveUnavailable');
        return;
      }
      setWeatherStatus('loadingLive');
      const results = await Promise.allSettled(
        forecastKms.map(async (km) => {
          const { lat, lon } = route.pointAt(km);
          const query = new URLSearchParams({ lat: lat.toFixed(4), lon: lon.toFixed(4) });
          const response = await fetch(`https://api.met.no/weatherapi/locationforecast/2.0/compact?${query}`);
          if (!response.ok) throw new Error(`Forecast request failed (${response.status})`);
          return { km, samples: parseYrForecast(await response.json()) };
        }),
      );
      const byKm = parseForecast(dom.forecastText.value);
      let livePoints = 0;
      for (const result of results) {
        if (result.status === 'fulfilled' && result.value.samples.length) {
          byKm.set(result.value.km, result.value.samples);
          livePoints += 1;
        }
      }
      if (!livePoints) {
        setWeatherStatus('liveUnavailable');
        return;
      }
      updateForecast(byKm);
      setWeatherStatus(
        livePoints === forecastKms.length ? 'liveFetched' : 'livePartial',
        livePoints === forecastKms.length
          ? { date: dateTimeFormat.format(Date.now()) }
          : { loaded: livePoints, total: forecastKms.length },
      );
      render();
    }

    const number = (input, fallback) => Number(input.value) || fallback;

    function readPlan() {
      const [year, month, day] = (dom.startDate.value || '2026-10-10').split('-').map(Number);
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
      const colourOf = (s) =>
        state.mapMode === 'rain' ? rainColour(s.weather?.rainMm3h) : headwindColour(s.headwindKmh);
      const coords = ([x, y]) => `${fixed1(x)},${fixed1(y)}`;
      let svg = tag('polyline', {
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
        `${data.stations.start} (${translate('start')})`,
      );
      svg += tag(
        'text',
        { class: 'map-label map-label--major', x: endX + 10, y: endY + 14 },
        `${finish.name} (${translate('finish')})`,
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
      dom.legend.innerHTML =
        `<span>${swatch('swatch--stop')}${translate('stop')}</span>` +
        LEGENDS[state.mapMode].map(([modifier, key]) => `<span>${swatch(modifier)}${translate(key)}</span>`).join('');
    }

    function formatRideDuration(hours) {
      const minutes = Math.round(hours * 60);
      return `${Math.floor(minutes / 60)}${translate('hoursShort')} ${pad2(minutes % 60)}${translate('minutesShort')}`;
    }

    function renderSummary() {
      const { plan, ride, samples } = state;
      const stats = summariseSamples(samples);
      const finishTime = ride.times.at(-1);
      const speedKmh = route.totalKm / ride.ridingHours;
      const strong = (text) => tag('b', { class: 'strong' }, text);
      let html =
        `${strong(`${route.totalKm.toFixed(0)} km`)} · ${translate('riding')} ${formatRideDuration(ride.ridingHours)} + ${plan.stopsKm.length} ${translate('stops')} × ${plan.stopMinutes} ${translate('minutesShort')} · ` +
        `${translate('finishLabel')} ${strong(dateTimeFormat.format(finishTime))} (${formatRideDuration((finishTime - plan.startTime) / MS_PER_HOUR)} ${translate('elapsed')})<br>` +
        `${translate('averageSpeedShort')} ${strong(`${fixed1(speedKmh)} km/h`)} · ${translate('averagePowerShort')} ${strong(`${Math.round(ride.averagePowerW)} W`)} ` +
        `(${fixed1(ride.averagePowerW / plan.riderKg)} W/kg)`;
      if (stats.measured) {
        const sign = stats.meanHeadwindKmh >= 0 ? '+' : '';
        html += `<br>${translate('averageHeadwind')} ${sign}${fixed1(stats.meanHeadwindKmh)} km/h ${translate('negativeTailwind')}`;
        html += stats.wetShare
          ? `<br>${translate('rainOnAbout')} ${Math.round(stats.wetShare * 100)}${translate('routeHeaviest', { rain: fixed1(stats.heaviest.weather.rainMm3h / 3), km: stats.heaviest.km.toFixed(0) })}`
          : `<br>${translate('dryWholeRoute')}`;
      }
      if (stats.missingShare > 0) {
        html += `<div class="warn">${translate('missingForecast', { share: Math.round(stats.missingShare * 100) })}</div>`;
      }
      dom.summary.innerHTML = html;
      if (state.paceMode === 'speed') dom.power.value = Math.round(ride.averagePowerW);
      else dom.speed.value = fixed1(speedKmh);
    }

    function renderStations() {
      const { plan, ride } = state;
      const dayStart = Math.floor(plan.startTime / MS_PER_DAY) * MS_PER_DAY;
      const label = {
        early: (minutes) => translate('earlyBy', { minutes }),
        late: (minutes) => translate('lateBy', { minutes }),
        ok: () => translate('inWindow'),
      };
      const rows = stations
        .map((station) => {
          const arrival = ride.arrivalAt(station.km);
          const status = stationStatus(arrival, dayStart, station);
          const name = station === stations.at(-1) ? `${station.name} (${translate('finish')})` : station.name;
          return (
            `<tr><td>${name}</td><td>${Math.round(station.km)}</td><td>${formatClockHour(station.opens)} / ${formatClockHour(station.closes)}</td>` +
            `<td>${dayClockFormat.format(arrival)}</td><td class="status status--${status.state}">${label[status.state](status.minutes)}</td></tr>`
          );
        })
        .join('');
      dom.stations.innerHTML =
        `<table><tr><th>${translate('station')}</th><th>km</th><th>${translate('times')}</th><th>${translate('youArrive')}</th><th>${translate('status')}</th></tr>${rows}</table>` +
        `<p class="note">${translate('stationNote')}</p>`;
    }

    function renderReadout(point) {
      const sample = point.weather;
      if (!sample) {
        dom.readout.innerHTML =
          `<div class="big">${translate('noForecastAt', { date: dateTimeFormat.format(point.time) })}</div>` +
          `<p class="warn">${translate('noForecastHelp')}</p>`;
        return;
      }
      const head = point.headwindKmh;
      const tone = head > HEADWIND.neutralKmh ? 'big--head' : head < -HEADWIND.neutralKmh ? 'big--tail' : '';
      const headline =
        Math.abs(head) < HEADWIND.neutralKmh
          ? translate('mostlyCrosswind')
          : `${Math.abs(head).toFixed(0)} km/h ${translate(head > 0 ? 'headwind' : 'tailwind')}`;
      const cell = (name, value) => `<div><span>${name}</span>${value}</div>`;
      const gust =
        sample.gustKts > sample.windKts + 0.05 ? `${(sample.gustKts * KNOTS_TO_KMH).toFixed(0)} km/h` : 'n/a';
      dom.readout.innerHTML =
        `<div class="big ${tone}">${headline}</div>` +
        `<div class="muted">${translate('riding')} ${compassLabel(point.bearing)} · ${translate('windFrom')} ${compassLabel(sample.dir)} · ${skyLabel(sample, translate)}</div>` +
        '<div class="grid">' +
        cell(translate('speed'), `<b>${fixed1(point.speedKmh)} km/h</b>`) +
        cell(translate('power'), `<b>${Math.round(point.powerW)} W</b>`) +
        cell(
          translate('wind'),
          `<b>${point.windKmh.toFixed(0)} km/h</b> <small>(${sample.windKts.toFixed(0)} kts)</small>`,
        ) +
        cell(translate('gusts'), `<b>${gust}</b>`) +
        cell(translate('crosswind'), `<b>${Math.abs(point.crosswindKmh).toFixed(0)} km/h</b>`) +
        cell(translate('temperature'), `<b>${sample.tempC.toFixed(0)} °C</b>`) +
        cell(
          translate('rain'),
          `<b>${rainLabel(sample.rainMm3h, translate)}</b> <small>(${fixed1(sample.rainMm3h / 3)} mm/h)</small>`,
        ) +
        cell(translate('cloud'), `<b>${sample.cloudPct.toFixed(0)}%</b>`) +
        '</div>';
    }

    /** Moves the marker, chart cursors and readout to the slider position (cheap; no re-simulation). */
    function updateCursor() {
      const km = Number(dom.position.value);
      const point = describePoint(route, state.weather, state.ride, km);
      const [x, y] = project(route.pointAt(km).lat, route.pointAt(km).lon);
      dom.positionLabel.textContent = `km ${fixed1(km)} · ${dateTimeFormat.format(point.time)}`;
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
      dom.windfinderLink.href = `https://www.windfinder.com/#9/${lat.toFixed(4)}/${lon.toFixed(4)}`;
      dom.windfinderLink.textContent = translate('windfinderMap', { km: km.toFixed(0) });
    }

    function render() {
      state.plan = readPlan();
      state.ride = simulate(route, state.weather, state.plan);
      const count = Math.ceil(route.totalKm / SAMPLE_STEP_KM);
      state.samples = Array.from({ length: count + 1 }, (_, i) =>
        describePoint(route, state.weather, state.ride, Math.min(route.totalKm, i * SAMPLE_STEP_KM)),
      );
      renderMap();
      const specs = chartSpecs(state.samples, translate);
      for (const [name, svg] of Object.entries(dom.charts)) drawChart(svg, specs[name], chartContext());
      renderSummary();
      renderStations();
      updateCursor();
    }

    // --- events
    function init() {
      applyStaticTranslations();
      setWeatherStatus(state.weatherStatus);
      dom.forecastText.value = data.forecast;
      dom.position.max = route.totalKm;
      loadForecast();

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
        addPreset(`${kmh} km/h`, () => {
          dom.speed.value = kmh;
        });
      }
      addPreset(translate('preset24'), () => {
        const { stopsKm, stopMinutes } = readPlan();
        dom.speed.value = (route.totalKm / Math.max(1, TARGET_HOURS - (stopsKm.length * stopMinutes) / 60)).toFixed(2);
      });

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
        });
      }
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
      dom.languageControl.addEventListener('click', (event) => {
        const button = event.target.closest('[data-language]');
        if (!button) return;
        state.language = button.dataset.language === 'nl' ? 'nl' : 'en';
        try {
          localStorage.setItem('ride-cast-language', state.language);
        } catch {
          state.language = button.dataset.language === 'nl' ? 'nl' : 'en';
        }
        updateDateFormats();
        applyStaticTranslations();
        renderCoverage();
        setWeatherStatus(state.weatherStatus, state.weatherStatusValues);
        render();
      });
      dom.applyForecast.addEventListener('click', () => {
        loadForecast();
        render();
      });
      for (const svg of Object.values(dom.charts)) {
        svg.addEventListener('click', (event) => {
          const rect = svg.getBoundingClientRect();
          const x = ((event.clientX - rect.left) / rect.width) * CHART.width;
          dom.position.value = clamp((x - CHART.padLeft) / (CHART.width - CHART.padLeft), 0, 1) * route.totalKm;
          updateCursor();
        });
      }
      setPace('speed');
      updatePresets();
      render();
      void loadLiveForecast();
    }

    return { init };
  }

  function queryDom() {
    const byId = (id) => document.getElementById(id);
    return {
      map: byId('map'),
      languageControl: byId('language-control'),
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
      weatherStatus: byId('weather-status'),
      readout: byId('readout'),
      stations: byId('stations'),
      forecastText: byId('forecast-text'),
      coverage: byId('coverage'),
      applyForecast: byId('apply-forecast'),
      windfinderLink: byId('windfinder-link'),
      charts: { wind: byId('wind-chart'), rain: byId('rain-chart'), power: byId('power-chart') },
    };
  }

  function start() {
    const text = (id) => document.getElementById(id).textContent;
    createApp(queryDom(), {
      route: JSON.parse(text('route-data')),
      stations: JSON.parse(text('stations-data')),
      forecast: text('forecast-data').trim(),
    }).init();
  }

  // ------------------------------------------------------------------ entry point
  const model = {
    createRoute,
    parseForecast,
    parseYrForecast,
    createWeather,
    simulate,
    describePoint,
    powerAtSpeed,
    speedAtPower,
    stationStatus,
    formatDuration,
    blendSamples,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = model;
  else start();
})();
