const VERDICT_LABEL = {
  bad: 'Bad',
  medium: 'Marginal',
  good: 'Good',
  awesome: 'Tubular!',
  unknown: 'No data'
};

const VERDICT_BLURB = {
  bad: 'Stay home. Conditions are flat or blown out.',
  medium: 'Surfable, but not great. Worth a paddle if you’re desperate.',
  good: 'Solid waves. Get out there.',
  awesome: 'Epic conditions. Drop everything and go surf.',
  unknown: 'Forecast not yet available for this day.'
};

// Quality tiers where a board recommendation makes sense
const SURFABLE = new Set(['medium', 'good', 'awesome']);

const SHAKA_SRC = {
  bad:     'shaka/shaka-red.png',
  medium:  'shaka/shaka-orange.png',
  good:    'shaka/shaka-green.png',
  awesome: 'shaka/shaka-green.png',
  unknown: 'shaka/shaka-green.png'
};

const STORAGE_KEY = 'surf-forecast-location';

function fmt(n, digits = 1) {
  return (n == null) ? '—' : n.toFixed(digits);
}

function shakaHTML(quality) {
  const src = SHAKA_SRC[quality] || SHAKA_SRC.unknown;
  const label = VERDICT_LABEL[quality];
  return `
    <div class="shaka ${quality}" title="${label}">
      <img src="${src}" alt="${label} surf conditions" />
    </div>
  `;
}

function fmtDate(iso, opts) {
  return new Date(iso).toLocaleDateString('en-GB', opts || { weekday: 'short', day: 'numeric', month: 'short' });
}

function dayName(iso, idx) {
  if (idx === 0) return 'Today';
  if (idx === 1) return 'Tomorrow';
  return fmtDate(iso, { weekday: 'long' });
}

// Best swell number to show: prefer swell, fall back to combined wave
function primaryWave(day) {
  const h = (day.swellHeight != null && day.swellHeight > 0) ? day.swellHeight : day.waveHeight;
  const p = (day.swellPeriod != null && day.swellPeriod > 0) ? day.swellPeriod : day.wavePeriod;
  return { h, p };
}

// Per-metric quality classification — used to colour individual values in the metrics cells.
// Keep these in sync with the QUALITY thresholds in server.js.
function qHeight(h) {
  if (h == null) return 'unknown';
  if (h >= 0.8) return 'good';
  if (h >= 0.7) return 'medium';
  return 'bad';
}
function qPeriod(p) {
  if (p == null) return 'unknown';
  if (p >= 9) return 'awesome';
  if (p >= 8) return 'good';
  if (p >= 6) return 'medium';
  return 'bad';
}
function qWind(w) {
  if (w == null) return 'unknown';
  if (w <= 10) return 'awesome';
  if (w <= 15) return 'good';
  if (w <= 25) return 'medium';
  return 'bad';
}

// Water temperature feels-like label.
// Tuned for NL coast (5–18 °C typical) but covers tropical too.
function waterTempLabel(t) {
  if (t == null) return '';
  if (t <  9) return 'Ice cold';
  if (t < 13) return 'Cold';
  if (t < 17) return 'Luke warm';
  if (t < 21) return 'Warm';
  if (t < 25) return 'Hot';
  return 'Lava';
}

// Arrow that points in the direction the swell or wind is HEADING.
// Open-Meteo gives "from" direction (0=N, 90=E, 180=S, 270=W). Rotating by from+180
// flips the arrow to show where it's going. The SVG glyph naturally points north.
function directionArrow(deg) {
  if (deg == null) return '';
  const rotate = (deg + 180) % 360;
  return `<svg class="dir-arrow" viewBox="0 0 24 24" style="transform: rotate(${rotate}deg)" aria-hidden="true">
    <path d="M12 1 L21 13 L15 13 L15 23 L9 23 L9 13 L3 13 Z" fill="currentColor" stroke="var(--ink)" stroke-width="1.5" stroke-linejoin="round"/>
  </svg>`;
}

// ---------- Slot strip (Morning / Noon / Evening) ----------
function slotTime(slot) {
  const pad = n => String(n).padStart(2, '0');
  return `${pad(slot.start)}–${pad(slot.end)}`;
}

function slotMini(slot) {
  if (!slot) return '';
  const h = (slot.swellHeight != null && slot.swellHeight > 0) ? slot.swellHeight : slot.waveHeight;
  const p = (slot.swellPeriod != null && slot.swellPeriod > 0) ? slot.swellPeriod : slot.wavePeriod;
  const wave = (h != null && p != null)
    ? `<span class="q-${qHeight(h)}">${fmt(h, 1)}m</span>/<span class="q-${qPeriod(p)}">${fmt(p, 0)}s</span>`
    : '—';
  const wind = slot.windSpeed != null
    ? `<span class="q-${qWind(slot.windSpeed)}">${fmt(slot.windSpeed, 0)}km/h</span>`
    : '—';
  return `${wave} · ${wind}`;
}

