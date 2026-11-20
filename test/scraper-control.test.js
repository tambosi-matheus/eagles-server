import test from 'node:test';
import assert from 'node:assert/strict';
import { ScraperController } from '../src/scraper-control.js';

test('ScraperController starts idle and broadcasts start/stop commands with device selection', () => {
  const ctrl = new ScraperController();
  assert.deepEqual(ctrl.getStatus(), {
    active: false,
    devices: [],
    knownDevices: [],
    scraperConnected: false,
    connectedScrapers: 0,
    updatedAt: null,
  });

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
