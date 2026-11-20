import crypto from 'node:crypto';

const SIGNATURE_MAX_SKEW_MS = 5 * 60 * 1000; // 5 minutes replay protection window
const SESSION_COOKIE_NAME = 'eagles_session';
const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Constant-time string comparison using SHA-256 digests so lengths never leak.
 */
export function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length === 0 || b.length === 0) {
    return false;
  }
  const hashA = crypto.createHash('sha256').update(a).digest();
  const hashB = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

/**
 * Compute HMAC-SHA256 request signature for app-to-app requests.
 * Canonical string: METHOD\nPATHNAME\nTIMESTAMP_MS
 */
export function computeAppSignature(secret, method, pathname, timestamp) {
  const payload = `${String(method || 'GET').toUpperCase()}\n${pathname}\n${timestamp}`;
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * Verify an app-to-app request using:
 * 1. Authorization: Bearer <APP_API_TOKEN>
 * 2. X-App-Timestamp: <epoch_ms> (within ±5 minutes)
 * 3. X-App-Signature: <hex HMAC-SHA256>
 */
export function verifyAppRequest(req, pathname, { appToken, nowMs = Date.now(), maxSkewMs = SIGNATURE_MAX_SKEW_MS } = {}) {
  if (!appToken) {
    return { ok: false, reason: 'App token not configured' };
  }

  const authHeader = String(req.headers.authorization || '');
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!timingSafeEqualStr(bearerToken, appToken)) {
    return { ok: false, reason: 'Invalid app token' };
  }

  const tsRaw = String(req.headers['x-app-timestamp'] || '').trim();
  const sig = String(req.headers['x-app-signature'] || '').trim().toLowerCase();
  const ts = Number(tsRaw);
  if (!tsRaw || !Number.isFinite(ts)) {
    return { ok: false, reason: 'Missing or invalid X-App-Timestamp' };
  }

  if (Math.abs(nowMs - ts) > maxSkewMs) {
    return { ok: false, reason: 'Expired request timestamp' };
  }

  const expectedSig = computeAppSignature(appToken, req.method, pathname, tsRaw);
  if (!timingSafeEqualStr(sig, expectedSig)) {
    return { ok: false, reason: 'Invalid X-App-Signature' };
  }

  return { ok: true };
}

/**
 * Verify X-API-Key header for scraper-to-server requests.
 */
export function verifyApiKey(req, expectedKey) {
  if (!expectedKey) return false;
  const provided = String(req.headers['x-api-key'] || '').trim();
  return timingSafeEqualStr(provided, expectedKey);
}

/**
 * Parse Cookie header into a plain key/value object.
 */
export function parseCookies(cookieHeader) {
  const out = {};
  if (!cookieHeader || typeof cookieHeader !== 'string') return out;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) {
      try {
        out[key] = decodeURIComponent(val);
      } catch {
        out[key] = val;
      }
    }
  }
  return out;
}

/**
 * Create a signed stateless session token for HttpOnly cookies.
 */
export function createSessionToken(secret, { ttlMs = DEFAULT_SESSION_TTL_MS, nowMs = Date.now() } = {}) {
  const payload = Buffer.from(
    JSON.stringify({ iat: nowMs, exp: nowMs + ttlMs }),
    'utf8'
  ).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

/**
 * Verify a signed session token.
 */
export function verifySessionToken(token, secret, { nowMs = Date.now() } = {}) {
  if (!token || !secret || typeof token !== 'string') return false;
  const dot = token.indexOf('.');
  if (dot <= 0) return false;

  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expectedSig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  if (!timingSafeEqualStr(sig, expectedSig)) return false;

  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return Number.isFinite(parsed.exp) && parsed.exp > nowMs;
  } catch {
    return false;
  }
}

export function hasValidSessionCookie(req, secret) {
  if (!secret) return false;
  const cookies = parseCookies(req.headers.cookie);
  return verifySessionToken(cookies[SESSION_COOKIE_NAME], secret);
}

export function buildSessionCookie(token, { secure = true, maxAgeSeconds = DEFAULT_SESSION_TTL_MS / 1000 } = {}) {
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(maxAgeSeconds)}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function buildClearSessionCookie({ secure = true } = {}) {
  const parts = [
    `${SESSION_COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/**
 * Extract client IP safely (supports reverse proxy headers).
 */
export function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) {
    return xff.split(',')[0].trim();
  }
  const realIp = req.headers['x-real-ip'];
  if (typeof realIp === 'string' && realIp.trim()) {
    return realIp.trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}

/**
 * Simple in-memory fixed-window rate limiter per IP.
 */
export function createRateLimiter({ windowMs = 60_000, max = 120 } = {}) {
  const buckets = new Map();

  return function checkLimit(ip, nowMs = Date.now()) {
    // Periodic cleanup if map grows
    if (buckets.size > 5000) {
      for (const [key, entry] of buckets.entries()) {
        if (entry.resetAt <= nowMs) buckets.delete(key);
      }
    }

    const existing = buckets.get(ip);
    if (!existing || existing.resetAt <= nowMs) {
      buckets.set(ip, { count: 1, resetAt: nowMs + windowMs });
      return { allowed: true, remaining: max - 1, retryAfterSeconds: 0 };
    }

    existing.count += 1;
    if (existing.count > max) {
      const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetAt - nowMs) / 1000));
      return { allowed: false, remaining: 0, retryAfterSeconds };
    }

    return { allowed: true, remaining: max - existing.count, retryAfterSeconds: 0 };
  };
}

/**
 * Build standard security + CORS headers.
 */
export function buildSecurityHeaders(req, allowedOrigins = []) {
  const headers = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
  };

  const proto = String(req.headers['x-forwarded-proto'] || '');
  if (proto === 'https') {
    headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  }

  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Vary'] = 'Origin';
    headers['Access-Control-Allow-Credentials'] = 'true';
    headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    headers['Access-Control-Allow-Headers'] =
      'Content-Type, Authorization, X-API-Key, X-App-Timestamp, X-App-Signature';
  }

  return headers;
}
