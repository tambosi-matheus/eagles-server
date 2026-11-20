import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { buildRouteModel, loadRoute, parseGpx } from './gpx-matcher.js';

const MAP_COLORS = ['#ff4d00', '#38bdf8', '#22c55e', '#a855f7', '#eab308', '#f43f5e'];

function slugify(text) {
  return (
    String(text || 'map')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'map'
  );
}

function normalizePointsFromJson(parsed) {
  // GeoJSON FeatureCollection / Feature / LineString
  if (parsed?.type === 'FeatureCollection' && Array.isArray(parsed.features)) {
    for (const f of parsed.features) {
      const pts = normalizePointsFromJson(f);
      if (pts.length >= 2) return pts;
    }
  }
  if (parsed?.type === 'Feature' && parsed.geometry) {
    return normalizePointsFromJson(parsed.geometry);
  }
  if (parsed?.type === 'LineString' && Array.isArray(parsed.coordinates)) {
    return parsed.coordinates
      .map((c) => [Number(c[1]), Number(c[0])])
      .filter(([lat, lon]) => Number.isFinite(lat) && Number.isFinite(lon));
  }
  if (Array.isArray(parsed?.points)) {
    return parsed.points
      .map((p) => (Array.isArray(p) ? [Number(p[0]), Number(p[1])] : [Number(p?.lat), Number(p?.lon)]))
      .filter(([lat, lon]) => Number.isFinite(lat) && Number.isFinite(lon));
  }
  if (Array.isArray(parsed)) {
    return parsed
      .map((p) => (Array.isArray(p) ? [Number(p[0]), Number(p[1])] : [Number(p?.lat), Number(p?.lon)]))
      .filter(([lat, lon]) => Number.isFinite(lat) && Number.isFinite(lon));
  }
  return [];
}

export class MapManager {
  constructor({ mapsDir, defaultRouteFile }) {
    this.mapsDir = mapsDir;
    this.registryFile = mapsDir ? path.join(mapsDir, 'registry.json') : null;
    this.maps = new Map(); // id -> full map object with route model
    this.primaryMapId = null;
    this.deviceMaps = new Map(); // runnerId -> mapId

    this._loadOrSeed(defaultRouteFile);
  }