function slotsStrip(slots, opts = {}) {
  if (!slots || slots.length === 0) return '';
  const compact = !!opts.compact;
  const stacked = !!opts.stacked;
  const cells = slots.map(s => `
    <div class="slot-cell ${s.quality}">
      <img class="slot-shaka" src="${SHAKA_SRC[s.quality] || SHAKA_SRC.unknown}" alt="${VERDICT_LABEL[s.quality]}" />
      <div class="slot-body">
        <div class="slot-head">
          <span class="slot-label">${s.label}</span>
          <span class="slot-time">${slotTime(s)}</span>
        </div>
        <div class="slot-verdict">${VERDICT_LABEL[s.quality]}</div>
        ${compact ? '' : `<div class="slot-mini">${slotMini(s)}</div>`}
      </div>
    </div>
  `).join('');
  const cls = ['slots-strip', compact ? 'compact' : '', stacked ? 'stacked' : ''].filter(Boolean).join(' ');
  return `<div class="${cls}">${cells}</div>`;
}

function tideWindowText(windows) {
  if (!windows || windows.length === 0) return null;
  // Show up to 2 windows, comma-separated
  return windows.slice(0, 2).map(w => `${w.start}–${w.end}`).join(', ');
}

// ---------- Wetsuit rendering ----------
function kitItem(label, value) {
  // Hide items that aren't needed (false/null) instead of striking them through.
  if (value === false || value == null) return '';
  let cls = 'on';
  let suffix = '';
  if (value === 'optional') { cls = 'maybe'; suffix = ' (optional)'; }
  else if (value !== true) { suffix = ` (${value})`; }
  return `<span class="kit-item ${cls}">${label}${suffix}</span>`;
}

function wetsuitBlock(w) {
  if (!w) return '';
  const items = [
    kitItem('Suit', w.thickness),
    kitItem('Cap', w.cap),
    kitItem('Gloves', w.gloves),
    kitItem('Boots', w.boots)
  ].filter(Boolean).join('');
  if (!items) return '';
  return `
    <div class="wetsuit">
      <div class="wetsuit-title">Wetsuit kit</div>
      <div class="wetsuit-kit">${items}</div>
    </div>
  `;
}

function shortKitSummary(w) {
  if (!w) return '';
  const bits = [];
  if (w.cap)    bits.push('cap');
  if (w.gloves) bits.push('gloves');
  if (w.boots)  bits.push('boots');
  const extras = bits.length ? ` + ${bits.join('/')}` : '';
  return `${w.thickness}${extras}`;
}

// ---------- Renderers ----------
function renderToday(day, now) {
  const el = document.getElementById('today');
  // Use live current-hour data for the headline metrics if available; fall back to day aggregate.
  const src = now || day;
  const { h, p } = primaryWave(src);
  const offshoreNote = src.windDirection == null ? '' : (src.windOffshore ? 'offshore' : 'onshore/cross');

  const swellArrow = directionArrow(src.swellDirection);
  const windArrow  = directionArrow(src.windDirection);

  const swellLine = `<span class="q-${qHeight(h)}">${fmt(h, 1)} m</span> @ <span class="q-${qPeriod(p)}">${fmt(p, 1)} s</span>${src.swellCompass ? ' ' + src.swellCompass : ''} ${swellArrow}`;
  const chopLine  = src.windWaveHeight != null ? `+ chop ${fmt(src.windWaveHeight, 1)} m` : '';

  const gustsInline = src.windGusts != null ? ` · gusts ${fmt(src.windGusts, 0)}${src.gusty ? ' (squally)' : ''}` : '';
  const offshoreText = offshoreNote ? ` (${offshoreNote})` : '';
  const windPrimary = `<span class="q-${qWind(src.windSpeed)}">${fmt(src.windSpeed, 0)} km/h</span> ${src.windCompass || ''} ${windArrow}`;
  const windMeta    = `<span class="wind-meta">${gustsInline}${offshoreText}</span>`;

  // Tide window stays day-level (it's a daily tide cycle).
  const tideText = tideWindowText(day.tideWindows);
  const tideBanner = tideText ? `<div class="info-pill tide-pill"><span class="banner-label">Best tide</span><span>${tideText}</span></div>` : '';
  const showBoard = src.board && SURFABLE.has(src.quality);
  const boardPill = showBoard ? `<div class="info-pill board-pill"><span class="banner-label">Board</span><span>${src.board}</span></div>` : '';
  const wetsuit = src.wetsuit || day.wetsuit;

  // "NOW" timestamp — local hour from the API key (YYYY-MM-DDTHH:00).
  const nowTime = now && now.time ? now.time.slice(11, 16) : null;
  const headlineLabel = now ? `NOW${nowTime ? ` · ${nowTime}` : ''}` : 'TODAY';

  el.innerHTML = `
    ${shakaHTML(src.quality)}
    <div class="today-content">
      <div class="today-name">${headlineLabel}</div>
      <div class="verdict ${src.quality}">${VERDICT_LABEL[src.quality]}</div>
      <p class="summary">${VERDICT_BLURB[src.quality]}</p>
      <div class="info-pills">${tideBanner}${boardPill}</div>
      <div class="metrics">
        <div>
          <span class="label">Swell</span>
          <strong>${swellLine}</strong>
          ${chopLine ? `<small class="sub">${chopLine}</small>` : ''}
        </div>
        <div>
          <span class="label">Wind</span>
          <strong>${windPrimary}</strong>${windMeta}
        </div>
        <div>
          <span class="label">Water temp</span>
          <strong>${fmt(src.waterTemp != null ? src.waterTemp : day.waterTemp, 1)} °C</strong>
          ${(src.waterTemp != null || day.waterTemp != null) ? `<small class="sub">${waterTempLabel(src.waterTemp != null ? src.waterTemp : day.waterTemp)}</small>` : ''}
        </div>
        <div><span class="label">Air temp</span><strong>${fmt(src.airTemp != null ? src.airTemp : day.airTemp, 0)} °C</strong></div>
      </div>
      ${wetsuitBlock(wetsuit)}
    </div>
    <div class="today-slots">${slotsStrip(day.slots, { stacked: true })}</div>
  `;
}

