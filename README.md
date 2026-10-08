# Coast to Coast: weather and power on the route

A static web app for the Coast to Coast Challenge (Zoutkamp to Zoutelande, 504 km, 10-11 Oct 2026).
Drag a slider along the route and see, for a chosen average speed or power, where you are, what time it is,
and what wind, rain and temperature you meet there.

## Features

- Route map drawn from the GPX file (no map tiles needed)
- Slider and clickable charts for headwind, rain, temperature and power along the route, each with a y-axis scale
- Pace by speed (gives average power) or by power (gives speed and finish time)
- The organiser's refreshment stations as 30-minute stops, with a table checking arrival against each station's times
- Rider and bike settings: weight, riding position (CdA), road surface, share of the forecast wind that reaches the rider
- Map coloured by headwind, rain or temperature
- Dutch and English, switched with the flags at the top right (remembered in the browser; a Dutch browser starts in Dutch)
- Weather from the Dutch KNMI model (live, via Open-Meteo) by default, with the GFS model behind Windfinder and the saved Yr.no forecast as options

## Project layout

    src/index.html       markup only; the build fills the three data blocks at the bottom
    src/styles.css       all styling, with design tokens as CSS variables and a dark theme
    src/app.js           the application (see "Code structure")
    data/route.gpx       the route
    data/stations.json   start name and refreshment stations (km, opening and closing hour)
    data/boundaries.json country and province borders for the map
    data/translations.json all text, per language
    data/forecast.csv    forecast rows
    scripts/build.mjs    GPX + data + src -> dist/
    tests/               unit tests for the model, integration tests that run the real page in jsdom
    dist/                build output (committed so GitHub Pages can serve it)

## Commands

Needs Node.js 18 or newer.

    npm install        # dev tools only: eslint, prettier, jsdom
    npm run build      # writes dist/index.html, styles.css, app.js and standalone.html
    npm test           # builds, then runs all tests (node:test)
    npm run lint       # eslint
    npm run format     # prettier
    npm run check      # lint + format check + tests

`dist/index.html` opens straight from disk. `dist/standalone.html` is the same page with CSS and JS inlined,
handy for sharing as one file. To use GitHub Pages, deploy from the `/dist` folder.

## Code structure (`src/app.js`)

The file is one IIFE in strict mode with five sections:

1. **Constants.** Every number with a meaning is named (physics, thresholds, chart geometry, colours).
2. **Model.** Pure functions with no DOM access: `createRoute`, `parseForecast`, `createWeather`, `powerAtSpeed`,
   `speedAtPower`, `simulate`, `describePoint`, `stationStatus`. Types are documented with JSDoc.
   When the file is loaded by Node (`require`) these are exported, which is how the unit tests reach them.
3. **Formatting and colour helpers.**
4. **View.** Small renderers that turn model output into SVG and HTML strings. Chart geometry lives in one
   `chartSpecs` function and one generic `drawChart`.
5. **Controller.** `createApp` reads the inputs into a `Plan`, runs the simulation, calls the renderers and wires events.

Presentation lives in CSS classes (`.route-segment`, `.status--late`, `.is-active`, ...); the JS only sets colours
that depend on data.

## Weather sources

Chosen with the "Weather source" selector:

- **KNMI HARMONIE via Open-Meteo (default).** The page asks `api.open-meteo.com/v1/forecast` (`models=knmi_seamless`)
  for 7 points spread evenly along the route, in one request, from the start date to two days later, with hourly 10 m
  wind (knots), gusts, temperature, precipitation and cloud cover in Europe/Amsterdam time. KNMI covers about 2.5 days
  ahead; Open-Meteo blends in ECMWF after that, up to 15 days. Rain is hourly mm times 3 (the app uses mm per 3 h).
  Changing the start date fetches again. If the request fails (offline, date out of range), the app falls back to the saved
  Yr.no forecast and says so in the status line.
- **GFS via Open-Meteo (the model behind Windfinder).** Same request with `models=gfs_global`: NOAA's GFS at 0.11°
  (about 13 km), hourly, up to 16 days ahead. Windfinder's standard forecast is based on GFS at about 13 km, so these
  numbers should be close to what Windfinder shows, but they are not Windfinder's own data.
