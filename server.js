const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// LOCATIONS — ordered roughly north → south along the Dutch coast
// ============================================================
// All Holland-coast spots face W/WNW so offshore = E winds (45°–135°).
// Domburg is on Walcheren (Zeeland) facing NW, so offshore is SE/S there.
const LOCATIONS = {
  'texel-paal-9': {
    key: 'texel-paal-9',
    name: 'Texel (Paal 9)',
    latitude: 53.063,
    longitude: 4.722,
    timezone: 'Europe/Amsterdam',
    offshoreRange: [45, 135]
  },
  'castricum-aan-zee': {
    key: 'castricum-aan-zee',
    name: 'Castricum aan Zee',
    latitude: 52.5547,
    longitude: 4.6328,
    timezone: 'Europe/Amsterdam',
    offshoreRange: [45, 135]
  },
  'wijk-aan-zee': {
    key: 'wijk-aan-zee',
    name: 'Wijk aan Zee',
    latitude: 52.4928,
    longitude: 4.5947,
    timezone: 'Europe/Amsterdam',
    offshoreRange: [45, 135]
  },
  'ijmuiden': {
    key: 'ijmuiden',
    name: 'IJmuiden',
    latitude: 52.460,
    longitude: 4.555,
    timezone: 'Europe/Amsterdam',
    offshoreRange: [45, 135]
  },
  'zandvoort-aan-zee': {
    key: 'zandvoort-aan-zee',
    name: 'Zandvoort aan Zee',
    latitude: 52.371,
    longitude: 4.529,
    timezone: 'Europe/Amsterdam',
    offshoreRange: [45, 135]
  },
  'scheveningen': {
    key: 'scheveningen',
    name: 'Scheveningen',
    latitude: 52.106,
    longitude: 4.275,
    timezone: 'Europe/Amsterdam',
    offshoreRange: [45, 135]
  },
  'domburg': {
    key: 'domburg',
    name: 'Domburg',
    latitude: 51.566,
    longitude: 3.501,
    timezone: 'Europe/Amsterdam',
    offshoreRange: [90, 180]
  },
  'biarritz': {
    key: 'biarritz',
    name: 'Biarritz',
    latitude: 43.483,
    longitude: -1.559,
    timezone: 'Europe/Paris',
    // Faces NW (Bay of Biscay) → offshore is roughly E/SE
    offshoreRange: [60, 150]
  }
};
const DEFAULT_LOCATION = 'wijk-aan-zee';
const FORECAST_DAYS = 3;

// ============================================================
// SURF QUALITY THRESHOLDS — from Tim's "shaka conditions.xlsx"
// Applied to SWELL height/period (rideable wave), not combined.
// Wind direction is informational only — light wind matters more
// than direction, so onshore is fine if the wind is light enough.
// ============================================================
//                wave height (m)   swell period (s)  wind (km/h)
//  awesome       ≥ 0.8             ≥ 9               ≤ 10
//  good          ≥ 0.8             ≥ 8               ≤ 15
//  medium        ≥ 0.7             ≥ 6               ≤ 25
//  bad           anything else
const QUALITY = {
  awesome: { waveHeight: [0.8, 99], wavePeriod: [9, 99], windSpeedMax: 10, requireOffshore: false },
  good:    { waveHeight: [0.8, 99], wavePeriod: [8, 99], windSpeedMax: 15, requireOffshore: false },
  medium:  { waveHeight: [0.7, 99], wavePeriod: [6, 99], windSpeedMax: 25, requireOffshore: false }
  // anything else => 'bad'
};
const TIERS = ['awesome', 'good', 'medium'];

// Gust factor above this = squally / unpredictable wind → drop one tier
const GUST_FACTOR_THRESHOLD = 1.4;

// ============================================================
// BOARD CHOICE — from Tim's spreadsheet
// ============================================================
//  longboard    swell period ≥ 7   wave height < 1.0
//  mid length   swell period > 6   wave height < 1.2
//  shortboard   swell period > 6   wave height ≥ 1.2
function boardFor(swellHeight, swellPeriod) {
  if (swellHeight == null || swellPeriod == null) return null;
  if (swellPeriod <= 6) return null;                              // too short-period, nothing rideable
  if (swellHeight >= 1.2) return 'shortboard';
  if (swellHeight < 1.0 && swellPeriod >= 7) return 'longboard';
  if (swellHeight < 1.2) return 'mid length';
  return null;
}

