/**
 * Manages the desired collection state of connected Google Find Hub scrapers
 * and broadcasts start/stop commands over SSE.
 */

function normalizeDevices(devices) {
  if (devices === undefined || devices === null) {
    return undefined;
  }

  let list;
  if (typeof devices === 'string') {
    const trimmed = devices.trim();
    if (!trimmed) return [];
    if (trimmed.toLowerCase() === 'all' || trimmed === '*') return null;
    list = trimmed
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  } else if (Array.isArray(devices)) {
    list = devices
      .map((d) => (typeof d === 'string' || typeof d === 'number' ? String(d).trim() : ''))
      .filter(Boolean);
  } else {
    throw new Error('Invalid devices: expected an array of device names/IDs, a comma-separated string, or "all".');
  }

  if (list.some((d) => d === '*' || d.toLowerCase() === 'all')) {
    return null;
  }

  // Deduplicate case-insensitively while preserving original casing
  const seen = new Set();
  const deduped = [];
  for (const item of list) {
    const key = item.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(item);
    }
  }
  return deduped;
}

export class ScraperController {
  constructor() {
    this.state = {
      active: false,
      devices: [], // null = all configured devices; string[] = specific devices; [] when stopped
      updatedAt: null,
    };
    this.knownDevices = [];
    this.customNames = new Map();
    this.deviceIntervals = new Map(); // runnerId -> pollIntervalSeconds
    this.auth = {
      authenticated: null, // null = unknown/not yet reported, true = signed in, false = needs login
      reason: null,
      updatedAt: null,
    };
    this.listeners = new Set();
  }

  setAuthStatus({ authenticated, reason = null } = {}) {
    if (typeof authenticated !== 'boolean') {
      throw new Error('Invalid auth status: boolean "authenticated" is required.');
    }
    this.auth = {
      authenticated,
      reason: authenticated ? null : reason ? String(reason) : 'Google sign-in required',
      updatedAt: Date.now(),
    };
    return this.auth;
  }

  setKnownDevices(devices) {
    if (!Array.isArray(devices)) {
      throw new Error('Invalid devices list: expected an array.');
    }
    this.knownDevices = devices
      .filter((d) => d && (d.runnerId || d.deviceName || d.name))
      .map((d) => {
        const runnerId = String(d.runnerId || d.deviceName || d.name).trim();
        const defaultName = String(d.name || d.deviceName || d.runnerId).trim();
        const defaultInterval =
          Number.isFinite(Number(d.pollIntervalSeconds)) && Number(d.pollIntervalSeconds) >= 10
            ? Math.round(Number(d.pollIntervalSeconds))
            : 30;
        const interval = this.deviceIntervals.get(runnerId) ?? defaultInterval;
        return {
          runnerId,
          deviceName: String(d.deviceName || d.runnerId || d.name).trim(),
          name: this.customNames.get(runnerId) || defaultName,
          bib: d.bib ? String(d.bib).trim() : '',
          color: typeof d.color === 'string' && d.color.trim() ? d.color.trim() : '#38bdf8',
          pollIntervalSeconds: interval,
        };
      });
    return this.knownDevices;
  }

  getDeviceIntervalsObject() {
    const out = {};
    for (const device of this.knownDevices) {
      if (Number.isFinite(device.pollIntervalSeconds)) {
        out[device.runnerId] = device.pollIntervalSeconds;
      }
    }
    for (const [runnerId, seconds] of this.deviceIntervals.entries()) {
      out[runnerId] = seconds;
    }
    return out;
  }

  setDeviceInterval(runnerId, intervalSeconds) {
    const id = String(runnerId || '').trim();
    const secs = Math.round(Number(intervalSeconds));
    if (!id) {
      throw new Error('Device ID is required.');
    }
    if (!Number.isFinite(secs) || secs < 10 || secs > 3600) {
      throw new Error('Update rate must be between 10 and 3600 seconds.');
    }

    this.deviceIntervals.set(id, secs);
    for (const device of this.knownDevices) {
      if (device.runnerId === id) {
        device.pollIntervalSeconds = secs;
      }
    }

    const deviceIntervals = this.getDeviceIntervalsObject();
    this.broadcast('command', {
      action: this.state.active ? 'start' : 'stop',
      ...this.state,
      deviceIntervals,
    });

    return {
      runnerId: id,
      intervalSeconds: secs,
      deviceIntervals,
      knownDevices: this.knownDevices,
    };
  }

  getDisplayName(runnerId, fallbackName = '') {
    const key = String(runnerId || '').trim();
    if (key && this.customNames.has(key)) {
      return this.customNames.get(key);
    }
    return fallbackName;
  }