function renderUpcoming(days) {
  const upcoming = days.slice(1);
  const grid = document.getElementById('upcoming');
  grid.innerHTML = upcoming.map((day, i) => {
    const { h, p } = primaryWave(day);
    const gusts = day.windGusts != null ? ` <small>g ${fmt(day.windGusts, 0)}</small>` : '';
    const tide = tideWindowText(day.tideWindows);
    return `
      <div class="day-card">
        <div class="day-name">${dayName(day.date, i + 1)}</div>
        ${shakaHTML(day.quality)}
        <div class="day-verdict ${day.quality}">${VERDICT_LABEL[day.quality]}</div>
        ${day.slots && day.slots.length ? `
          <details class="day-slots">
            <summary>Morning · Noon · Evening</summary>
            ${slotsStrip(day.slots, { compact: true })}
          </details>` : ''}
        <div class="day-metrics">
          <div>Swell <strong class="q-${qHeight(h)}">${fmt(h, 1)} m</strong> @ <span class="q-${qPeriod(p)}">${fmt(p, 0)} s</span> ${directionArrow(day.swellDirection)}</div>
          <div><span class="q-${qWind(day.windSpeed)}">${fmt(day.windSpeed, 0)} km/h</span> ${day.windCompass || ''} ${directionArrow(day.windDirection)}${gusts}</div>
          <div>Water <strong>${fmt(day.waterTemp, 1)} °C</strong>${day.waterTemp != null ? ' · ' + waterTempLabel(day.waterTemp) : ''} · Air ${fmt(day.airTemp, 0)} °C</div>
          ${tide ? `<div class="day-tide">Tide ${tide}</div>` : ''}
          ${day.board && SURFABLE.has(day.quality) ? `<div class="day-board">Board · <strong>${day.board}</strong></div>` : ''}
        </div>
        <div class="day-wetsuit">${shortKitSummary(day.wetsuit)}</div>
      </div>
    `;
  }).join('');
}

async function loadForecast(locationKey) {
  const todayEl = document.getElementById('today');
  todayEl.innerHTML = `<div class="loading">Loading forecast…</div>`;
  document.getElementById('upcoming').innerHTML = '';

  try {
    const res = await fetch(`/api/forecast?location=${encodeURIComponent(locationKey)}`);
    if (!res.ok) throw new Error(`API ${res.status}`);
    const { forecast, now } = await res.json();
    if (!forecast || forecast.length === 0) throw new Error('No forecast data');
    renderToday(forecast[0], now);
    renderUpcoming(forecast);
  } catch (err) {
    todayEl.innerHTML = `<div class="loading">Couldn’t load forecast: ${err.message}</div>`;
    console.error(err);
  }
}

function init() {
  const select = document.getElementById('location-select');
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved && [...select.options].some(o => o.value === saved)) {
    select.value = saved;
  }
  select.addEventListener('change', () => {
    localStorage.setItem(STORAGE_KEY, select.value);
    loadForecast(select.value);
  });
  loadForecast(select.value);
}

init();
