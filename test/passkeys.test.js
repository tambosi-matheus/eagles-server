import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PasskeyManager } from '../src/passkeys.js';

function makeTempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eagles-passkeys-'));
  return path.join(dir, 'passkeys.json');
}

const mockReq = {
  headers: {
    host: 'eagles.boomhut.dev',
    'x-forwarded-proto': 'https',
  },
};

test('PasskeyManager resolves rpID and expectedOrigin from reverse proxy headers', () => {
  const pm = new PasskeyManager({ storeFile: makeTempStore() });
  const ctx = pm.resolveRpContext(mockReq);
  assert.equal(ctx.rpID, 'eagles.boomhut.dev');
  assert.equal(ctx.origin, 'https://eagles.boomhut.dev');
  assert.deepEqual(ctx.expectedOrigin, ['https://eagles.boomhut.dev']);
});

test('PasskeyManager generates platform biometric registration options and consumes challenge once', async () => {
  const pm = new PasskeyManager({ storeFile: makeTempStore() });
  const { challengeId, options } = await pm.createRegistrationOptions(mockReq);

  assert.ok(challengeId.length >= 20);
  assert.equal(options.rp.id, 'eagles.boomhut.dev');
  assert.equal(options.authenticatorSelection.authenticatorAttachment, 'platform');
  assert.equal(options.authenticatorSelection.userVerification, 'required');

  // Consuming an invalid/missing challenge rejects
  await assert.rejects(
    () => pm.verifyRegistration(mockReq, { challengeId: 'invalid', response: {} }),
    /expired/i
  );
});

test('PasskeyManager rejects authentication options when no passkeys are registered', async () => {
  const pm = new PasskeyManager({ storeFile: makeTempStore() });
  assert.equal(pm.hasPasskeys(), false);
  await assert.rejects(() => pm.createAuthenticationOptions(mockReq), /No passkeys registered/i);
});