  renameDevice(runnerId, newName) {
    const id = String(runnerId || '').trim();
    const name = String(newName || '').trim();
    if (!id) {
      throw new Error('Device ID is required.');
    }
    if (!name || name.length > 60) {
      throw new Error('Name must be between 1 and 60 characters.');
    }

    this.customNames.set(id, name);
    for (const device of this.knownDevices) {
      if (device.runnerId === id) {
        device.name = name;
      }
    }

    return {
      runnerId: id,
      name,
      knownDevices: this.knownDevices,
    };
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  broadcast(event, payload) {
    for (const listener of this.listeners) {
      try {
        listener(event, payload);
      } catch {
        // Ignore broken subscriber connections
      }
    }
  }

  getStatus() {
    return {
      active: this.state.active,
      devices: this.state.devices,
      knownDevices: this.knownDevices,
      deviceIntervals: this.getDeviceIntervalsObject(),
      auth: this.auth,
      scraperConnected: this.listeners.size > 0,
      connectedScrapers: this.listeners.size,
      updatedAt: this.state.updatedAt,
    };
  }

  getActiveDevices() {
    if (!this.state.active) return [];
    if (this.state.devices === null) {
      return [...this.knownDevices];
    }
    if (!Array.isArray(this.state.devices)) return [];

    const result = [];
    const seen = new Set();

    for (const id of this.state.devices) {
      const needle = String(id || '').trim().toLowerCase();
      if (!needle) continue;
      const matches = this.knownDevices.filter((d) =>
        [d.runnerId, d.deviceName, d.name].some(
          (field) => typeof field === 'string' && field.trim().toLowerCase() === needle
        )
      );
      if (matches.length > 0) {
        for (const m of matches) {
          if (!seen.has(m.runnerId)) {
            seen.add(m.runnerId);
            result.push(m);
          }
        }
      } else if (!seen.has(id)) {
        seen.add(id);
        result.push({
          runnerId: id,
          deviceName: id,
          name: id,
          bib: '',
          color: '#38bdf8',
        });
      }
    }

    return result;
  }

  handleCommand({ action, devices } = {}) {
    const normalizedAction = typeof action === 'string' ? action.trim().toLowerCase() : '';
    if (normalizedAction !== 'start' && normalizedAction !== 'stop') {
      throw new Error('Invalid action: expected "start" or "stop".');
    }

    const normalizedDevices = normalizeDevices(devices);
    const now = Date.now();

    if (normalizedAction === 'start') {
      if (Array.isArray(normalizedDevices) && normalizedDevices.length === 0) {
        throw new Error(
          'At least one device must be specified when starting, or omit "devices" / pass "all" to activate all devices.'
        );
      }

      this.state = {
        active: true,
        devices: normalizedDevices === undefined ? null : normalizedDevices,
        updatedAt: now,
      };

      const command = {
        action: 'start',
        ...this.state,
        deviceIntervals: this.getDeviceIntervalsObject(),
      };
      this.broadcast('command', command);

      return {
        ok: true,
        action: 'start',
        ...this.getStatus(),
      };
    }

    // action === 'stop'
    const isFullStop =
      normalizedDevices === undefined ||
      normalizedDevices === null ||
      (Array.isArray(normalizedDevices) && normalizedDevices.length === 0);

    if (isFullStop || !this.state.active) {
      this.state = {
        active: false,
        devices: [],
        updatedAt: now,
      };
      this.broadcast('command', {
        action: 'stop',
        ...this.state,
      });
      return {
        ok: true,
        action: 'stop',
        ...this.getStatus(),
      };
    }

    // Partial stop while active
    if (Array.isArray(this.state.devices)) {
      const toRemove = new Set(normalizedDevices.map((d) => d.toLowerCase()));
      const remaining = this.state.devices.filter((d) => !toRemove.has(d.toLowerCase()));

      if (remaining.length === 0) {
        this.state = {
          active: false,
          devices: [],
          updatedAt: now,
        };
        this.broadcast('command', {
          action: 'stop',
          ...this.state,
        });
      } else {
        this.state = {
          active: true,
          devices: remaining,
          updatedAt: now,
        };
        this.broadcast('command', {
          action: 'start',
          ...this.state,
          deviceIntervals: this.getDeviceIntervalsObject(),
        });
      }

      return {
        ok: true,
        action: 'stop',
        ...this.getStatus(),
      };
    }

    // Currently active with "all" devices (devices === null), and specific devices were requested to stop
    this.state = {
      ...this.state,
      updatedAt: now,
    };
    this.broadcast('command', {
      action: 'stop',
      ...this.state,
      stopDevices: normalizedDevices,
    });

    return {
      ok: true,
      action: 'stop',
      stopDevices: normalizedDevices,
      ...this.getStatus(),
    };
  }
}
