import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSecurityHeaders,
  computeAppSignature,
  createRateLimiter,
  createSessionToken,
  timingSafeEqualStr,
  verifyAppRequest,
  verifySessionToken,
} from '../src/security.js';

test('timingSafeEqualStr compares strings in constant time', () => {
  assert.equal(timingSafeEqualStr('secret-123', 'secret-123'), true);
  assert.equal(timingSafeEqualStr('secret-123', 'secret-124'), false);
  assert.equal(timingSafeEqualStr('short', 'much-longer-string'), false);
  assert.equal(timingSafeEqualStr('', ''), false);
});

test('verifyAppRequest validates Bearer token, HMAC-SHA256 signature, and replay window', () => {
  const token = 'app-secret-token-xyz';
  const now = 1_700_000_000_000;
  const ts = String(now);
  const sig = computeAppSignature(token, 'GET', '/api/state', ts);

  const validReq = {
    method: 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      'x-app-timestamp': ts,
      'x-app-signature': sig,
    },
  };
  assert.equal(verifyAppRequest(validReq, '/api/state', { appToken: token, nowMs: now }).ok, true);

  // Wrong path fails signature check
  assert.equal(verifyAppRequest(validReq, '/api/route', { appToken: token, nowMs: now }).ok, false);

  // Expired timestamp (>5 min) fails replay protection
  assert.equal(
    verifyAppRequest(validReq, '/api/state', { appToken: token, nowMs: now + 6 * 60_000 }).ok,
    false
  );

  // Wrong token fails
  const badTokenReq = {
    method: 'GET',
    headers: {
      authorization: 'Bearer wrong-token',
      'x-app-timestamp': ts,
      'x-app-signature': sig,
    },
  };
  assert.equal(verifyAppRequest(badTokenReq, '/api/state', { appToken: token, nowMs: now }).ok, false);
});

test('session tokens sign, verify, reject tampering, and expire', () => {
  const secret = 'session-secret-key';
  const now = 1_700_000_000_000;
  const token = createSessionToken(secret, { ttlMs: 60_000, nowMs: now });

  assert.equal(verifySessionToken(token, secret, { nowMs: now + 10_000 }), true);
  assert.equal(verifySessionToken(token, secret, { nowMs: now + 61_000 }), false);
  assert.equal(verifySessionToken(`${token}tampered`, secret, { nowMs: now }), false);
  assert.equal(verifySessionToken(token, 'other-secret', { nowMs: now }), false);
});

test('rate limiter enforces max requests per window and resets', () => {
  const check = createRateLimiter({ windowMs: 10_000, max: 2 });
  const t0 = 1_700_000_000_000;

  assert.equal(check('1.2.3.4', t0).allowed, true);
  assert.equal(check('1.2.3.4', t0 + 1000).allowed, true);
  const blocked = check('1.2.3.4', t0 + 2000);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSeconds >= 1);

  // Different IP is unaffected
  assert.equal(check('5.6.7.8', t0 + 2000).allowed, true);

  // Resets after window expires
  assert.equal(check('1.2.3.4', t0 + 11_000).allowed, true);
});

test('buildSecurityHeaders restricts CORS to allowed origins and adds security headers', () => {
  const allowed = ['https://eaglesrunclub.com'];

  const okHeaders = buildSecurityHeaders(
    { headers: { origin: 'https://eaglesrunclub.com', 'x-forwarded-proto': 'https' } },
    allowed
  );
  assert.equal(okHeaders['Access-Control-Allow-Origin'], 'https://eaglesrunclub.com');
  assert.equal(okHeaders['X-Content-Type-Options'], 'nosniff');
  assert.ok(okHeaders['Strict-Transport-Security']);

  const badHeaders = buildSecurityHeaders(
    { headers: { origin: 'https://evil.example.com' } },
    allowed
  );
  assert.equal(badHeaders['Access-Control-Allow-Origin'], undefined);
});
