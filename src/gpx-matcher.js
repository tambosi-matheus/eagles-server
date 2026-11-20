import fs from 'node:fs';

const EARTH_RADIUS_M = 6371000;

export function toRad(deg) {
  return (deg * Math.PI) / 180;
}

/**
 * Great-circle distance in meters between two WGS84 points.
 */
export function haversineMeters(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Parse a standard GPX file (<trkpt> or <rtept>) into [[lat, lon], ...].
 */
export function parseGpx(xmlText) {
  const points = [];
  const tagRegex = /<(?:trkpt|rtept)\b([^>]*)>/gi;
  let match;
  while ((match = tagRegex.exec(xmlText)) !== null) {
    const attrs = match[1];
    const latMatch = attrs.match(/\blat="([^"]+)"/i);
    const lonMatch = attrs.match(/\blon="([^"]+)"/i);
    if (!latMatch || !lonMatch) continue;
    const lat = Number.parseFloat(latMatch[1]);
    const lon = Number.parseFloat(lonMatch[1]);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      points.push([lat, lon]);
    }
  }
  return points;
}

/**
 * Load route from either a .gpx file or a .json file ({ name, points: [[lat, lon], ...] }).
 */
export function loadRoute(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  if (filePath.toLowerCase().endsWith('.gpx')) {
    const points = parseGpx(raw);
    if (points.length < 2) {
      throw new Error(`GPX file ${filePath} has fewer than 2 track points.`);
    }
    return buildRouteModel({ name: 'Custom GPX Route', city: '', points });
  }
  const parsed = JSON.parse(raw);
  return buildRouteModel(parsed);
}

/**
 * Precompute cumulative distances along the polyline for fast O(N) snapping and interpolation.
 */
export function buildRouteModel({ name, city = '', points }) {
  if (!Array.isArray(points) || points.length < 2) {
    throw new Error('Route must contain at least 2 [lat, lon] points.');
  }

  const cumulativeMeters = [0];
  for (let i = 1; i < points.length; i++) {
    const [lat1, lon1] = points[i - 1];
    const [lat2, lon2] = points[i];
    cumulativeMeters.push(cumulativeMeters[i - 1] + haversineMeters(lat1, lon1, lat2, lon2));
  }

  return {
    name: name || 'Marathon Route',
    city,
    points,
    cumulativeMeters,
    totalMeters: cumulativeMeters[cumulativeMeters.length - 1],
  };
}

/**
 * Project a point (lat, lon) onto segment AB in local equirectangular tangent space.
 * Returns { lat, lon, t (0..1), crossTrackMeters }.
 */
function projectOntoSegment(lat, lon, aLat, aLon, bLat, bLon) {
  const meanLatRad = toRad((aLat + bLat) / 2);
  const cosLat = Math.cos(meanLatRad);

  const ax = 0;
  const ay = 0;
  const bx = (bLon - aLon) * cosLat;
  const by = bLat - aLat;
  const px = (lon - aLon) * cosLat;
  const py = lat - aLat;

  const segLenSq = bx * bx + by * by;
  let t = 0;
  if (segLenSq > 0) {
    t = Math.max(0, Math.min(1, ((px - ax) * bx + (py - ay) * by) / segLenSq));
  }

  const projLat = aLat + t * (bLat - aLat);
  const projLon = aLon + t * (bLon - aLon);
  const crossTrackMeters = haversineMeters(lat, lon, projLat, projLon);

  return { lat: projLat, lon: projLon, t, crossTrackMeters };
}

/**
 * Snap a raw (lat, lon) GPS coordinate onto the marathon route.
 *
 * Uses a forward search window around `lastDistanceMeters` when available so
 * loops and out-and-back overlapping segments don't jump the runner backward.
 */
export function snapToRoute(
  route,
  lat,
  lon,
  {
    lastDistanceMeters = null,
    elapsedSeconds = null,
    maxSnapDistanceMeters = 250,
    maxSpeedMps = 7.5, // ~27 km/h generous upper bound for marathon runners
  } = {}
) {
  let minWindow = 0;
  let maxWindow = route.totalMeters;

  if (lastDistanceMeters !== null && elapsedSeconds !== null && elapsedSeconds >= 0) {
    // Allow small backward tolerance (120m) for GPS jitter and generous forward window.
    minWindow = Math.max(0, lastDistanceMeters - 120);
    maxWindow = Math.min(
      route.totalMeters,
      lastDistanceMeters + Math.max(400, elapsedSeconds * maxSpeedMps + 250)
    );
  }

  let best = null;

  for (let i = 0; i < route.points.length - 1; i++) {
    const segStartM = route.cumulativeMeters[i];
    const segEndM = route.cumulativeMeters[i + 1];

    // Skip segments completely outside the forward search window
    if (segEndM < minWindow || segStartM > maxWindow) {
      continue;
    }

    const [aLat, aLon] = route.points[i];
    const [bLat, bLon] = route.points[i + 1];
    const proj = projectOntoSegment(lat, lon, aLat, aLon, bLat, bLon);
    const distanceAlongRoute = segStartM + proj.t * (segEndM - segStartM);

    if (distanceAlongRoute < minWindow || distanceAlongRoute > maxWindow) {
      continue;
    }

    if (!best || proj.crossTrackMeters < best.crossTrackMeters) {
      best = {
        lat: proj.lat,
        lon: proj.lon,
        distanceMeters: distanceAlongRoute,
        crossTrackMeters: proj.crossTrackMeters,
        onCourse: proj.crossTrackMeters <= maxSnapDistanceMeters,
      };
    }
  }

  // If the windowed search didn't find an on-course match, fall back to full route search
  if (!best && lastDistanceMeters !== null) {
    return snapToRoute(route, lat, lon, {
      lastDistanceMeters: null,
      elapsedSeconds: null,
      maxSnapDistanceMeters,
    });
  }

  if (!best) {
    return {
      lat,
      lon,
      distanceMeters: lastDistanceMeters ?? 0,
      crossTrackMeters: Infinity,
      onCourse: false,
    };
  }

  return best;
}

/**
 * Given a distance in meters along the route, return the exact [lat, lon] coordinate.
 */
export function pointAtDistance(route, distanceMeters) {
  const clamped = Math.max(0, Math.min(route.totalMeters, distanceMeters));
  const cum = route.cumulativeMeters;

  // Binary search for segment containing clamped distance
  let lo = 0;
  let hi = cum.length - 2;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= clamped && clamped <= cum[mid + 1]) {
      const segLen = cum[mid + 1] - cum[mid];
      const t = segLen > 0 ? (clamped - cum[mid]) / segLen : 0;
      const [aLat, aLon] = route.points[mid];
      const [bLat, bLon] = route.points[mid + 1];
      return {
        lat: aLat + t * (bLat - aLat),
        lon: aLon + t * (bLon - aLon),
        distanceMeters: clamped,
      };
    }
    if (cum[mid] < clamped) {
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  const last = route.points[route.points.length - 1];
  return { lat: last[0], lon: last[1], distanceMeters: route.totalMeters };
}