  _loadOrSeed(defaultRouteFile) {
    if (this.registryFile && fs.existsSync(this.registryFile)) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.registryFile, 'utf8'));
        for (const item of raw.maps || []) {
          if (!item?.id || !Array.isArray(item.points) || item.points.length < 2) continue;
          const model = buildRouteModel({
            name: item.name,
            city: item.city || '',
            points: item.points,
          });
          this.maps.set(item.id, {
            id: item.id,
            name: model.name,
            distanceLabel: item.distanceLabel || `${(model.totalMeters / 1000).toFixed(1)}k`,
            city: model.city,
            color: item.color || MAP_COLORS[this.maps.size % MAP_COLORS.length],
            open: Boolean(item.open),
            createdAt: item.createdAt || new Date().toISOString(),
            ...model,
          });
        }
        if (raw.primaryMapId && this.maps.has(raw.primaryMapId)) {
          this.primaryMapId = raw.primaryMapId;
        }
        for (const [runnerId, mapId] of Object.entries(raw.deviceMaps || {})) {
          if (this.maps.has(mapId)) {
            this.deviceMaps.set(runnerId, mapId);
          }
        }
      } catch (err) {
        console.warn(`WARNING: Could not load maps registry: ${err.message}`);
      }
    }

    if (this.maps.size === 0 && defaultRouteFile) {
      const seeded = loadRoute(defaultRouteFile);
      const id = 'default-route';
      const totalKm = (seeded.totalMeters / 1000).toFixed(1);
      this.maps.set(id, {
        id,
        name: seeded.name,
        distanceLabel: `${totalKm}k`,
        city: seeded.city || '',
        color: MAP_COLORS[0],
        open: true,
        createdAt: new Date().toISOString(),
        ...seeded,
      });
      this.primaryMapId = id;
      this._save();
    }

    if (!this.primaryMapId || !this.maps.has(this.primaryMapId)) {
      const first = this.maps.values().next().value;
      if (first) {
        this.primaryMapId = first.id;
        first.open = true;
      }
    }
  }

  _save() {
    if (!this.registryFile) return;
    fs.mkdirSync(this.mapsDir, { recursive: true });
    const payload = {
      version: 1,
      primaryMapId: this.primaryMapId,
      deviceMaps: Object.fromEntries(this.deviceMaps.entries()),
      maps: Array.from(this.maps.values()).map((m) => ({
        id: m.id,
        name: m.name,
        distanceLabel: m.distanceLabel,
        city: m.city,
        color: m.color,
        open: m.open,
        createdAt: m.createdAt,
        points: m.points,
      })),
    };
    const tmp = `${this.registryFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
    fs.renameSync(tmp, this.registryFile);
  }

  _toMeta(m) {
    return {
      id: m.id,
      name: m.name,
      distanceLabel: m.distanceLabel,
      city: m.city,
      color: m.color,
      open: m.open,
      isPrimary: m.id === this.primaryMapId,
      totalMeters: Math.round(m.totalMeters),
      totalKm: Number((m.totalMeters / 1000).toFixed(2)),
      pointCount: m.points.length,
      createdAt: m.createdAt,
    };
  }

  _toGeometry(m) {
    return {
      ...this._toMeta(m),
      points: m.points,
      cumulativeMeters: m.cumulativeMeters.map((v) => Math.round(v)),
    };
  }

  getPrimaryMap() {
    return this.maps.get(this.primaryMapId) || this.maps.values().next().value;
  }

  getOpenMaps() {
    const open = Array.from(this.maps.values()).filter((m) => m.open);
    if (open.length > 0) return open;
    const primary = this.getPrimaryMap();
    return primary ? [primary] : [];
  }

  getRouteForRunner(runnerId) {
    const assignedId = runnerId ? this.deviceMaps.get(runnerId) : null;
    if (assignedId && this.maps.has(assignedId)) {
      return this.maps.get(assignedId);
    }
    return this.getPrimaryMap();
  }

  getPublicRoutePayload() {
    const primary = this.getPrimaryMap();
    return {
      ...this._toGeometry(primary),
      openMaps: this.getOpenMaps().map((m) => this._toGeometry(m)),
    };
  }

  getState() {
    const maps = Array.from(this.maps.values()).map((m) => this._toMeta(m));
    const openMaps = this.getOpenMaps().map((m) => this._toGeometry(m));
    return {
      primaryMapId: this.primaryMapId,
      maps,
      openMaps,
      deviceMaps: Object.fromEntries(this.deviceMaps.entries()),
    };
  }

  addMap({ name, distanceLabel = '', city = '', color = '', gpx = '', json = null, open = true, setPrimary = false }) {
    let points = [];
    let inferredName = '';
    let inferredCity = '';

    if (typeof gpx === 'string' && gpx.trim()) {
      points = parseGpx(gpx);
      const nameMatch = gpx.match(/<name>\s*([^<]+?)\s*<\/name>/i);
      if (nameMatch) inferredName = nameMatch[1].trim();
    } else if (json !== null && json !== undefined) {
      const parsed = typeof json === 'string' ? JSON.parse(json) : json;
      points = normalizePointsFromJson(parsed);
      if (typeof parsed?.name === 'string') inferredName = parsed.name.trim();
      if (typeof parsed?.city === 'string') inferredCity = parsed.city.trim();
    } else {
      throw new Error('Provide either a GPX file or JSON route payload.');
    }

    if (points.length < 2) {
      throw new Error('Route must contain at least 2 valid GPS coordinates.');
    }

    const finalName = String(name || inferredName || 'Custom Route').trim().slice(0, 80);
    const finalCity = String(city || inferredCity || '').trim().slice(0, 60);
    const model = buildRouteModel({ name: finalName, city: finalCity, points });
    const autoDist = `${(model.totalMeters / 1000).toFixed(1)}k`;
    const finalDist = String(distanceLabel || autoDist).trim().slice(0, 20);
    const finalColor =
      /^#[0-9a-f]{6}$/i.test(String(color || '').trim())
        ? String(color).trim()
        : MAP_COLORS[this.maps.size % MAP_COLORS.length];

    const id = `${slugify(finalDist || finalName)}-${crypto.randomBytes(3).toString('hex')}`;
    const record = {
      id,
      name: model.name,
      distanceLabel: finalDist,
      city: model.city,
      color: finalColor,
      open: Boolean(open || setPrimary),
      createdAt: new Date().toISOString(),
      ...model,
    };

    this.maps.set(id, record);
    if (setPrimary) {
      this.primaryMapId = id;
      record.open = true;
    }
    this._save();
    return this._toGeometry(record);
  }

  setPrimaryMap(mapId) {
    if (!this.maps.has(mapId)) {
      throw new Error('Map not found.');
    }
    this.primaryMapId = mapId;
    this.maps.get(mapId).open = true;
    this._save();
    return this.getState();
  }

  setMapOpen(mapId, open) {
    const map = this.maps.get(mapId);
    if (!map) {
      throw new Error('Map not found.');
    }
    if (!open) {
      const otherOpen = Array.from(this.maps.values()).filter((m) => m.id !== mapId && m.open);
      if (otherOpen.length === 0) {
        throw new Error('At least one map must remain open.');
      }
      if (this.primaryMapId === mapId) {
        this.primaryMapId = otherOpen[0].id;
      }
    }
    map.open = Boolean(open);
    this._save();
    return this.getState();
  }

  assignDevice(runnerId, mapId) {
    const id = String(runnerId || '').trim();
    if (!id) throw new Error('Device ID is required.');
    if (!mapId) {
      this.deviceMaps.delete(id);
    } else {
      const target = this.maps.get(mapId);
      if (!target) throw new Error('Map not found.');
      target.open = true;
      this.deviceMaps.set(id, mapId);
    }
    this._save();
    return this.getState();
  }

  deleteMap(mapId) {
    if (!this.maps.has(mapId)) {
      throw new Error('Map not found.');
    }
    if (this.maps.size <= 1) {
      throw new Error('Cannot delete the only remaining map.');
    }
    this.maps.delete(mapId);
    for (const [runnerId, assigned] of this.deviceMaps.entries()) {
      if (assigned === mapId) {
        this.deviceMaps.delete(runnerId);
      }
    }
    if (this.primaryMapId === mapId) {
      const open = Array.from(this.maps.values()).find((m) => m.open) || this.maps.values().next().value;
      this.primaryMapId = open.id;
      open.open = true;
    }
    this._save();
    return this.getState();
  }
}
