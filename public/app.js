/* global L */
const map = L.map('map', {
  zoomControl: false,
}).setView([-25.4284, -49.2733], 13);

L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap &copy; CARTO',
}).addTo(map);

const routeNameEl = document.getElementById('route-name');
const badgeEl = document.getElementById('connection-badge');
const runnerCountEl = document.getElementById('runner-count');
const runnerListEl = document.getElementById('runner-list');
const sheetEl = document.getElementById('sheet');
const sheetToggleEl = document.getElementById('sheet-toggle');
const btnFit = document.getElementById('btn-fit');
const btnRaw = document.getElementById('btn-raw');

let routeLayer = null;
let showRawGps = false;
let selectedRunnerId = null;
const runnersById = new Map();
const markers = new Map();
const rawMarkers = new Map();

sheetToggleEl.addEventListener('click', () => {
  sheetEl.classList.toggle('collapsed');
});

btnFit.addEventListener('click', () => {
  selectedRunnerId = null;
  if (routeLayer) {
    map.fitBounds(routeLayer.getBounds(), { padding: [40, 80] });
  }
  renderRunnerList();
});

btnRaw.addEventListener('click', () => {
  showRawGps = !showRawGps;
  btnRaw.textContent = `Raw GPS: ${showRawGps ? 'On' : 'Off'}`;
  btnRaw.classList.toggle('active', showRawGps);
  for (const [, rawLayer] of rawMarkers) {
    if (showRawGps) {
      rawLayer.addTo(map);
    } else {
      rawLayer.remove();
    }
  }
});

function formatPace(secPerKm) {
  if (!secPerKm || !Number.isFinite(secPerKm)) return '--:-- /km';
  const mins = Math.floor(secPerKm / 60);
  const secs = Math.round(secPerKm % 60);
  return `${mins}:${String(secs).padStart(2, '0')} /km`;
}

function formatAge(ageSeconds) {
  if (ageSeconds < 60) return `${ageSeconds}s ago`;
  const mins = Math.floor(ageSeconds / 60);
  const secs = ageSeconds % 60;
  return `${mins}m ${secs}s ago`;
}

function formatEta(etaSeconds) {
  if (!etaSeconds || !Number.isFinite(etaSeconds)) return '';
  const h = Math.floor(etaSeconds / 3600);
  const m = Math.floor((etaSeconds % 3600) / 60);
  return h > 0 ? `ETA ${h}h ${m}m` : `ETA ${m}m`;
}

function initials(name) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase() || '')
    .join('');
}

function upsertRunner(runner) {
  runnersById.set(runner.runnerId, runner);

  const pos = [runner.displayLat, runner.displayLon];
  const label = `${runner.name} · ${runner.distanceKm.toFixed(1)}k`;
  const icon = L.divIcon({
    className: '',
    html: `<div class="runner-marker-pin" style="background:${runner.color}">${label}</div>`,
    iconSize: [110, 28],
    iconAnchor: [55, 14],
  });

  if (markers.has(runner.runnerId)) {
    const m = markers.get(runner.runnerId);
    m.setLatLng(pos);
    m.setIcon(icon);
  } else {
    const m = L.marker(pos, { icon }).addTo(map);
    m.on('click', () => focusRunner(runner.runnerId));
    markers.set(runner.runnerId, m);
  }

  // Raw GPS marker (helpful for seeing how noisy Google Find Hub / tag pings are vs snapped)
  const rawPos = [runner.rawLat, runner.rawLon];
  if (rawMarkers.has(runner.runnerId)) {
    rawMarkers.get(runner.runnerId).setLatLng(rawPos);
  } else {
    const rawM = L.circleMarker(rawPos, {
      radius: 5,
      color: '#ffffff',
      weight: 1.5,
      fillColor: runner.color,
      fillOpacity: 0.65,
    });
    if (showRawGps) rawM.addTo(map);
    rawMarkers.set(runner.runnerId, rawM);
  }

  if (selectedRunnerId === runner.runnerId) {
    map.panTo(pos, { animate: true });
  }
}

