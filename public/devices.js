const statusBadgeEl = document.getElementById('status-badge');
const authWarningEl = document.getElementById('auth-warning');
const alertBoxEl = document.getElementById('alert-box');
const statusSummaryEl = document.getElementById('status-summary');
const statusSubEl = document.getElementById('status-sub');
const btnStartAll = document.getElementById('btn-start-all');
const btnStopAll = document.getElementById('btn-stop-all');
const btnLogout = document.getElementById('btn-logout');
const deviceListEl = document.getElementById('device-list');

let state = {
  active: false,
  devices: [],
  knownDevices: [],
  auth: { authenticated: null, reason: null },
  scraperConnected: false,
};
let busy = false;
let editingRunnerId = null;

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

const INTERVAL_OPTIONS = [
  { value: 15, label: '15 sec' },
  { value: 30, label: '30 sec' },
  { value: 60, label: '1 min' },
  { value: 120, label: '2 min' },
  { value: 300, label: '5 min' },
];

function formatIntervalLabel(seconds) {
  if (seconds < 60) return `${seconds} sec`;
  if (seconds % 60 === 0) {
    const mins = seconds / 60;
    return `${mins} min`;
  }
  return `${seconds} sec`;
}

function renderIntervalSelect(device) {
  const current = Number(device.pollIntervalSeconds) || 30;
  const options = [...INTERVAL_OPTIONS];
  if (!options.some((o) => o.value === current)) {
    options.push({ value: current, label: formatIntervalLabel(current) });
    options.sort((a, b) => a.value - b.value);
  }
  return `
    <label class="device-rate-row">
      <span>Update every</span>
      <select
        class="interval-select"
        data-interval-id="${escapeHtml(device.runnerId)}"
        aria-label="Update rate for ${escapeHtml(device.name)}"
        ${busy ? 'disabled' : ''}
      >
        ${options
          .map(
            (opt) =>
              `<option value="${opt.value}" ${opt.value === current ? 'selected' : ''}>${escapeHtml(opt.label)}</option>`
          )
          .join('')}
      </select>
    </label>`;
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
      const isEditing = editingRunnerId === device.runnerId;
      const titleBlock = isEditing
        ? `
          <form class="edit-name-form" data-runner-id="${escapeHtml(device.runnerId)}">
            <input
              type="text"
              class="edit-name-input"
              value="${escapeHtml(device.name)}"
              maxlength="60"
              aria-label="Runner name"
              ${busy ? 'disabled' : ''}
            />
            <button type="submit" class="btn btn-primary btn-sm" ${busy ? 'disabled' : ''}>Save</button>
            <button type="button" class="btn btn-sm cancel-edit-btn" ${busy ? 'disabled' : ''}>Cancel</button>
          </form>`
        : `
          <div class="device-title">
            <span>${escapeHtml(device.name)}</span>
            ${device.bib ? `<span class="device-bib">#${escapeHtml(device.bib)}</span>` : ''}
            <button
              type="button"
              class="edit-name-btn"
              data-edit-id="${escapeHtml(device.runnerId)}"
              ${busy ? 'disabled' : ''}
            >
              Edit
            </button>
          </div>`;

      return `
        <div class="device-card ${checked ? 'active' : ''}">
          <div class="device-avatar" style="background:${escapeHtml(device.color)}">
            ${escapeHtml(initials(device.name))}
          </div>
          <div class="device-info">
            ${titleBlock}
            <div class="device-meta">${escapeHtml(device.deviceName)}</div>
            ${renderIntervalSelect(device)}
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

  for (const select of deviceListEl.querySelectorAll('.interval-select')) {
    select.addEventListener('change', (ev) => {
      const runnerId = ev.target.dataset.intervalId;
      const intervalSeconds = Number(ev.target.value);
      saveDeviceInterval(runnerId, intervalSeconds);
    });
  }

  for (const btn of deviceListEl.querySelectorAll('.edit-name-btn')) {
    btn.addEventListener('click', () => {
      editingRunnerId = btn.dataset.editId;
      render();
      const input = deviceListEl.querySelector('.edit-name-input');
      if (input) {
        input.focus();
        input.select();
      }
    });
  }

  const editForm = deviceListEl.querySelector('.edit-name-form');
  if (editForm) {
    const input = editForm.querySelector('.edit-name-input');
    const cancelBtn = editForm.querySelector('.cancel-edit-btn');
    cancelBtn?.addEventListener('click', () => {
      editingRunnerId = null;
      render();
    });
    input?.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        editingRunnerId = null;
        render();
      }
    });
    editForm.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const nextName = (input?.value || '').trim();
      if (!nextName) return;
      saveDeviceName(editForm.dataset.runnerId, nextName);
    });
  }
}

async function fetchStatus() {
  if (busy || editingRunnerId) return;
  try {
    const res = await fetch('/api/scraper', { cache: 'no-store' });
    if (res.status === 401) {
      window.location.href = '/login?next=/devices';
      return;
    }
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

async function saveDeviceInterval(runnerId, intervalSeconds) {
  busy = true;
  showError('');
  render();

  try {
    const res = await fetch('/api/scraper/interval', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runnerId, intervalSeconds }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error('interval_failed');
    }
    if (Array.isArray(data.knownDevices)) {
      state = { ...state, knownDevices: data.knownDevices };
    }
  } catch {
    showError('Could not update the refresh rate. Please try again.');
    await fetchStatus();
  } finally {
    busy = false;
    render();
  }
}

async function saveDeviceName(runnerId, name) {
  busy = true;
  showError('');
  render();

  try {
    const res = await fetch('/api/scraper/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runnerId, name }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error('rename_failed');
    }
    if (Array.isArray(data.knownDevices)) {
      state = { ...state, knownDevices: data.knownDevices };
    }
    editingRunnerId = null;
  } catch {
    showError('Could not update the name. Please try again.');
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

btnLogout?.addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
  window.location.href = '/login?next=/devices';
});

fetchStatus();
setInterval(fetchStatus, 4000);
