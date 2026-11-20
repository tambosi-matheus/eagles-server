import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MapManager } from '../src/maps.js';
import { RunnerStore } from '../src/store.js';

const DEFAULT_ROUTE_FILE = path.resolve(process.cwd(), 'data/curitiba-route.json');

const SAMPLE_5K_GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1">
  <trk>
    <name>Curitiba 5K</name>
    <trkseg>
      <trkpt lat="-25.4284" lon="-49.2733"></trkpt>
      <trkpt lat="-25.4284" lon="-49.2533"></trkpt>
      <trkpt lat="-25.4184" lon="-49.2533"></trkpt>
    </trkseg>
  </trk>
</gpx>`;

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'eagles-maps-'));
}

test('MapManager seeds default route, supports multiple open maps, and assigns devices to different distances', () => {
  const dir = makeTempDir();
  const manager = new MapManager({ mapsDir: dir, defaultRouteFile: DEFAULT_ROUTE_FILE });

  assert.equal(manager.getOpenMaps().length, 1);
  const primaryBefore = manager.getPrimaryMap();

  // Add a 5k GPX map as an additional open map
  const map5k = manager.addMap({
    name: 'Curitiba 5K',
    distanceLabel: '5k',
    color: '#22c55e',
    gpx: SAMPLE_5K_GPX,
    open: true,
    setPrimary: false,
  });

  assert.equal(manager.getOpenMaps().length, 2);
  assert.equal(manager.getPrimaryMap().id, primaryBefore.id);

  // Assign runner-5k to the 5k map while runner-21k stays on default
  manager.assignDevice('runner-5k', map5k.id);
  assert.equal(manager.getRouteForRunner('runner-5k').id, map5k.id);
  assert.equal(manager.getRouteForRunner('runner-21k').id, primaryBefore.id);

  // RunnerStore snaps each runner against their own assigned map
  const store = new RunnerStore(manager);
  const view5k = store.ingestPing({
    runnerId: 'runner-5k',
    name: 'Ana',
    lat: -25.4284,
    lon: -49.2633,
  });
  assert.equal(view5k.mapId, map5k.id);
  assert.equal(view5k.mapDistanceLabel, '5k');

  // Verify persistence across reload
  const reloaded = new MapManager({ mapsDir: dir, defaultRouteFile: DEFAULT_ROUTE_FILE });
  assert.equal(reloaded.getOpenMaps().length, 2);
  assert.equal(reloaded.getRouteForRunner('runner-5k').id, map5k.id);

  // Cannot close the last open map
  reloaded.setMapOpen(primaryBefore.id, false);
  assert.equal(reloaded.getPrimaryMap().id, map5k.id);
  assert.throws(() => reloaded.setMapOpen(map5k.id, false), /At least one map must remain open/i);
});