// ============================================================
// WETSUIT GUIDE — based on water temperature (°C)
// ============================================================
function wetsuitFor(waterTemp) {
  if (waterTemp == null) {
    return { thickness: '—', cap: false, gloves: false, boots: false, note: 'No water temp data' };
  }
  if (waterTemp >= 22) return { thickness: 'Boardshorts or 2 mm shorty', cap: false, gloves: false, boots: false };
  if (waterTemp >= 19) return { thickness: '2 mm fullsuit',               cap: false, gloves: false, boots: false };
  if (waterTemp >= 17) return { thickness: '3/2 mm fullsuit',              cap: false, gloves: false, boots: false };
  if (waterTemp >= 14) return { thickness: '4/3 mm fullsuit',              cap: false, gloves: false, boots: 'optional' };
  if (waterTemp >= 11) return { thickness: '4/3 mm fullsuit',              cap: 'optional', gloves: true, boots: true };
  if (waterTemp >=  9) return { thickness: '5/4 mm fullsuit',              cap: true, gloves: true, boots: true };
  if (waterTemp >=  7) return { thickness: '5/4 or 6/5 mm fullsuit',       cap: true, gloves: true, boots: true };
  return                     { thickness: '6/5 mm hooded fullsuit',         cap: 'hood', gloves: '5 mm', boots: '7 mm' };
}

function isOffshore(windDirection, range) {
  return windDirection >= range[0] && windDirection <= range[1];
}

function inRange(value, [min, max]) {
  return value >= min && value <= max;
}

// Surf classification using SWELL height/period (falls back to combined wave if swell missing).
// Applies a gust penalty: very gusty wind (gust factor > threshold) drops the verdict by one tier.
function classify(day, offshoreRange) {
  const h = (day.swellHeight != null && day.swellHeight > 0) ? day.swellHeight : day.waveHeight;
  const p = (day.swellPeriod != null && day.swellPeriod > 0) ? day.swellPeriod : day.wavePeriod;
  if (h == null || p == null) return 'unknown';

  const { windSpeed, windGusts, windDirection } = day;
  const offshore = isOffshore(windDirection, offshoreRange);

  let tier = 'bad';
  for (const candidate of TIERS) {
    const t = QUALITY[candidate];
    if (!inRange(h, t.waveHeight)) continue;
    if (!inRange(p, t.wavePeriod)) continue;
    if (windSpeed > t.windSpeedMax) continue;
    if (t.requireOffshore && !offshore) continue;
    tier = candidate;
    break;
  }

  // Gust penalty: drop one tier if wind is squally
  const gustFactor = (windGusts != null && windSpeed > 0) ? windGusts / windSpeed : 1;
  if (gustFactor > GUST_FACTOR_THRESHOLD && tier !== 'bad') {
    const order = ['bad', 'medium', 'good', 'awesome'];
    tier = order[Math.max(0, order.indexOf(tier) - 1)];
  }

  return tier;
}

// Day buckets — local-clock hour ranges [startInclusive, endExclusive).
// Tuned for NL surf habits: dawn patrol at 07–11, midday at 11–15, evening glass-off at 15–20.
const SLOTS = [
  { key: 'morning', label: 'Morning', start: 7,  end: 11 },
  { key: 'noon',    label: 'Noon',    start: 11, end: 15 },
  { key: 'evening', label: 'Evening', start: 15, end: 20 }
];

function avg(vals) {
  const clean = vals.filter(v => v != null && !Number.isNaN(v));
  if (clean.length === 0) return null;
  return clean.reduce((s, v) => s + v, 0) / clean.length;
}