function focusRunner(runnerId) {
  selectedRunnerId = runnerId;
  const r = runnersById.get(runnerId);
  if (r) {
    map.setView([r.displayLat, r.displayLon], 15, { animate: true });
  }
  renderRunnerList();
}

function renderRunnerList() {
  const list = Array.from(runnersById.values()).sort((a, b) => b.distanceKm - a.distanceKm);
  runnerCountEl.textContent = String(list.length);

  if (list.length === 0) {
    runnerListEl.innerHTML = `
      <div class="empty-state">
        Waiting for runner pings…<br />
        Start the <code>scraper</code> or run <code>npm run simulate</code>.
      </div>`;
    return;
  }

  runnerListEl.innerHTML = list
    .map((r) => {
      const selectedClass = r.runnerId === selectedRunnerId ? 'selected' : '';
      const modeTag = r.interpolated ? 'est.' : 'ping';
      const eta = formatEta(r.etaSeconds);
      return `
        <div class="runner-card ${selectedClass}" data-id="${r.runnerId}">
          <div class="runner-dot" style="background:${r.color}">${initials(r.name)}</div>
          <div class="runner-main">
            <div class="runner-name">
              <span>${r.name}</span>
              ${r.bib ? `<span class="runner-bib">#${r.bib}</span>` : ''}
            </div>
            <div class="runner-meta">
              Last ping ${formatAge(r.ageSeconds)} (${modeTag}) ${eta ? `· ${eta}` : ''}
            </div>
          </div>
          <div class="runner-stats">
            <div class="runner-km">${r.distanceKm.toFixed(2)} km</div>
            <div class="runner-pace">${formatPace(r.paceSecPerKm)}</div>
          </div>
        </div>`;
    })
    .join('');

  for (const card of runnerListEl.querySelectorAll('.runner-card')) {
    card.addEventListener('click', () => focusRunner(card.dataset.id));
  }
}

async function initRoute() {
  const res = await fetch('/api/route');
  const route = await res.json();
  routeNameEl.textContent = `${route.name} (${route.totalKm} km)`;

  routeLayer = L.polyline(route.points, {
    color: '#38bdf8',
    weight: 5,
    opacity: 0.85,
  }).addTo(map);

  // Add start/finish marker and km markers every 2 km
  if (route.points.length > 0) {
    const startIcon = L.divIcon({
      className: '',
      html: `<div class="km-marker" style="border-color:#22c55e">START</div>`,
      iconSize: [44, 20],
      iconAnchor: [22, 10],
    });
    L.marker(route.points[0], { icon: startIcon }).addTo(map);
  }

  let nextKm = 2;
  for (let i = 1; i < route.cumulativeMeters.length; i++) {
    const km = route.cumulativeMeters[i] / 1000;
    if (km >= nextKm) {
      const kmIcon = L.divIcon({
        className: '',
        html: `<div class="km-marker">${nextKm}k</div>`,
        iconSize: [28, 18],
        iconAnchor: [14, 9],
      });
      L.marker(route.points[i], { icon: kmIcon, interactive: false }).addTo(map);
      nextKm += 2;
    }
  }

  map.fitBounds(routeLayer.getBounds(), { padding: [40, 80] });
}

function connectStream() {
  const es = new EventSource('/api/stream');

  es.onopen = () => {
    badgeEl.textContent = 'Live';
    badgeEl.className = 'badge badge-live';
  };

  es.onerror = () => {
    badgeEl.textContent = 'Reconnecting…';
    badgeEl.className = 'badge badge-connecting';
  };

  es.addEventListener('snapshot', (ev) => {
    const data = JSON.parse(ev.data);
    for (const r of data.runners) upsertRunner(r);
    renderRunnerList();
  });

  es.addEventListener('tick', (ev) => {
    const data = JSON.parse(ev.data);
    for (const r of data.runners) upsertRunner(r);
    renderRunnerList();
  });

  es.addEventListener('runner_update', (ev) => {
    const runner = JSON.parse(ev.data);
    upsertRunner(runner);
    renderRunnerList();
  });
}

initRoute().then(connectStream);
