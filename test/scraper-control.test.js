import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ScraperController } from '../src/scraper-control.js';
import { loadRoute, pointAtDistance } from '../src/gpx-matcher.js';
import { RunnerStore } from '../src/store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('ScraperController starts idle and broadcasts start/stop commands with device selection', () => {
  const ctrl = new ScraperController();
  assert.deepEqual(ctrl.getStatus(), {
    active: false,
    devices: [],
    knownDevices: [],
    deviceIntervals: {},
    auth: {
      authenticated: null,
      reason: null,
      updatedAt: null,
    },
    scraperConnected: false,
    connectedScrapers: 0,
    updatedAt: null,
  });

  ctrl.setAuthStatus({ authenticated: false, reason: 'Google sign-in required' });
  assert.equal(ctrl.getStatus().auth.authenticated, false);
  assert.equal(ctrl.getStatus().auth.reason, 'Google sign-in required');
  ctrl.setAuthStatus({ authenticated: true });
  assert.equal(ctrl.getStatus().auth.authenticated, true);
  assert.equal(ctrl.getStatus().auth.reason, null);

  ctrl.setKnownDevices([
    { runnerId: 'poco-f5', deviceName: 'POCO F5', name: 'Matheus', bib: '101', color: '#38bdf8' },
  ]);
  assert.equal(ctrl.getStatus().knownDevices.length, 1);
  assert.equal(ctrl.getStatus().knownDevices[0].runnerId, 'poco-f5');

  const received = [];
  const unsubscribe = ctrl.subscribe((event, payload) => {
    received.push({ event, payload });
  });

  assert.equal(ctrl.getStatus().scraperConnected, true);
  assert.equal(ctrl.getStatus().connectedScrapers, 1);

  // Start specific devices
  const startRes = ctrl.handleCommand({ action: 'start', devices: ['poco-f5', 'Tag 2', 'POCO-F5'] });
  assert.equal(startRes.ok, true);
  assert.equal(startRes.action, 'start');
  assert.equal(startRes.active, true);
  assert.deepEqual(startRes.devices, ['poco-f5', 'Tag 2']);
  assert.equal(received.length, 1);
  assert.equal(received[0].event, 'command');
  assert.equal(received[0].payload.action, 'start');
  assert.deepEqual(received[0].payload.devices, ['poco-f5', 'Tag 2']);

  // Stop a single device while another remains active
  const partialStopRes = ctrl.handleCommand({ action: 'stop', devices: ['tag 2'] });
  assert.equal(partialStopRes.active, true);
  assert.deepEqual(partialStopRes.devices, ['poco-f5']);
  assert.equal(received.length, 2);
  assert.equal(received[1].payload.action, 'start');
  assert.deepEqual(received[1].payload.devices, ['poco-f5']);

  // Full stop
  const stopRes = ctrl.handleCommand({ action: 'stop' });
  assert.equal(stopRes.active, false);
  assert.deepEqual(stopRes.devices, []);
  assert.equal(received.length, 3);
  assert.equal(received[2].payload.action, 'stop');
  assert.equal(received[2].payload.active, false);

  unsubscribe();
  assert.equal(ctrl.getStatus().scraperConnected, false);
});

test('ScraperController supports "all" / omitted devices and validates invalid inputs', () => {
  const ctrl = new ScraperController();

  // Omitted devices activates all configured devices (represented as null)
  const resAll = ctrl.handleCommand({ action: 'start' });
  assert.equal(resAll.active, true);
  assert.equal(resAll.devices, null);

  // Comma-separated string devices
  const resCsv = ctrl.handleCommand({ action: 'start', devices: 'poco-f5, moto-tag' });
  assert.deepEqual(resCsv.devices, ['poco-f5', 'moto-tag']);

  // Wildcard "*" activates all
  const resStar = ctrl.handleCommand({ action: 'start', devices: ['*'] });
  assert.equal(resStar.devices, null);

  // Empty array on start is rejected
  assert.throws(() => ctrl.handleCommand({ action: 'start', devices: [] }), /At least one device/);

  // Invalid action is rejected
  assert.throws(() => ctrl.handleCommand({ action: 'pause' }), /Invalid action/);
});