// Vector mean for compass directions (degrees). Plain averaging breaks across the 0/360 wrap.
function meanDirection(degs) {
  const clean = degs.filter(d => d != null && !Number.isNaN(d));
  if (clean.length === 0) return null;
  let x = 0, y = 0;
  for (const d of clean) {
    const r = (d * Math.PI) / 180;
    x += Math.cos(r);
    y += Math.sin(r);
  }
  const mean = (Math.atan2(y / clean.length, x / clean.length) * 180) / Math.PI;
  return (mean + 360) % 360;
}

function maxIn(vals) {
  const clean = vals.filter(v => v != null && !Number.isNaN(v));
  if (clean.length === 0) return null;
  return Math.max(...clean);
}

// Pull all hourly indices that fall inside [start, end) on the given date string.
function hourIndicesInSlot(times, dateStr, start, end) {
  const idx = [];
  for (let i = 0; i < times.length; i++) {
    if (!times[i].startsWith(dateStr)) continue;
    const hr = parseInt(times[i].slice(11, 13), 10);
    if (hr >= start && hr < end) idx.push(i);
  }
  return idx;
}

function pick(arr, idx) {
  return idx.map(i => arr[i]);
}

// Open-Meteo hourly stamps look like "2026-04-29T14:00". Build the matching string
// for the current local time in the location's timezone, so we can index directly.
function currentHourISO(timezone) {
  const fmt = new Intl.DateTimeFormat('sv-SE', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hour12: false
  });
  const parts = fmt.formatToParts(new Date());
  const get = t => parts.find(p => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:00`;
}

function compassDirection(deg) {
  if (deg == null) return '';
  const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
                'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return dirs[Math.round(deg / 22.5) % 16];
}

function dailyMeanFromHourly(hourlyTimes, hourlyValues, dateStr) {
  const vals = [];
  for (let i = 0; i < hourlyTimes.length; i++) {
    if (hourlyTimes[i].startsWith(dateStr) && hourlyValues[i] != null) {
      vals.push(hourlyValues[i]);
    }
  }
  if (vals.length === 0) return null;
  return vals.reduce((s, v) => s + v, 0) / vals.length;
}

// Find contiguous daylight windows where sea level sits in the mid-50% of the daily tide range.
// At most beach breaks, mid-tide is the sweet spot — extreme low/high tide either dries out or
// gets too deep. Returns an array of { start: 'HH:MM', end: 'HH:MM' } windows.
function findTideWindows(hourlyTimes, hourlyLevels, dateStr) {
  const hours = [];
  for (let i = 0; i < hourlyTimes.length; i++) {
    if (hourlyTimes[i].startsWith(dateStr) && hourlyLevels[i] != null) {
      hours.push({ time: hourlyTimes[i].slice(11, 16), level: hourlyLevels[i] });
    }
  }
  if (hours.length < 6) return [];

  const levels = hours.map(h => h.level);
  const min = Math.min(...levels);
  const max = Math.max(...levels);
  const range = max - min;
  if (range < 0.1) return []; // basically no tide swing

  const lo = min + range * 0.25;
  const hi = min + range * 0.75;

  const isDaylight = t => {
    const hr = parseInt(t.slice(0, 2), 10);
    return hr >= 7 && hr <= 21;
  };
  const inMid = h => isDaylight(h.time) && h.level >= lo && h.level <= hi;

  const windows = [];
  let runStart = null;
  for (let i = 0; i < hours.length; i++) {
    const ok = inMid(hours[i]);
    if (ok && runStart === null) runStart = i;
    if (!ok && runStart !== null) {
      const runEnd = i - 1;
      if (runEnd - runStart >= 1) {
        windows.push({ start: hours[runStart].time, end: hours[runEnd].time });
      }
      runStart = null;
    }
  }
  if (runStart !== null) {
    const runEnd = hours.length - 1;
    if (runEnd - runStart >= 1) {
      windows.push({ start: hours[runStart].time, end: hours[runEnd].time });
    }
  }
  return windows;
}

async function fetchForecast(location) {
  const { latitude, longitude, timezone, offshoreRange } = location;
  const tz = encodeURIComponent(timezone);

  const marineUrl =
    `https://marine-api.open-meteo.com/v1/marine?latitude=${latitude}&longitude=${longitude}` +
    `&daily=wave_height_max,wave_period_max,wave_direction_dominant,` +
           `swell_wave_height_max,swell_wave_period_max,swell_wave_direction_dominant,` +
           `wind_wave_height_max` +
    `&hourly=sea_surface_temperature,sea_level_height_msl,` +
            `wave_height,wave_period,wave_direction,` +
            `swell_wave_height,swell_wave_period,swell_wave_direction,` +
            `wind_wave_height` +
    `&forecast_days=${FORECAST_DAYS}&timezone=${tz}`;

  const weatherUrl =
    `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}` +
    `&daily=wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant,temperature_2m_max` +
    `&hourly=wind_speed_10m,wind_gusts_10m,wind_direction_10m,temperature_2m` +
    `&forecast_days=${FORECAST_DAYS}&timezone=${tz}`;

  const [marineRes, weatherRes] = await Promise.all([fetch(marineUrl), fetch(weatherUrl)]);
  if (!marineRes.ok) throw new Error(`Marine API ${marineRes.status}`);
  if (!weatherRes.ok) throw new Error(`Weather API ${weatherRes.status}`);

  const marine = await marineRes.json();
  const weather = await weatherRes.json();

  // Snapshot the current hour for the "NOW" card (live conditions vs daily aggregate).
  const nowKey = currentHourISO(timezone);
  const mNow = marine.hourly.time.indexOf(nowKey);
  const wNow = weather.hourly.time.indexOf(nowKey);
  let now = null;
  if (mNow !== -1 && wNow !== -1) {
    const swellHeight = marine.hourly.swell_wave_height[mNow];
    const swellPeriod = marine.hourly.swell_wave_period[mNow];
    const swellDirection = marine.hourly.swell_wave_direction[mNow];
    const waveHeight = marine.hourly.wave_height[mNow];
    const wavePeriod = marine.hourly.wave_period[mNow];
    const windWaveHeight = marine.hourly.wind_wave_height[mNow];
    const windSpeed = weather.hourly.wind_speed_10m[wNow];
    const windGusts = weather.hourly.wind_gusts_10m[wNow];
    const windDirection = weather.hourly.wind_direction_10m[wNow];
    const airTemp = weather.hourly.temperature_2m[wNow];
    const waterTemp = marine.hourly.sea_surface_temperature[mNow];

    now = {
      time: nowKey,
      swellHeight, swellPeriod, swellDirection,
      waveHeight, wavePeriod, windWaveHeight,
      windSpeed, windGusts, windDirection,
      airTemp, waterTemp
    };
    now.gustFactor = (windGusts != null && windSpeed > 0) ? windGusts / windSpeed : null;
    now.gusty = now.gustFactor != null && now.gustFactor > GUST_FACTOR_THRESHOLD;
    now.quality = classify(now, offshoreRange);
    now.windCompass = compassDirection(windDirection);
    now.swellCompass = compassDirection(swellDirection);
    now.windOffshore = windDirection != null && isOffshore(windDirection, offshoreRange);
    now.wetsuit = wetsuitFor(waterTemp);
    now.board = boardFor(swellHeight, swellPeriod);
  }

  const forecast = marine.daily.time.map((date, i) => {
    const waterTemp = dailyMeanFromHourly(marine.hourly.time, marine.hourly.sea_surface_temperature, date);
    const tideWindows = findTideWindows(marine.hourly.time, marine.hourly.sea_level_height_msl, date);

    const day = {
      date,
      // Combined wave (sum of swell + wind chop)
      waveHeight: marine.daily.wave_height_max[i],
      wavePeriod: marine.daily.wave_period_max[i],
      waveDirection: marine.daily.wave_direction_dominant[i],
      // Swell only — the rideable part
      swellHeight: marine.daily.swell_wave_height_max[i],
      swellPeriod: marine.daily.swell_wave_period_max[i],
      swellDirection: marine.daily.swell_wave_direction_dominant[i],
      // Wind chop (locally generated, not rideable)
      windWaveHeight: marine.daily.wind_wave_height_max[i],
      // Wind
      windSpeed: weather.daily.wind_speed_10m_max[i],
      windGusts: weather.daily.wind_gusts_10m_max[i],
      windDirection: weather.daily.wind_direction_10m_dominant[i],
      // Temps
      airTemp: weather.daily.temperature_2m_max[i],
      waterTemp,
      // Tide
      tideWindows
    };

    day.gustFactor = (day.windGusts != null && day.windSpeed > 0) ? day.windGusts / day.windSpeed : null;
    day.gusty = day.gustFactor != null && day.gustFactor > GUST_FACTOR_THRESHOLD;

    // Per-slot conditions (morning/noon/evening) — same classifier on hourly averages.
    day.slots = SLOTS.map(slot => {
      const mIdx = hourIndicesInSlot(marine.hourly.time, date, slot.start, slot.end);
      const wIdx = hourIndicesInSlot(weather.hourly.time, date, slot.start, slot.end);

      const swellHeight = avg(pick(marine.hourly.swell_wave_height, mIdx));
      const swellPeriod = avg(pick(marine.hourly.swell_wave_period, mIdx));
      const swellDirection = meanDirection(pick(marine.hourly.swell_wave_direction, mIdx));
      const waveHeight = avg(pick(marine.hourly.wave_height, mIdx));
      const wavePeriod = avg(pick(marine.hourly.wave_period, mIdx));
      const windWaveHeight = avg(pick(marine.hourly.wind_wave_height, mIdx));

      const windSpeed = avg(pick(weather.hourly.wind_speed_10m, wIdx));
      const windGusts = maxIn(pick(weather.hourly.wind_gusts_10m, wIdx));
      const windDirection = meanDirection(pick(weather.hourly.wind_direction_10m, wIdx));

      const slotData = {
        key: slot.key,
        label: slot.label,
        start: slot.start,
        end: slot.end,
        swellHeight, swellPeriod, swellDirection,
        waveHeight, wavePeriod, windWaveHeight,
        windSpeed, windGusts, windDirection
      };
      slotData.gustFactor = (windGusts != null && windSpeed > 0) ? windGusts / windSpeed : null;
      slotData.gusty = slotData.gustFactor != null && slotData.gustFactor > GUST_FACTOR_THRESHOLD;
      slotData.quality = classify(slotData, offshoreRange);
      slotData.windCompass = compassDirection(windDirection);
      slotData.swellCompass = compassDirection(swellDirection);
      slotData.windOffshore = windDirection != null && isOffshore(windDirection, offshoreRange);
      return slotData;
    });

    // Day headline = best slot tier (so a 1-hour window of glory still gets credit).
    const tierOrder = ['unknown', 'bad', 'medium', 'good', 'awesome'];
    const slotQualities = day.slots.map(s => s.quality);
    const bestSlot = slotQualities.reduce((best, q) =>
      tierOrder.indexOf(q) > tierOrder.indexOf(best) ? q : best, 'unknown');
    const dailyQuality = classify(day, offshoreRange);
    // Use whichever is higher between the daily-aggregate verdict and the best slot.
    day.quality = tierOrder.indexOf(bestSlot) >= tierOrder.indexOf(dailyQuality) ? bestSlot : dailyQuality;
    day.windCompass = compassDirection(day.windDirection);
    day.swellCompass = compassDirection(day.swellDirection);
    day.windOffshore = isOffshore(day.windDirection, offshoreRange);
    day.wetsuit = wetsuitFor(waterTemp);
    day.board = boardFor(day.swellHeight, day.swellPeriod);
    return day;
  });

  return { forecast, now };
}

app.get('/api/locations', (req, res) => {
  const list = Object.values(LOCATIONS).map(l => ({ key: l.key, name: l.name }));
  res.json({ locations: list, default: DEFAULT_LOCATION });
});

app.get('/api/forecast', async (req, res) => {
  const key = req.query.location || DEFAULT_LOCATION;
  const location = LOCATIONS[key];
  if (!location) return res.status(400).json({ error: `Unknown location: ${key}` });
  try {
    const { forecast, now } = await fetchForecast(location);
    res.json({
      location: { key: location.key, name: location.name, latitude: location.latitude, longitude: location.longitude },
      forecast,
      now
    });
  } catch (err) {
    console.error('Forecast fetch failed:', err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Surf forecast running at http://localhost:${PORT}`);
});