- **Yr.no / MET Norway.** A forecast saved in `data/forecast.csv`, available offline.
- **Pasted data.** Whatever is in the "Forecast data" box when you press Apply.

The rows of the selected source always appear in the "Forecast data" box, so you can inspect or edit them.
Open-Meteo is free for non-commercial use with attribution (CC BY 4.0), which the page footer provides.

## Updating the data

`data/forecast.csv` has one row per forecast step:

    km,date,hour,dir,kts,gust,temp,rain,cloud

- `km`: position on the route of the forecast point (wind is blended between points)
- `dir`: direction the wind comes **from**, in degrees
- `kts`, `gust`: wind and gust in knots (set gust equal to wind if unknown; the app then shows "n/a")
- `temp` in deg C, `rain` in mm per 3 hours, `cloud` in %

The saved data is a Yr.no forecast (fetched 6 Oct 2026, 6-hour blocks placed at their midpoint hour) for three points:
Groote Tjariet (km 0), Lelystad (km 171) and Zoutelande (km 504). Yr gives wind direction as compass words
(about 45 deg precision) and, for km 0, a rain range of which the middle value is used. More points along the route
improve accuracy. Rebuild after editing `data/forecast.csv`.

`data/stations.json` lists the refreshment stations. `opens` and `closes` are hours since midnight of the start day
(so 27 means 03:00 the next day); `km: null` means the finish. Stop positions come from the stage lengths
(109, 102, 110, 81, 99 km) and are the default of the "Stops at km" field in `src/index.html`.

## Power model

Steady-state physics per kilometre of route:

    P = (0.5 * rho * CdA * (v + headwind)^2 + Crr * m * g + m * g * grade) * v / efficiency

with rho = 1.24 kg/m3, drivetrain efficiency 97.5%, grade from the smoothed GPX elevation, and headwind from the forecast
wind at the time you reach that point, scaled by "Wind at rider" (default 70%, because forecasts are for 10 m height).
Power is floored at 0 when coasting. Crosswind yaw, drafting and fatigue are not modelled. In power mode the speed on
each kilometre is solved from the power, so you slow down into headwind.

## About Windfinder

Windfinder has no free data API (its forecast API is a paid B2B product), its forecast pages build their tables in the
browser, and a web page cannot read another site's pages. That is why the app uses GFS via Open-Meteo instead.
The forecast box lists Windfinder map links for every forecast point, and another link follows the slider, so you can
compare any point with Windfinder directly. To use exact Windfinder numbers, type them into the "Forecast data" box
(wind direction there is the direction the wind comes **from**) and press Apply.

## Map borders

`data/boundaries.json` holds the Netherlands, Belgium and Germany (country outlines) and the 12 Dutch provinces,
clipped to the map area and simplified to about 150 m. Source: Natural Earth 1:10m admin-1 (public domain).
The file is committed, so building needs nothing extra. To regenerate it, download the Natural Earth GeoJSON named in
the header of `scripts/make_boundaries.py` and run that script (Python with `shapely`); it also sets where each
province name is placed.

## Languages

All text lives in `data/translations.json`, one flat dictionary per language (`en`, `nl`). Static text in
`src/index.html` is marked with `data-i18n` (plain text), `data-i18n-html` (text with links) or `data-i18n-aria`
(aria-label), and the English text is written in the HTML as well, so the page reads sensibly before the script runs.
Text built by the code uses `t('key', { name: value })`; `{name}` placeholders are filled in.
Dates follow the language (`nl-NL`, `en-GB`), and Dutch uses km/u, kn and u/min.

To add a language: add a dictionary to `data/translations.json` with the same keys and placeholders, add its locale to
`LOCALES` in `src/app.js`, and add a flag button with `data-lang="xx"` to the `.lang-switch` in `src/index.html`.
The tests fail if a key is missing, unused, or has different placeholders in some language, or if the English text
in the HTML drifts from the dictionary.
