/* global L */
const openCountBadge = document.getElementById('open-count-badge');
const alertBox = document.getElementById('alert-box');
const mapsListEl = document.getElementById('maps-list');
const devicesListEl = document.getElementById('devices-list');
const btnFitPreview = document.getElementById('btn-fit-preview');
const btnLogout = document.getElementById('btn-logout');

const uploadForm = document.getElementById('upload-form');
const mapNameEl = document.getElementById('map-name');
const mapDistanceEl = document.getElementById('map-distance');
const mapColorEl = document.getElementById('map-color');
const mapCityEl = document.getElementById('map-city');
const mapFileEl = document.getElementById('map-file');
const mapOpenEl = document.getElementById('map-open');
const mapPrimaryEl = document.getElementById('map-primary');
const btnUpload = document.getElementById('btn-upload');

const previewMap = L.map('preview-map', { zoomControl: true }).setView([-25.4284, -49.2733], 13);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors',
}).addTo(previewMap);

const previewLayers = new Map();
let currentState = null;

function showAlert(msg, kind = 'success') {
  alertBox.textContent = msg;
  alertBox.className = `alert ${kind}`;
}

function clearAlert() {
  alertBox.className = 'alert hidden';
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function apiPost(url, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (res.status === 401) {
    window.location.href = '/login?next=%2Fmap';
    return null;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function renderPreview(openMaps) {
  for (const layer of previewLayers.values()) {
    layer.remove();
  }
  previewLayers.clear();

  const boundsList = [];
  for (const m of openMaps || []) {
    if (!Array.isArray(m.points) || m.points.length < 2) continue;
    const line = L.polyline(m.points, {
      color: m.color || '#ff4d00',
      weight: m.isPrimary ? 5 : 4,
      opacity: m.isPrimary ? 0.95 : 0.8,
    })
      .bindTooltip(`${m.name} (${m.distanceLabel})`, { sticky: true })
      .addTo(previewMap);
    previewLayers.set(m.id, line);
    boundsList.push(line.getBounds());
  }

  fitAllPreview();
}

function fitAllPreview() {
  let combined = null;
  for (const layer of previewLayers.values()) {
    const b = layer.getBounds();
    combined = combined ? combined.extend(b) : L.latLngBounds(b.getSouthWest(), b.getNorthEast());
  }
  if (combined && combined.isValid()) {
    previewMap.fitBounds(combined, { padding: [24, 24] });
  }
}

function renderMapsList(state) {
  const openCount = (state.maps || []).filter((m) => m.open).length;
  openCountBadge.textContent = `${openCount} Open`;

  if (!state.maps || state.maps.length === 0) {
    mapsListEl.innerHTML = '<div class="empty-state">No maps saved yet.</div>';
    return;
  }

  mapsListEl.innerHTML = state.maps
    .map((m) => {
      const assignedCount = Object.values(state.deviceMaps || {}).filter((id) => id === m.id).length;
      const canDelete = state.maps.length > 1;
      return `
        <div class="map-card ${m.isPrimary ? 'is-primary' : ''}">
          <div class="map-card-top">
            <div class="map-identity">
              <span class="color-dot" style="background:${escapeHtml(m.color)}"></span>
              <div>
                <div class="map-name">${escapeHtml(m.name)}</div>
                <div class="map-sub">
                  ${escapeHtml(m.distanceLabel)} · ${m.totalKm} km · ${m.pointCount} pts${
                    assignedCount > 0 ? ` · ${assignedCount} device(s)` : ''
                  }
                </div>
              </div>
            </div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;">
              ${m.isPrimary ? '<span class="pill pill-primary">Default</span>' : ''}
              <span class="pill ${m.open ? 'pill-open' : 'pill-closed'}">${m.open ? 'Open' : 'Closed'}</span>
            </div>
          </div>

          <div class="card-actions">
            ${
              !m.isPrimary
                ? `<button class="btn btn-primary" data-action="primary" data-id="${escapeHtml(m.id)}">Set Default</button>`
                : ''
            }
            <button class="btn btn-secondary" data-action="toggle-open" data-open="${m.open ? '0' : '1'}" data-id="${escapeHtml(m.id)}">
              ${m.open ? 'Close Map' : 'Open Map'}
            </button>
            ${
              m.open
                ? `<button class="btn btn-secondary" data-action="focus" data-id="${escapeHtml(m.id)}">Focus</button>`
                : ''
            }
            ${
              canDelete
                ? `<button class="btn btn-danger" data-action="delete" data-id="${escapeHtml(m.id)}">Delete</button>`
                : ''
            }
          </div>
        </div>
      `;
    })
    .join('');

  for (const btn of mapsListEl.querySelectorAll('button[data-action]')) {
    btn.addEventListener('click', async () => {
      clearAlert();
      const action = btn.dataset.action;
      const mapId = btn.dataset.id;
      try {
        if (action === 'focus') {
          const layer = previewLayers.get(mapId);
          if (layer) previewMap.fitBounds(layer.getBounds(), { padding: [24, 24] });
          return;
        }
        if (action === 'primary') {
          await apiPost('/api/maps/select', { mapId });
          showAlert('Default map updated.');
        } else if (action === 'toggle-open') {
          const open = btn.dataset.open === '1';
          await apiPost('/api/maps/open', { mapId, open });
          showAlert(open ? 'Map opened.' : 'Map closed.');
        } else if (action === 'delete') {
          if (!confirm('Delete this map from the server?')) return;
          await apiPost('/api/maps/delete', { mapId });
          showAlert('Map deleted.');
        }
        await loadState();
      } catch (err) {
        showAlert(err.message, 'error');
      }
    });
  }
}

function renderDevicesList(state) {
  const devices = state.knownDevices || [];
  const openMaps = (state.maps || []).filter((m) => m.open);
  const primary = (state.maps || []).find((m) => m.isPrimary);

  if (devices.length === 0) {
    devicesListEl.innerHTML =
      '<div class="empty-state">No devices reported by scraper yet. Once devices appear on /devices, you can assign each one to 5k, 10k, 21k, etc.</div>';
    return;
  }

  devicesListEl.innerHTML = devices
    .map((d) => {
      const assignedId = state.deviceMaps?.[d.runnerId] || '';
      const options = [
        `<option value="">Default (${escapeHtml(primary ? primary.distanceLabel : 'Primary')})</option>`,
        ...openMaps.map(
          (m) =>
            `<option value="${escapeHtml(m.id)}" ${assignedId === m.id ? 'selected' : ''}>${escapeHtml(
              m.name
            )} (${escapeHtml(m.distanceLabel)})</option>`
        ),
      ].join('');
      return `
        <div class="device-row">
          <div>
            <div class="device-name">${escapeHtml(d.name)}</div>
            <div class="device-id">${escapeHtml(d.runnerId)}</div>
          </div>
          <select data-runner-id="${escapeHtml(d.runnerId)}">${options}</select>
        </div>
      `;
    })
    .join('');

  for (const sel of devicesListEl.querySelectorAll('select[data-runner-id]')) {
    sel.addEventListener('change', async () => {
      clearAlert();
      try {
        await apiPost('/api/maps/assign', {
          runnerId: sel.dataset.runnerId,
          mapId: sel.value || null,
        });
        showAlert('Device map assignment saved.');
        await loadState();
      } catch (err) {
        showAlert(err.message, 'error');
      }
    });
  }
}

async function loadState() {
  const res = await fetch('/api/maps', { cache: 'no-store' });
  if (res.status === 401) {
    window.location.href = '/login?next=%2Fmap';
    return;
  }
  const data = await res.json();
  currentState = data;
  renderPreview(data.openMaps);
  renderMapsList(data);
  renderDevicesList(data);
}

uploadForm.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  clearAlert();
  const file = mapFileEl.files?.[0];
  if (!file) {
    showAlert('Select a .gpx or .json route file.', 'error');
    return;
  }

  btnUpload.disabled = true;
  try {
    const text = await file.text();
    const isGpx = file.name.toLowerCase().endsWith('.gpx') || text.trim().startsWith('<');
    const payload = {
      name: mapNameEl.value.trim(),
      distanceLabel: mapDistanceEl.value.trim(),
      city: mapCityEl.value.trim(),
      color: mapColorEl.value,
      open: mapOpenEl.checked,
      setPrimary: mapPrimaryEl.checked,
      ...(isGpx ? { gpx: text } : { json: text }),
    };

    const result = await apiPost('/api/maps', payload);
    if (result?.ok) {
      showAlert(`Added "${result.map.name}" (${result.map.totalKm} km).`);
      uploadForm.reset();
      mapOpenEl.checked = true;
      await loadState();
    }
  } catch (err) {
    showAlert(err.message || 'Could not upload map.', 'error');
  } finally {
    btnUpload.disabled = false;
  }
});

btnFitPreview.addEventListener('click', fitAllPreview);
btnLogout.addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.href = '/login';
});

loadState();
