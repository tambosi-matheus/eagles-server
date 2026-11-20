import fs from 'node:fs';

const EARTH_RADIUS_M = 6371000;

export function toRad(deg) {
  return (deg * Math.PI) / 180;
}

export function toDeg(rad) {
  return (rad * 180) / Math.PI;
}

/**
 * Initial compass bearing in degrees [0, 360) from point 1 to point 2.
 */
export function bearingDegrees(lat1, lon1, lat2, lon2) {
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/**
 * Smallest unsigned angle difference in degrees [0, 180].
 */
export function angularDiffDegrees(a, b) {
  const diff = Math.abs(((a - b + 540) % 360) - 180);
  return diff;
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
  const segmentBearings = [];
  for (let i = 1; i < points.length; i++) {
    const [lat1, lon1] = points[i - 1];
    const [lat2, lon2] = points[i];
    cumulativeMeters.push(cumulativeMeters[i - 1] + haversineMeters(lat1, lon1, lat2, lon2));
    segmentBearings.push(bearingDegrees(lat1, lon1, lat2, lon2));
  }

  return {
    name: name || 'Marathon Route',
    city,
    points,
    cumulativeMeters,
    segmentBearings,
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
 * Find distinct candidate projections along the route for a raw GPS point.
 * Adjacent segments within `clusterMeters` are collapsed to their best projection
 * while overlapping legs (e.g. out-and-back at 2km and 8km) are kept separate.
 */
export function findRouteCandidates(
  route,
  lat,
  lon,
  { maxSnapDistanceMeters = 250, clusterMeters = 45 } = {}
) {
  const raw = [];
  let closestOverall = null;

  for (let i = 0; i < route.points.length - 1; i++) {
    const segStartM = route.cumulativeMeters[i];
    const segEndM = route.cumulativeMeters[i + 1];
    const [aLat, aLon] = route.points[i];
    const [bLat, bLon] = route.points[i + 1];
    const proj = projectOntoSegment(lat, lon, aLat, aLon, bLat, bLon);
    const distanceMeters = segStartM + proj.t * (segEndM - segStartM);
    const bearing =
      route.segmentBearings?.[i] ?? bearingDegrees(aLat, aLon, bLat, bLon);

    const cand = {
      lat: proj.lat,
      lon: proj.lon,
      distanceMeters,
      crossTrackMeters: proj.crossTrackMeters,
      onCourse: proj.crossTrackMeters <= maxSnapDistanceMeters,
      bearing,
    };

    if (!closestOverall || cand.crossTrackMeters < closestOverall.crossTrackMeters) {
      closestOverall = cand;
    }
    if (cand.onCourse) {
      raw.push(cand);
    }
  }

  if (raw.length === 0) {
    return closestOverall ? [closestOverall] : [];
  }

  // Collapse consecutive nearby projections along the same pass into the closest one
  raw.sort((a, b) => a.distanceMeters - b.distanceMeters);
  const clusters = [];
  for (const cand of raw) {
    const prev = clusters[clusters.length - 1];
    if (
      prev &&
      cand.distanceMeters - prev.distanceMeters <= clusterMeters &&
      angularDiffDegrees(cand.bearing, prev.bearing) < 60
    ) {
      if (cand.crossTrackMeters < prev.crossTrackMeters) {
        clusters[clusters.length - 1] = cand;
      }
    } else {
      clusters.push(cand);
    }
  }

  return clusters;
}

/**
 * Snap a raw (lat, lon) GPS coordinate onto the marathon route using an online
 * HMM / Viterbi scorer that combines:
 *  1. Spatial cross-track emission probability
 *  2. GPS movement heading vs. directed route segment bearing (disambiguates out-and-back streets)
 *  3. Velocity-predicted distance along the route + physical max-speed bounds
 *  4. Newson-Krumm route-delta vs. haversine-move consistency
 *  5. Elapsed time since "route started" (prevents first-ping jumps onto return legs)
 */
export function snapToRoute(
  route,
  lat,
  lon,
  {
    lastDistanceMeters = null,
    elapsedSeconds = null,
    prevRawLat = null,
    prevRawLon = null,
    expectedSpeedMps = null,
    elapsedSinceRouteStartSeconds = null,
    viterbiStates = null,
    maxSnapDistanceMeters = 250,
    maxSpeedMps = 7.0, // ~25.2 km/h generous upper bound for runners
  } = {}
) {
  const candidates = findRouteCandidates(route, lat, lon, { maxSnapDistanceMeters });
  if (candidates.length === 0) {
    return {
      lat,
      lon,
      distanceMeters: lastDistanceMeters ?? 0,
      crossTrackMeters: Infinity,
      onCourse: false,
      bearing: null,
      viterbiStates: viterbiStates || [],
    };
  }

  const hasPrevRaw = Number.isFinite(prevRawLat) && Number.isFinite(prevRawLon);
  const rawMoveMeters = hasPrevRaw ? haversineMeters(prevRawLat, prevRawLon, lat, lon) : null;
  const gpsBearing =
    hasPrevRaw && rawMoveMeters >= 25 ? bearingDegrees(prevRawLat, prevRawLon, lat, lon) : null;

  // Build prior states from Viterbi trellis, or seed from lastDistanceMeters
  let priorStates = Array.isArray(viterbiStates) && viterbiStates.length > 0 ? viterbiStates : null;
  if (!priorStates && lastDistanceMeters !== null) {
    priorStates = [{ distanceMeters: lastDistanceMeters, logProb: 0 }];
  }

  const SIGMA_Z = 35; // GPS cross-track noise std dev (meters)
  const NK_BETA = 120; // Newson-Krumm exponential scale (meters)
  const vExp =
    Number.isFinite(expectedSpeedMps) && expectedSpeedMps > 0.4 ? expectedSpeedMps : 3.0;

  const scored = candidates.map((cand) => {
    // 1. Spatial cross-track emission
    let emission = -((cand.crossTrackMeters * cand.crossTrackMeters) / (2 * SIGMA_Z * SIGMA_Z));
    emission = Math.max(-20, emission);

    // 2. Heading alignment emission (critical for overlapping out-and-back streets)
    if (gpsBearing !== null && Number.isFinite(cand.bearing)) {
      const angleDiff = angularDiffDegrees(gpsBearing, cand.bearing);
      emission -= 4.5 * (1 - Math.cos(toRad(angleDiff)));
    }

    // 3. Route-started time-from-zero physical bound
    if (
      elapsedSinceRouteStartSeconds !== null &&
      Number.isFinite(elapsedSinceRouteStartSeconds) &&
      elapsedSinceRouteStartSeconds >= 0
    ) {
      const maxFromStart = Math.max(400, elapsedSinceRouteStartSeconds * maxSpeedMps + 250);
      if (cand.distanceMeters > maxFromStart) {
        emission -= 25 + (cand.distanceMeters - maxFromStart) / 50;
      } else if (!priorStates) {
        // On first ping after route start, gently prefer distance consistent with elapsed time
        const expectedFromStart = elapsedSinceRouteStartSeconds * vExp;
        const sigmaStart = Math.max(300, 2.2 * elapsedSinceRouteStartSeconds);
        const startPenalty = Math.min(
          8,
          ((cand.distanceMeters - expectedFromStart) ** 2) / (2 * sigmaStart * sigmaStart)
        );
        emission -= startPenalty;
      }
    }

    // 4. Viterbi transition from previous states
    let bestTransition = 0;
    if (priorStates && elapsedSeconds !== null && Number.isFinite(elapsedSeconds) && elapsedSeconds >= 0) {
      bestTransition = -Infinity;
      const maxReach = Math.max(350, elapsedSeconds * maxSpeedMps + 200);
      const sigmaV = Math.max(120, 0.9 * elapsedSeconds);

      for (const prev of priorStates) {
        const deltaRoute = cand.distanceMeters - prev.distanceMeters;
        let trans = prev.logProb;

        // Backward jump penalty
        if (deltaRoute < -120) {
          trans -= 30 + Math.abs(deltaRoute) / 40;
        } else if (deltaRoute < 0) {
          trans -= Math.abs(deltaRoute) / 60;
        }

        // Physical max-speed forward bound
        if (deltaRoute > maxReach) {
          trans -= 30 + (deltaRoute - maxReach) / 50;
        }

        // Velocity-predicted position along route
        const predicted = prev.distanceMeters + vExp * elapsedSeconds;
        const velPenalty = Math.min(
          12,
          ((cand.distanceMeters - predicted) ** 2) / (2 * sigmaV * sigmaV)
        );
        trans -= velPenalty;

        // Turnaround-safe geometric consistency: compare observed straight-line GPS move
        // against the route's own straight-line chord between prev and cand (handles U-turns cleanly)
        if (rawMoveMeters !== null) {
          const prevPt = pointAtDistance(route, prev.distanceMeters);
          const expectedChordMeters = haversineMeters(prevPt.lat, prevPt.lon, cand.lat, cand.lon);
          const chordPenalty = Math.min(8, Math.abs(expectedChordMeters - rawMoveMeters) / NK_BETA);
          trans -= chordPenalty;
        }

        if (trans > bestTransition) {
          bestTransition = trans;
        }
      }
    } else if (priorStates) {
      // No elapsed time known: prefer continuity near prior states
      bestTransition = -Infinity;
      for (const prev of priorStates) {
        const deltaRoute = cand.distanceMeters - prev.distanceMeters;
        const penalty = deltaRoute < -120 ? 30 + Math.abs(deltaRoute) / 40 : Math.abs(deltaRoute) / 200;
        const trans = prev.logProb - penalty;
        if (trans > bestTransition) bestTransition = trans;
      }
    }

    return {
      ...cand,
      logProb: bestTransition + emission,
    };
  });

  scored.sort((a, b) => b.logProb - a.logProb);
  const best = scored[0];

  // Normalize top K=6 Viterbi states to prevent numeric underflow
  const topStates = scored.slice(0, 6).map((s) => ({
    distanceMeters: s.distanceMeters,
    logProb: Math.max(-50, s.logProb - best.logProb),
    bearing: s.bearing,
  }));

  return {
    lat: best.lat,
    lon: best.lon,
    distanceMeters: best.distanceMeters,
    crossTrackMeters: best.crossTrackMeters,
    onCourse: best.onCourse,
    bearing: best.bearing,
    viterbiStates: topStates,
  };
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
