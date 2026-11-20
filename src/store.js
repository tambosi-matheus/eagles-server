import { pointAtDistance, snapToRoute } from './gpx-matcher.js';

const DEFAULT_COLORS = ['#38bdf8', '#f97316', '#22c55e', '#a855f7', '#f43f5e', '#eab308'];
const MAX_EXTRAPOLATION_SECONDS = 600; // Stop extrapolating if no ping for > 10 minutes
const MAX_HISTORY_POINTS = 50;

export class RunnerStore {
  constructor(route) {
    this.route = route;
    this.runners = new Map();
    this.listeners = new Set();
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

  /**
   * Ensure all currently active devices appear in the runner list even before
   * their first location ping arrives, and remove waiting-only entries when deactivated.
   */
  syncActiveDevices(activeDevices = []) {
    const activeIds = new Set();
    let changed = false;

    for (const device of activeDevices) {
      if (!device || !device.runnerId) continue;
      const runnerId = String(device.runnerId).trim();
      if (!runnerId) continue;
      activeIds.add(runnerId);

      const existing = this.runners.get(runnerId);
      if (!existing) {
        const assignedColor =
          device.color || DEFAULT_COLORS[this.runners.size % DEFAULT_COLORS.length];
        this.runners.set(runnerId, {
          runnerId,
          name: device.name || device.deviceName || runnerId,
          bib: device.bib || '',
          color: assignedColor,
          hasLocation: false,
          source: null,
          rawLat: null,
          rawLon: null,
          accuracyMeters: null,
          snappedLat: null,
          snappedLon: null,
          distanceMeters: 0,
          crossTrackMeters: null,
          onCourse: false,
          speedMps: null,
          lastPingAt: null,
          history: [],
        });
        changed = true;
      }
    }

    for (const [runnerId, record] of this.runners.entries()) {
      if (record.hasLocation === false && !activeIds.has(runnerId)) {
        this.runners.delete(runnerId);
        changed = true;
      }
    }

    if (changed) {
      this.broadcast('snapshot', this.getSnapshot());
    }
  }

  /**
   * Ingest a location update from the Google Find Hub scraper, Android phone, or simulator.
   */
  ingestPing(ping) {
    const {
      runnerId,
      name,
      bib = '',
      color,
      lat,
      lon,
      accuracyMeters = null,
      timestamp = Date.now(),
      source = 'unknown',
    } = ping;

    if (!runnerId || !Number.isFinite(lat) || !Number.isFinite(lon)) {
      throw new Error('Invalid ping: runnerId, numeric lat, and numeric lon are required.');
    }

    const ts = typeof timestamp === 'string' ? Date.parse(timestamp) : Number(timestamp);
    const pingMs = Number.isFinite(ts) ? ts : Date.now();

    const existing = this.runners.get(runnerId);
    const assignedColor =
      color || existing?.color || DEFAULT_COLORS[this.runners.size % DEFAULT_COLORS.length];

    const elapsedSec =
      existing && existing.lastPingAt != null && pingMs > existing.lastPingAt
        ? (pingMs - existing.lastPingAt) / 1000
        : null;

    const snapped = snapToRoute(this.route, lat, lon, {
      lastDistanceMeters: existing?.onCourse ? existing.distanceMeters : null,
      elapsedSeconds: elapsedSec,
    });

    const history = existing ? [...existing.history] : [];
    history.push({
      ts: pingMs,
      lat,
      lon,
      distanceMeters: snapped.distanceMeters,
      onCourse: snapped.onCourse,
    });
    if (history.length > MAX_HISTORY_POINTS) {
      history.shift();
    }

    // Compute rolling speed (m/s) over recent on-course history (~last 3-10 minutes)
    const speedMps = this._computeRollingSpeed(history, existing?.speedMps ?? null);

    const record = {
      runnerId,
      name: name || existing?.name || runnerId,
      bib: bib || existing?.bib || '',
      color: assignedColor,
      hasLocation: true,
      source,
      rawLat: lat,
      rawLon: lon,
      accuracyMeters,
      snappedLat: snapped.lat,
      snappedLon: snapped.lon,
      distanceMeters: snapped.distanceMeters,
      crossTrackMeters: Math.round(snapped.crossTrackMeters),
      onCourse: snapped.onCourse,
      speedMps,
      lastPingAt: pingMs,
      history,
    };

    this.runners.set(runnerId, record);
    const view = this._toPublicView(record, Date.now());
    this.broadcast('runner_update', view);
    return view;
  }

  _computeRollingSpeed(history, fallbackSpeed) {
    const onCoursePoints = history.filter((p) => p.onCourse);
    if (onCoursePoints.length < 2) return fallbackSpeed;

    const latest = onCoursePoints[onCoursePoints.length - 1];
    // Pick an anchor point at least 20 seconds earlier (up to ~5 minutes back)
    let anchor = onCoursePoints[0];
    for (let i = onCoursePoints.length - 2; i >= 0; i--) {
      const dt = (latest.ts - onCoursePoints[i].ts) / 1000;
      if (dt >= 20) {
        anchor = onCoursePoints[i];
        break;
      }
    }

    const dtSec = (latest.ts - anchor.ts) / 1000;
    const dMeters = latest.distanceMeters - anchor.distanceMeters;
    if (dtSec <= 5 || dMeters <= 0) {
      return fallbackSpeed;
    }

    const rawSpeed = dMeters / dtSec;
    // Clamp to plausible running/walking speeds (0.8 m/s ~ 20 min/km up to 6.2 m/s ~ 2:41 min/km)
    if (rawSpeed < 0.5 || rawSpeed > 6.5) {
      return fallbackSpeed;
    }
    return rawSpeed;
  }

  _toPublicView(record, nowMs) {
    if (record.hasLocation === false) {
      return {
        runnerId: record.runnerId,
        name: record.name,
        bib: record.bib,
        color: record.color,
        hasLocation: false,
        source: null,
        rawLat: null,
        rawLon: null,
        accuracyMeters: null,
        snappedLat: null,
        snappedLon: null,
        displayLat: null,
        displayLon: null,
        interpolated: false,
        onCourse: false,
        crossTrackMeters: null,
        distanceKm: null,
        lastVerifiedKm: null,
        progressPct: 0,
        speedMps: null,
        paceSecPerKm: null,
        etaSeconds: null,
        lastPingAt: null,
        ageSeconds: null,
      };
    }

    const ageSeconds = Math.max(0, (nowMs - record.lastPingAt) / 1000);
    let estimatedDistanceMeters = record.distanceMeters;
    let displayLat = record.onCourse ? record.snappedLat : record.rawLat;
    let displayLon = record.onCourse ? record.snappedLon : record.rawLon;
    let interpolated = false;

    if (
      record.onCourse &&
      record.speedMps &&
      ageSeconds > 1 &&
      ageSeconds <= MAX_EXTRAPOLATION_SECONDS &&
      record.distanceMeters < this.route.totalMeters
    ) {
      estimatedDistanceMeters = Math.min(
        this.route.totalMeters,
        record.distanceMeters + record.speedMps * ageSeconds
      );
      const pt = pointAtDistance(this.route, estimatedDistanceMeters);
      displayLat = pt.lat;
      displayLon = pt.lon;
      interpolated = true;
    }

    const paceSecPerKm = record.speedMps ? Math.round(1000 / record.speedMps) : null;
    const remainingMeters = Math.max(0, this.route.totalMeters - estimatedDistanceMeters);
    const etaSeconds =
      record.speedMps && remainingMeters > 0 ? Math.round(remainingMeters / record.speedMps) : null;

    return {
      runnerId: record.runnerId,
      name: record.name,
      bib: record.bib,
      color: record.color,
      hasLocation: true,
      source: record.source,
      rawLat: record.rawLat,
      rawLon: record.rawLon,
      accuracyMeters: record.accuracyMeters,
      snappedLat: record.snappedLat,
      snappedLon: record.snappedLon,
      displayLat,
      displayLon,
      interpolated,
      onCourse: record.onCourse,
      crossTrackMeters: record.crossTrackMeters,
      distanceKm: Number((estimatedDistanceMeters / 1000).toFixed(2)),
      lastVerifiedKm: Number((record.distanceMeters / 1000).toFixed(2)),
      progressPct: Number(
        Math.min(100, (estimatedDistanceMeters / this.route.totalMeters) * 100).toFixed(1)
      ),
      speedMps: record.speedMps ? Number(record.speedMps.toFixed(2)) : null,
      paceSecPerKm,
      etaSeconds,
      lastPingAt: record.lastPingAt,
      ageSeconds: Math.round(ageSeconds),
    };
  }

  getSnapshot(nowMs = Date.now()) {
    const runners = [];
    for (const record of this.runners.values()) {
      runners.push(this._toPublicView(record, nowMs));
    }
    runners.sort((a, b) => {
      const aHas = a.hasLocation !== false;
      const bHas = b.hasLocation !== false;
      if (aHas !== bHas) return aHas ? -1 : 1;
      if (aHas && bHas) return b.distanceKm - a.distanceKm;
      return a.name.localeCompare(b.name);
    });
    return {
      serverTime: nowMs,
      route: {
        name: this.route.name,
        city: this.route.city,
        totalKm: Number((this.route.totalMeters / 1000).toFixed(2)),
      },
      runners,
    };
  }
}
