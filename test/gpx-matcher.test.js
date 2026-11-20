import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRouteModel, loadRoute, parseGpx, pointAtDistance, snapToRoute } from '../src/gpx-matcher.js';
import { RunnerStore } from '../src/store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('snapToRoute projects noisy GPS point onto route and estimates distance', () => {
  const route = loadRoute(path.resolve(__dirname, '../data/curitiba-route.json'));
  // Take midpoint at 2,500m and add ~30m of GPS noise
  const truth = pointAtDistance(route, 2500);
  const noisyLat = truth.lat + 0.00025;
  const noisyLon = truth.lon - 0.0002;

  const snapped = snapToRoute(route, noisyLat, noisyLon);
  assert.equal(snapped.onCourse, true);
  assert.ok(snapped.crossTrackMeters < 60, `Expected <60m cross-track, got ${snapped.crossTrackMeters}`);
  assert.ok(
    Math.abs(snapped.distanceMeters - 2500) < 80,
    `Expected snapped distance near 2500m, got ${snapped.distanceMeters}`
  );
});

test('snapToRoute forward search window prevents jumping across an out-and-back loop', () => {
  // Out-and-back route: (0,0) -> (0,0.02) -> (0,0)
  const route = buildRouteModel({
    name: 'Out and Back',
    points: [
      [0, 0],
      [0, 0.02],
      [0, 0],
    ],
  });

  // Runner is on the return leg (around 3500m), near (0, 0.008)
  const returnPt = pointAtDistance(route, 3500);
  const snapped = snapToRoute(route, returnPt.lat + 0.0001, returnPt.lon, {
    lastDistanceMeters: 3300,
    elapsedSeconds: 60,
  });

  assert.ok(
    snapped.distanceMeters > 3300,
    `Should stay on return leg (>3300m), got ${snapped.distanceMeters}`
  );
});

test('parseGpx extracts track points from GPX XML', () => {
  const xml = `<?xml version="1.0"?>
    <gpx><trk><trkseg>
      <trkpt lat="-25.4172" lon="-49.2673"></trkpt>
      <trkpt lat="-25.4215" lon="-49.2675"></trkpt>
    </trkseg></trk></gpx>`;
  const pts = parseGpx(xml);
  assert.equal(pts.length, 2);
  assert.deepEqual(pts[0], [-25.4172, -49.2673]);
});

test('RunnerStore computes rolling pace and interpolates between delayed tag pings', () => {
  const route = loadRoute(path.resolve(__dirname, '../data/curitiba-route.json'));
  const store = new RunnerStore(route);

  const p1 = pointAtDistance(route, 1000);
  const p2 = pointAtDistance(route, 1300);
  const t0 = 1_700_000_000_000;

  store.ingestPing({ runnerId: 'r1', name: 'Ana', lat: p1.lat, lon: p1.lon, timestamp: t0 });
  store.ingestPing({
    runnerId: 'r1',
    name: 'Ana',
    lat: p2.lat,
    lon: p2.lon,
    timestamp: t0 + 100_000, // 300m in 100s = 3.0 m/s (5:33 min/km)
  });

  // 50 seconds after last ping -> should interpolate ~150m further (around 1.45 km)
  const snap = store.getSnapshot(t0 + 150_000);
  assert.equal(snap.runners.length, 1);
  assert.equal(snap.runners[0].interpolated, true);
  assert.ok(snap.runners[0].distanceKm >= 1.4 && snap.runners[0].distanceKm <= 1.5);
  assert.ok(snap.runners[0].paceSecPerKm >= 325 && snap.runners[0].paceSecPerKm <= 345);
});

test('10K out-and-back overlapping street: Begin Tracking + HMM/Viterbi + heading + velocity tracks 0->5k->10k accurately', () => {
  // Exact 10 km out-and-back on the exact same North-South street:
  // 0 km at (0, 0) -> 5 km North at (~0.044966, 0) -> 10 km back at (0, 0)
  const route = buildRouteModel({
    name: '10K Out-and-Back',
    points: [
      [0, 0],
      [0.015, 0],
      [0.030, 0],
      [0.044966, 0], // ~5.0 km turnaround
      [0.030, 0],
      [0.015, 0],
      [0, 0], // ~10.0 km finish
    ],
  });

  const store = new RunnerStore(route);
  const t0 = 1_700_000_000_000;
  store.syncActiveDevices([{ runnerId: 'r1', name: 'Matheus', bib: '101', color: '#38bdf8' }]);
  store.startRouteTracking(t0);

  // Runner runs at 3.33 m/s (5:00/km = 300s per km)
  const paceSecPerKm = 300;
  const trueDistancesKm = [0.6, 1.8, 3.2, 4.6, 5.4, 6.8, 8.2, 9.4];

  for (const km of trueDistancesKm) {
    const pt = pointAtDistance(route, km * 1000);
    const ts = t0 + km * paceSecPerKm * 1000;
    const view = store.ingestPing({
      runnerId: 'r1',
      name: 'Matheus',
      lat: pt.lat,
      lon: pt.lon + 0.00005, // ~5m GPS noise
      timestamp: ts,
    });
    assert.ok(
      Math.abs(view.lastVerifiedKm - km) < 0.25,
      `At true ${km} km, expected snapped near ${km} km, got ${view.lastVerifiedKm} km`
    );
  }

  const finalSnap = store.getSnapshot(t0 + 9.4 * paceSecPerKm * 1000);
  assert.equal(finalSnap.routeSession.started, true);
  assert.ok(finalSnap.runners[0].traveledKm >= 9.2 && finalSnap.runners[0].traveledKm <= 9.6);
});
