const API_KEY_STORAGE = 'eagles_api_key';

const scraperBadgeEl = document.getElementById('scraper-badge');
const authCardEl = document.getElementById('auth-card');
const apiKeyInput = document.getElementById('api-key-input');
const btnSaveKey = document.getElementById('btn-save-key');
const alertBoxEl = document.getElementById('alert-box');
const statusSummaryEl = document.getElementById('status-summary');
const statusSubEl = document.getElementById('status-sub');
const btnStartAll = document.getElementById('btn-start-all');
const btnStopAll = document.getElementById('btn-stop-all');
const deviceListEl = document.getElementById('device-list');

let state = {
  active: false,
  devices: [],
  knownDevices: [],
  scraperConnected: false,
  authRequired: false,
};
let busy = false;

apiKeyInput.value = localStorage.getItem(API_KEY_STORAGE) || '';

function getApiKey() {
  return apiKeyInput.value.trim();
}

function showError(msg) {
  if (!msg) {
    alertBoxEl.classList.add('hidden');
    alertBoxEl.textContent = '';
    return;
  }
  alertBoxEl.textContent = msg;
  alertBoxEl.classList.remove('hidden');
}

function initials(name) {
  return String(name || '?')
    .split(/\s+/)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase() || '')
    .join('');
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isDeviceActive(device) {
  if (!state.active) return false;
  if (state.devices === null) return true;
  if (!Array.isArray(state.devices)) return false;

  const activeSet = new Set(state.devices.map((d) => String(d).trim().toLowerCase()));
  return [device.runnerId, device.deviceName, device.name].some(
    (field) => field && activeSet.has(String(field).trim().toLowerCase())
  );
}

function getActiveDeviceIds() {
  return state.knownDevices.filter((d) => isDeviceActive(d)).map((d) => d.runnerId);
}

function render() {
  // Auth card visibility
  authCardEl.classList.toggle('hidden', !state.authRequired);

  // Scraper connection badge
  if (state.scraperConnected) {
    scraperBadgeEl.textContent = 'Scraper Online';
    scraperBadgeEl.className = 'badge badge-live';
  } else {
    scraperBadgeEl.textContent = 'Scraper Offline';
    scraperBadgeEl.className = 'badge badge-connecting';
  }

  const known = state.knownDevices || [];
  const activeCount = known.filter((d) => isDeviceActive(d)).length;

  if (state.active) {
    statusSummaryEl.textContent = 'Collecting';
    statusSubEl.textContent =
      known.length > 0
        ? `${activeCount} of ${known.length} device${known.length === 1 ? '' : 's'} active`
        : state.devices === null
          ? 'All devices active'
          : `${(state.devices || []).length} device(s) active`;
  } else {
    statusSummaryEl.textContent = 'Idle';
    statusSubEl.textContent =
      known.length > 0 ? 'Toggle a device to start collecting' : 'Waiting for scraper to connect';
  }

  btnStartAll.disabled = busy || known.length === 0 || (state.active && activeCount === known.length);
  btnStopAll.disabled = busy || !state.active;

  if (known.length === 0) {
    deviceListEl.innerHTML = `
      <div class="empty-state">
        No devices reported yet.<br />
        Start <code>eagles-scrapper</code> and sign into Google Find Hub — configured devices will appear here automatically.
      </div>`;
    return;
  }

  deviceListEl.innerHTML = known
    .map((device) => {
      const checked = isDeviceActive(device);
      return `
        <div class="device-card ${checked ? 'active' : ''}">
          <div class="device-avatar" style="background:${escapeHtml(device.color)}">
            ${escapeHtml(initials(device.name))}
          </div>
          <div class="device-info">
            <div class="device-title">
              <span>${escapeHtml(device.name)}</span>
              ${device.bib ? `<span class="device-bib">#${escapeHtml(device.bib)}</span>` : ''}
            </div>
            <div class="device-meta">
              ${escapeHtml(device.deviceName)} · ${escapeHtml(device.runnerId)}
            </div>
          </div>
          <label class="switch" aria-label="Toggle ${escapeHtml(device.name)}">
            <input
              type="checkbox"
              data-runner-id="${escapeHtml(device.runnerId)}"
              ${checked ? 'checked' : ''}
              ${busy ? 'disabled' : ''}
            />
            <span class="slider"></span>
          </label>
        </div>`;
    })
    .join('');

  for (const input of deviceListEl.querySelectorAll('input[type="checkbox"]')) {
    input.addEventListener('change', (ev) => {
      const runnerId = ev.target.dataset.runnerId;
      toggleDevice(runnerId, ev.target.checked);
    });
  }
}

async function fetchStatus() {
  if (busy) return;
  try {
    const res = await fetch('/api/scraper', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state = data;
    render();
  } catch (err) {
    showError(`Failed to load scraper status: ${err.message}`);
  }
}

async function sendCommand(payload) {
  busy = true;
  showError('');
  render();

  const headers = { 'Content-Type': 'application/json' };
  const key = getApiKey();
  if (key) headers['X-API-Key'] = key;

  try {
    const res = await fetch('/api/scraper', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401) {
        state.authRequired = true;
        apiKeyInput.focus();
      }
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    state = { ...state, ...data };
  } catch (err) {
    showError(err.message);
    await fetchStatus();
  } finally {
    busy = false;
    render();
  }
}

async function toggleDevice(runnerId, enabled) {
  const currentActive = getActiveDeviceIds();
  let nextActive;

  if (enabled) {
    nextActive = currentActive.includes(runnerId) ? currentActive : [...currentActive, runnerId];
  } else {
    nextActive = currentActive.filter((id) => id !== runnerId);
  }

  if (nextActive.length === 0) {
    await sendCommand({ action: 'stop' });
  } else {
    await sendCommand({ action: 'start', devices: nextActive });
  }
}

btnSaveKey.addEventListener('click', () => {
  localStorage.setItem(API_KEY_STORAGE, getApiKey());
  showError('');
});

btnStartAll.addEventListener('click', () => {
  const allIds = state.knownDevices.map((d) => d.runnerId);
  if (allIds.length > 0) {
    sendCommand({ action: 'start', devices: allIds });
  }
});

btnStopAll.addEventListener('click', () => {
  sendCommand({ action: 'stop' });
});

fetchStatus();
setInterval(fetchStatus, 4000);
