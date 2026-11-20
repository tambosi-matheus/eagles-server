const statusBadgeEl = document.getElementById('status-badge');
const authWarningEl = document.getElementById('auth-warning');
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
  auth: { authenticated: null, reason: null },
  scraperConnected: false,
};
let busy = false;

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
  const authBroken = state.scraperConnected && state.auth && state.auth.authenticated === false;
  authWarningEl.classList.toggle('hidden', !authBroken);

  if (authBroken) {
    statusBadgeEl.textContent = 'Sign-in Needed';
    statusBadgeEl.className = 'badge badge-connecting';
  } else if (state.scraperConnected) {
    statusBadgeEl.textContent = 'Online';
    statusBadgeEl.className = 'badge badge-live';
  } else {
    statusBadgeEl.textContent = 'Offline';
    statusBadgeEl.className = 'badge badge-connecting';
  }

  const known = state.knownDevices || [];
  const activeCount = known.filter((d) => isDeviceActive(d)).length;

  if (state.active) {
    statusSummaryEl.textContent = 'Tracking Active';
    statusSubEl.textContent =
      known.length > 0
        ? `${activeCount} of ${known.length} ${known.length === 1 ? 'device' : 'devices'} active`
        : 'Tracking in progress';
  } else {
    statusSummaryEl.textContent = 'Paused';
    statusSubEl.textContent =
      known.length > 0
        ? 'Turn on a device to start live tracking'
        : 'Waiting for devices to come online';
  }

  btnStartAll.disabled = busy || known.length === 0 || (state.active && activeCount === known.length);
  btnStopAll.disabled = busy || !state.active;

  if (known.length === 0) {
    deviceListEl.innerHTML = `
      <div class="empty-state">
        No devices available right now.<br />
        Please check back in a moment.
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
            <div class="device-meta">${escapeHtml(device.deviceName)}</div>
          </div>
          <label class="switch" aria-label="Toggle tracking for ${escapeHtml(device.name)}">
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
    if (!res.ok) throw new Error('status');
    const data = await res.json();
    state = data;
    showError('');
    render();
  } catch {
    showError('Unable to connect right now. Retrying…');
  }
}

async function sendCommand(payload) {
  busy = true;
  showError('');
  render();

  try {
    const res = await fetch('/api/scraper', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error('update_failed');
    }
    state = { ...state, ...data };
  } catch {
    showError('Could not update tracking. Please try again.');
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