test('RunnerStore shows active devices before first ping and updates once ping arrives', () => {
  const route = loadRoute(path.resolve(__dirname, '../data/curitiba-route.json'));
  const store = new RunnerStore(route);
  const ctrl = new ScraperController();

  ctrl.setKnownDevices([
    { runnerId: 'poco-f5', deviceName: 'POCO F5', name: 'Matheus', bib: '101', color: '#38bdf8' },
  ]);
  ctrl.handleCommand({ action: 'start', devices: ['poco-f5'] });
  store.syncActiveDevices(ctrl.getActiveDevices());

  let snap = store.getSnapshot();
  assert.equal(snap.runners.length, 1);
  assert.equal(snap.runners[0].runnerId, 'poco-f5');
  assert.equal(snap.runners[0].hasLocation, false);
  assert.equal(snap.runners[0].distanceKm, null);

  // Deactivating before any ping removes the waiting entry
  ctrl.handleCommand({ action: 'stop' });
  store.syncActiveDevices(ctrl.getActiveDevices());
  assert.equal(store.getSnapshot().runners.length, 0);

  // Reactivate, then receive a ping
  ctrl.handleCommand({ action: 'start', devices: ['poco-f5'] });
  store.syncActiveDevices(ctrl.getActiveDevices());
  const pt = pointAtDistance(route, 1500);
  store.ingestPing({ runnerId: 'poco-f5', lat: pt.lat, lon: pt.lon, timestamp: 1_700_000_000_000 });

  snap = store.getSnapshot(1_700_000_000_000);
  assert.equal(snap.runners.length, 1);
  assert.equal(snap.runners[0].hasLocation, true);
  assert.equal(snap.runners[0].name, 'Matheus');
  assert.equal(snap.runners[0].bib, '101');
  assert.ok(snap.runners[0].distanceKm >= 1.4 && snap.runners[0].distanceKm <= 1.6);

  // Renaming updates knownDevices, RunnerStore, and survives re-registration
  ctrl.renameDevice('poco-f5', 'Matheus T.');
  store.renameRunner('poco-f5', 'Matheus T.');
  assert.equal(ctrl.getStatus().knownDevices[0].name, 'Matheus T.');
  assert.equal(store.getSnapshot(1_700_000_000_000).runners[0].name, 'Matheus T.');

  ctrl.setKnownDevices([
    { runnerId: 'poco-f5', deviceName: 'POCO F5', name: 'Matheus', bib: '101', color: '#38bdf8' },
  ]);
  assert.equal(ctrl.getStatus().knownDevices[0].name, 'Matheus T.');
  assert.equal(ctrl.getDisplayName('poco-f5', 'Matheus'), 'Matheus T.');

  // Per-device update interval broadcasts and persists across re-registration
  const intervalEvents = [];
  const unsub = ctrl.subscribe((event, payload) => intervalEvents.push({ event, payload }));
  ctrl.setDeviceInterval('poco-f5', 15);
  assert.equal(ctrl.getStatus().deviceIntervals['poco-f5'], 15);
  assert.equal(ctrl.getStatus().knownDevices[0].pollIntervalSeconds, 15);
  assert.equal(intervalEvents.length, 1);
  assert.equal(intervalEvents[0].payload.deviceIntervals['poco-f5'], 15);
  ctrl.setKnownDevices([
    { runnerId: 'poco-f5', deviceName: 'POCO F5', name: 'Matheus', bib: '101', color: '#38bdf8', pollIntervalSeconds: 30 },
  ]);
  assert.equal(ctrl.getStatus().knownDevices[0].pollIntervalSeconds, 15);
  unsub();
});
