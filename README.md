# RideCast

RideCast is a static weather and power planner for the Coast to Coast Challenge (Zoutkamp to Zoutelande, 504 km, 10-11 Oct 2026).
Drag a slider along the route and see, for a chosen average speed or power, where you are, what time it is,
and what wind, rain and temperature you meet there.

## Features

- Route map drawn from the GPX file (no map tiles needed)
- Slider and clickable charts for headwind, rain and power along the route, each with a y-axis scale
- Pace by speed (gives average power) or by power (gives speed and finish time)
- The organiser's refreshment stations as 30-minute stops, with a table checking arrival against each station's times
- Rider and bike settings: weight, riding position (CdA), road surface, share of the forecast wind that reaches the rider
- Map coloured by headwind or by rain

## Project layout

    src/index.html       markup only; the build fills the three data blocks at the bottom
    src/styles.css       all styling, with design tokens as CSS variables and a dark theme
    src/app.js           the application (see "Code structure")
    data/route.gpx       the route
    data/stations.json   start name and refreshment stations (km, opening and closing hour)
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

## Updating the data

`data/forecast.csv` has one row per forecast step:

    km,date,hour,dir,kts,gust,temp,rain,cloud

- `km`: position on the route of the forecast point (wind is blended between points)
- `dir`: direction the wind comes **from**, in degrees
- `kts`, `gust`: wind and gust in knots (set gust equal to wind if unknown; the app then shows "n/a")
- `temp` in deg C, `rain` in mm per 3 hours, `cloud` in %

The app requests the current MET Norway Locationforecast for three route points (km 0, 171 and 504) when it opens.
Changing the start date uses matching timestamps from that forecast; MET Norway typically publishes about nine days
ahead. Wind and precipitation values are converted to the app's units and interpolated between points. The bundled
`data/forecast.csv` remains as an offline fallback and can be replaced by pasting rows into the "Forecast data" box.
The browser contacts `api.met.no` directly, which receives the user's IP address and the requested coordinates; use a
caching proxy for higher-traffic deployments. MET Norway weather data is provided under CC BY 4.0.

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
