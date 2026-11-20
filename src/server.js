import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MapManager } from './maps.js';
import { PasskeyManager } from './passkeys.js';
import { RunnerStore } from './store.js';
import { ScraperController } from './scraper-control.js';
import {
  buildClearSessionCookie,
  buildSecurityHeaders,
  buildSessionCookie,
  createRateLimiter,
  createSessionToken,
  getClientIp,
  hasValidSessionCookie,
  timingSafeEqualStr,
  verifyApiKey,
  verifyAppRequest,
} from './security.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const ROUTE_FILE =
  process.env.ROUTE_FILE || path.resolve(__dirname, '../data/curitiba-route.json');
const PUBLIC_DIR = path.resolve(__dirname, '../public');
const API_KEY = process.env.INGEST_API_KEY || '';
const APP_API_TOKEN = process.env.APP_API_TOKEN || '';
const ADMIN_PASSWORD =
  process.env.ADMIN_PASSWORD || process.env.AUTH_PASSWORD || process.env.ADMIN_SETUP_TOKEN || '';
const ADMIN_SETUP_TOKEN = process.env.ADMIN_SETUP_TOKEN || '';
const PASSKEY_STORE_FILE =
  process.env.PASSKEY_STORE_FILE || path.resolve(__dirname, '../auth/passkeys.json');
const MAPS_DIR = process.env.MAPS_DIR || path.resolve(__dirname, '../maps');
const WEBAUTHN_RP_ID = process.env.WEBAUTHN_RP_ID || '';
const WEBAUTHN_ORIGIN = (process.env.WEBAUTHN_ORIGIN || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const SESSION_SECRET =
  process.env.SESSION_SECRET ||
  (ADMIN_PASSWORD || APP_API_TOKEN || ADMIN_SETUP_TOKEN || API_KEY
    ? crypto
        .createHash('sha256')
        .update(`eagles-session:${ADMIN_PASSWORD}:${APP_API_TOKEN}:${ADMIN_SETUP_TOKEN}:${API_KEY}`)
        .digest('hex')
    : '');
const SCRAPER_NOVNC_HOST = process.env.SCRAPER_NOVNC_HOST || 'eagles-scrapper';
const SCRAPER_NOVNC_PORT = Number(process.env.SCRAPER_NOVNC_PORT || 6080);
const ALLOWED_ORIGINS = (
  process.env.ALLOWED_ORIGINS ||
  'https://eaglesrunclub.com,https://www.eaglesrunclub.com,https://eagles.boomhut.dev'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const mapManager = new MapManager({ mapsDir: MAPS_DIR, defaultRouteFile: ROUTE_FILE });
const store = new RunnerStore(mapManager);
const scraperControl = new ScraperController();
const passkeys = new PasskeyManager({
  storeFile: PASSKEY_STORE_FILE,
  rpName: 'Eagles Run Club Admin',
  rpID: WEBAUTHN_RP_ID,
  expectedOrigins: WEBAUTHN_ORIGIN,
});

const apiLimiter = createRateLimiter({ windowMs: 60_000, max: 180 });
const loginLimiter = createRateLimiter({ windowMs: 15 * 60_000, max: 10 });

function isHttpsRequest(req) {
  return String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https';
}

function sendJson(req, res, status, data, extraHeaders = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...buildSecurityHeaders(req, ALLOWED_ORIGINS),
    ...extraHeaders,
  });
  res.end(body);
}

function redirectToLogin(req, res, nextPath = '/') {
  const safeNext =
    typeof nextPath === 'string' && nextPath.startsWith('/') && !nextPath.startsWith('//')
      ? nextPath
      : '/';
  res.writeHead(302, {
    Location: `/login?next=${encodeURIComponent(safeNext)}`,
    ...buildSecurityHeaders(req, ALLOWED_ORIGINS),
  });
  res.end();
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 5_000_000) {
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON payload'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, reqPath, res) {
  let safePath = reqPath;
  if (safePath === '/') {
    safePath = '/index.html';
  } else if (safePath === '/devices' || safePath === '/devices/') {
    safePath = '/devices.html';
  } else if (safePath === '/map' || safePath === '/map/') {
    safePath = '/map.html';
  } else if (safePath === '/login' || safePath === '/login/') {
    safePath = '/login.html';
  }
  const fullPath = path.resolve(PUBLIC_DIR, `.${safePath}`);
  if (!fullPath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, buildSecurityHeaders(req, ALLOWED_ORIGINS));
    res.end('Forbidden');
    return;
  }

  fs.readFile(fullPath, (err, content) => {
    if (err) {
      res.writeHead(404, {
        'Content-Type': 'text/plain; charset=utf-8',
        ...buildSecurityHeaders(req, ALLOWED_ORIGINS),
      });
      res.end('Not Found');
      return;
    }
    const ext = path.extname(fullPath);
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      ...buildSecurityHeaders(req, ALLOWED_ORIGINS),
    });
    res.end(content);
  });
}

function isScraperAuthed(req) {
  return verifyApiKey(req, API_KEY);
}

function isSessionAuthed(req) {
  return hasValidSessionCookie(req, SESSION_SECRET);
}

function isAppAuthed(req, pathname) {
  return verifyAppRequest(req, pathname, { appToken: APP_API_TOKEN }).ok;
}

function canReadAppApi(req, pathname) {
  return isAppAuthed(req, pathname) || isSessionAuthed(req) || isScraperAuthed(req);
}

function canControlAdmin(req) {
  return isSessionAuthed(req) || isScraperAuthed(req);
}

function proxyNoVncHttp(req, res, url) {
  if (!isSessionAuthed(req)) {
    if (url.pathname === '/auth' || url.pathname === '/auth/' || url.pathname.endsWith('.html')) {
      return redirectToLogin(req, res, '/auth');
    }
    res.writeHead(401, {
      'Content-Type': 'text/plain; charset=utf-8',
      ...buildSecurityHeaders(req, ALLOWED_ORIGINS),
    });
    res.end('Unauthorized');
    return;
  }

  if (url.pathname === '/auth' || url.pathname === '/auth/') {
    return serveStatic(req, '/auth.html', res);
  }

  const upstreamPath = (url.pathname.slice('/auth'.length) || '/') + url.search;
  const proxyReq = http.request(
    {
      hostname: SCRAPER_NOVNC_HOST,
      port: SCRAPER_NOVNC_PORT,
      path: upstreamPath,
      method: req.method,
      headers: {
        ...req.headers,
        host: `${SCRAPER_NOVNC_HOST}:${SCRAPER_NOVNC_PORT}`,
      },
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    }
  );

  proxyReq.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(502, {
        'Content-Type': 'text/plain; charset=utf-8',
        ...buildSecurityHeaders(req, ALLOWED_ORIGINS),
      });
    }
    res.end('Sign-in service is currently unavailable. Please try again in a moment.');
  });

  req.pipe(proxyReq);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, buildSecurityHeaders(req, ALLOWED_ORIGINS));
    res.end();
    return;
  }

  // Rate limit all /api/* requests per client IP
  if (url.pathname.startsWith('/api/')) {
    const ip = getClientIp(req);
    const limit = apiLimiter(ip);
    if (!limit.allowed) {
      return sendJson(
        req,
        res,
        429,
        { error: 'Too many requests. Please try again shortly.' },
        { 'Retry-After': String(limit.retryAfterSeconds) }
      );
    }
  }

  // Public login screen, brand icon + PWA manifest
  if (
    req.method === 'GET' &&
    (url.pathname === '/login' ||
      url.pathname === '/login/' ||
      url.pathname === '/manifest.json' ||
      url.pathname === '/eagles-icon.png' ||
      url.pathname === '/favicon.ico')
  ) {
    return serveStatic(req, url.pathname === '/favicon.ico' ? '/eagles-icon.png' : url.pathname, res);
  }

  // Web session login (rate-limited)
  if (req.method === 'POST' && url.pathname === '/api/auth/login') {
    const ip = getClientIp(req);
    const limit = loginLimiter(ip);
    if (!limit.allowed) {
      return sendJson(
        req,
        res,
        429,
        { error: 'Too many sign-in attempts. Please wait a few minutes.' },
        { 'Retry-After': String(limit.retryAfterSeconds) }
      );
    }
    try {
      const body = await readJsonBody(req);
      const password = typeof body.password === 'string' ? body.password : '';
      if (!ADMIN_PASSWORD || !timingSafeEqualStr(password, ADMIN_PASSWORD)) {
        return sendJson(req, res, 401, { error: 'Invalid access code.' });
      }
      const token = createSessionToken(SESSION_SECRET);
      return sendJson(
        req,
        res,
        200,
        { ok: true },
        { 'Set-Cookie': buildSessionCookie(token, { secure: isHttpsRequest(req) }) }
      );
    } catch (err) {
      return sendJson(req, res, 400, { error: err.message });
    }
  }

  // Web session logout
  if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
    return sendJson(
      req,
      res,
      200,
      { ok: true },
      { 'Set-Cookie': buildClearSessionCookie({ secure: isHttpsRequest(req) }) }
    );
  }

  // Passkey status (used by /login to show Fingerprint/FaceID login & enrollment controls)
  if (req.method === 'GET' && url.pathname === '/api/auth/passkey/status') {
    const authenticated = isSessionAuthed(req);
    return sendJson(req, res, 200, {
      hasPasskeys: passkeys.hasPasskeys(),
      setupEnabled: Boolean(ADMIN_SETUP_TOKEN),
      passwordEnabled: Boolean(ADMIN_PASSWORD),
      authenticated,
      ...(authenticated
        ? { count: passkeys.credentials.length, passkeys: passkeys.listPublicPasskeys() }
        : {}),
    });
  }

  // Passkey registration options (requires valid session OR ADMIN_SETUP_TOKEN)
  if (req.method === 'POST' && url.pathname === '/api/auth/passkey/register/options') {
    const ip = getClientIp(req);
    const limit = loginLimiter(ip);
    if (!limit.allowed) {
      return sendJson(
        req,
        res,
        429,
        { error: 'Too many attempts. Please wait a few minutes.' },
        { 'Retry-After': String(limit.retryAfterSeconds) }
      );
    }
    try {
      const body = await readJsonBody(req);
      const setupToken = typeof body.setupToken === 'string' ? body.setupToken : '';
      const canEnroll =
        isSessionAuthed(req) ||
        (Boolean(ADMIN_SETUP_TOKEN) && timingSafeEqualStr(setupToken, ADMIN_SETUP_TOKEN));
      if (!canEnroll) {
        return sendJson(req, res, 401, {
          error: 'Invalid setup token or admin session required to enroll a passkey.',
        });
      }
      const { challengeId, options } = await passkeys.createRegistrationOptions(req);
      return sendJson(req, res, 200, { challengeId, options });
    } catch (err) {
      return sendJson(req, res, 400, { error: err.message });
    }
  }

  // Passkey registration verify (saves public key and starts an authenticated session)
  if (req.method === 'POST' && url.pathname === '/api/auth/passkey/register/verify') {
    const ip = getClientIp(req);
    const limit = loginLimiter(ip);
    if (!limit.allowed) {
      return sendJson(
        req,
        res,
        429,
        { error: 'Too many attempts. Please wait a few minutes.' },
        { 'Retry-After': String(limit.retryAfterSeconds) }
      );
    }
    try {
      const body = await readJsonBody(req);
      const setupToken = typeof body.setupToken === 'string' ? body.setupToken : '';
      const canEnroll =
        isSessionAuthed(req) ||
        (Boolean(ADMIN_SETUP_TOKEN) && timingSafeEqualStr(setupToken, ADMIN_SETUP_TOKEN));
      if (!canEnroll) {
        return sendJson(req, res, 401, {
          error: 'Invalid setup token or admin session required to enroll a passkey.',
        });
      }
      const saved = await passkeys.verifyRegistration(req, {
        challengeId: body.challengeId,
        response: body.response,
        label: body.label,
      });
      const token = createSessionToken(SESSION_SECRET);
      return sendJson(
        req,
        res,
        200,
        { ok: true, passkey: saved },
        { 'Set-Cookie': buildSessionCookie(token, { secure: isHttpsRequest(req) }) }
      );
    } catch (err) {
      return sendJson(req, res, 400, { error: err.message });
    }
  }

  // Passkey login options (Fingerprint / FaceID challenge)
  if (req.method === 'POST' && url.pathname === '/api/auth/passkey/login/options') {
    const ip = getClientIp(req);
    const limit = loginLimiter(ip);
    if (!limit.allowed) {
      return sendJson(
        req,
        res,
        429,
        { error: 'Too many sign-in attempts. Please wait a few minutes.' },
        { 'Retry-After': String(limit.retryAfterSeconds) }
      );
    }
    try {
      const { challengeId, options } = await passkeys.createAuthenticationOptions(req);
      return sendJson(req, res, 200, { challengeId, options });
    } catch (err) {
      return sendJson(req, res, 400, { error: err.message });
    }
  }

  // Passkey login verify (verifies biometric assertion and sets HttpOnly session cookie)
  if (req.method === 'POST' && url.pathname === '/api/auth/passkey/login/verify') {
    const ip = getClientIp(req);
    const limit = loginLimiter(ip);
    if (!limit.allowed) {
      return sendJson(
        req,
        res,
        429,
        { error: 'Too many sign-in attempts. Please wait a few minutes.' },
        { 'Retry-After': String(limit.retryAfterSeconds) }
      );
    }
    try {
      const body = await readJsonBody(req);
      const matched = await passkeys.verifyAuthentication(req, {
        challengeId: body.challengeId,
        response: body.response,
      });
      const token = createSessionToken(SESSION_SECRET);
      return sendJson(
        req,
        res,
        200,
        { ok: true, passkey: matched },
        { 'Set-Cookie': buildSessionCookie(token, { secure: isHttpsRequest(req) }) }
      );
    } catch (err) {
      return sendJson(req, res, 401, { error: err.message });
    }
  }

  // Health check (protected: App-to-App signed token, Web session, or Scraper key)
  if (req.method === 'GET' && url.pathname === '/api/health') {
    if (!canReadAppApi(req, url.pathname)) {
      return sendJson(req, res, 401, { error: 'Unauthorized' });
    }
    const primary = mapManager.getPrimaryMap();
    return sendJson(req, res, 200, {
      ok: true,
      route: primary.name,
      totalKm: Number((primary.totalMeters / 1000).toFixed(2)),
      openMapCount: mapManager.getOpenMaps().length,
      runnerCount: store.runners.size,
      scraper: scraperControl.getStatus(),
    });
  }

  // Full marathon route geometry + all open maps (App-to-App signed token or Web session)
  if (req.method === 'GET' && url.pathname === '/api/route') {
    if (!canReadAppApi(req, url.pathname)) {
      return sendJson(req, res, 401, { error: 'Unauthorized' });
    }
    return sendJson(req, res, 200, mapManager.getPublicRoutePayload());
  }

  // Map management: list all maps, open maps, and device assignments
  if (req.method === 'GET' && url.pathname === '/api/maps') {
    if (!canReadAppApi(req, url.pathname)) {
      return sendJson(req, res, 401, { error: 'Unauthorized' });
    }
    return sendJson(req, res, 200, {
      ...mapManager.getState(),
      knownDevices: scraperControl.knownDevices,
    });
  }

  // Map management: add a new map (GPX or JSON)
  if (req.method === 'POST' && url.pathname === '/api/maps') {
    if (!canControlAdmin(req)) {
      return sendJson(req, res, 401, { error: 'Unauthorized' });
    }
    try {
      const body = await readJsonBody(req);
      const created = mapManager.addMap({
        name: body.name,
        distanceLabel: body.distanceLabel,
        city: body.city,
        color: body.color,
        gpx: body.gpx,
        json: body.json,
        open: body.open !== false,
        setPrimary: Boolean(body.setPrimary),
      });
      store.recomputeAll();
      return sendJson(req, res, 201, { ok: true, map: created, state: mapManager.getState() });
    } catch (err) {
      return sendJson(req, res, 400, { error: err.message });
    }
  }

  // Map management: change current primary map
  if (req.method === 'POST' && url.pathname === '/api/maps/select') {
    if (!canControlAdmin(req)) {
      return sendJson(req, res, 401, { error: 'Unauthorized' });
    }
    try {
      const body = await readJsonBody(req);
      const state = mapManager.setPrimaryMap(body.mapId);
      store.recomputeAll();
      return sendJson(req, res, 200, { ok: true, ...state });
    } catch (err) {
      return sendJson(req, res, 400, { error: err.message });
    }
  }

  // Map management: toggle a map open/closed (supports multiple open maps e.g. 5k, 10k, 21k)
  if (req.method === 'POST' && url.pathname === '/api/maps/open') {
    if (!canControlAdmin(req)) {
      return sendJson(req, res, 401, { error: 'Unauthorized' });
    }
    try {
      const body = await readJsonBody(req);
      const state = mapManager.setMapOpen(body.mapId, Boolean(body.open));
      store.recomputeAll();
      return sendJson(req, res, 200, { ok: true, ...state });
    } catch (err) {
      return sendJson(req, res, 400, { error: err.message });
    }
  }

  // Map management: assign a device/runner to a specific open map (or null for default)
  if (req.method === 'POST' && url.pathname === '/api/maps/assign') {
    if (!canControlAdmin(req)) {
      return sendJson(req, res, 401, { error: 'Unauthorized' });
    }
    try {
      const body = await readJsonBody(req);
      const state = mapManager.assignDevice(body.runnerId, body.mapId || null);
      store.recomputeAll();
      return sendJson(req, res, 200, { ok: true, ...state });
    } catch (err) {
      return sendJson(req, res, 400, { error: err.message });
    }
  }

  // Map management: delete a map
  if (req.method === 'POST' && url.pathname === '/api/maps/delete') {
    if (!canControlAdmin(req)) {
      return sendJson(req, res, 401, { error: 'Unauthorized' });
    }
    try {
      const body = await readJsonBody(req);
      const state = mapManager.deleteMap(body.mapId);
      store.recomputeAll();
      return sendJson(req, res, 200, { ok: true, ...state });
    } catch (err) {
      return sendJson(req, res, 400, { error: err.message });
    }
  }

  // Snapshot of all runners (App-to-App signed token or Web session)
  if (req.method === 'GET' && url.pathname === '/api/state') {
    if (!canReadAppApi(req, url.pathname)) {
      return sendJson(req, res, 401, { error: 'Unauthorized' });
    }
    return sendJson(req, res, 200, store.getSnapshot());
  }

  // Live SSE stream for web map viewers (App-to-App signed token or Web session)
  if (req.method === 'GET' && url.pathname === '/api/stream') {
    if (!canReadAppApi(req, url.pathname)) {
      return sendJson(req, res, 401, { error: 'Unauthorized' });
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      ...buildSecurityHeaders(req, ALLOWED_ORIGINS),
    });

    res.write(`event: snapshot\ndata: ${JSON.stringify(store.getSnapshot())}\n\n`);

    const unsubscribe = store.subscribe((event, payload) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    });

    const heartbeat = setInterval(() => {
      res.write(`event: tick\ndata: ${JSON.stringify(store.getSnapshot())}\n\n`);
    }, 3000);

    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
    return;
  }

  // Remote browser login UI (proxied to eagles-scrapper noVNC, requires Web session)
  if (url.pathname === '/auth' || url.pathname.startsWith('/auth/')) {
    return proxyNoVncHttp(req, res, url);
  }

  // Scraper control status (Admin session or Scraper key)
  if (req.method === 'GET' && url.pathname === '/api/scraper') {
    if (!canControlAdmin(req)) {
      return sendJson(req, res, 401, { error: 'Unauthorized' });
    }
    return sendJson(req, res, 200, scraperControl.getStatus());
  }

  // Report scraper Google authentication status (Scraper-only X-API-Key)
  if (req.method === 'POST' && url.pathname === '/api/scraper/status') {
    if (!isScraperAuthed(req)) {
      return sendJson(req, res, 401, { error: 'Unauthorized' });
    }
    try {
      const body = await readJsonBody(req);
      const auth = scraperControl.setAuthStatus(body);
      return sendJson(req, res, 200, { ok: true, auth });
    } catch (err) {
      return sendJson(req, res, 400, { error: err.message });
    }
  }

  // Register configured devices reported by eagles-scrapper (Scraper-only X-API-Key)
  if (req.method === 'POST' && url.pathname === '/api/scraper/devices') {
    if (!isScraperAuthed(req)) {
      return sendJson(req, res, 401, { error: 'Unauthorized' });
    }
    try {
      const body = await readJsonBody(req);
      const devices = Array.isArray(body) ? body : body.devices;
      const registered = scraperControl.setKnownDevices(devices);
      store.syncActiveDevices(scraperControl.getActiveDevices());
      return sendJson(req, res, 200, { ok: true, count: registered.length, knownDevices: registered });
    } catch (err) {
      return sendJson(req, res, 400, { error: err.message });
    }
  }

  // Rename a device (Admin session or Scraper key)
  if (req.method === 'POST' && url.pathname === '/api/scraper/rename') {
    if (!canControlAdmin(req)) {
      return sendJson(req, res, 401, { error: 'Unauthorized' });
    }
    try {
      const body = await readJsonBody(req);
      const updated = scraperControl.renameDevice(body.runnerId, body.name);
      store.renameRunner(updated.runnerId, updated.name);
      return sendJson(req, res, 200, { ok: true, ...updated });
    } catch (err) {
      return sendJson(req, res, 400, { error: err.message });
    }
  }

  // Set per-device location update rate (Admin session or Scraper key)
  if (req.method === 'POST' && url.pathname === '/api/scraper/interval') {
    if (!canControlAdmin(req)) {
      return sendJson(req, res, 401, { error: 'Unauthorized' });
    }
    try {
      const body = await readJsonBody(req);
      const updated = scraperControl.setDeviceInterval(body.runnerId, body.intervalSeconds);
      return sendJson(req, res, 200, { ok: true, ...updated });
    } catch (err) {
      return sendJson(req, res, 400, { error: err.message });
    }
  }

  // Scraper start/stop command endpoint (Admin session or Scraper key)
  if (req.method === 'POST' && url.pathname === '/api/scraper') {
    if (!canControlAdmin(req)) {
      return sendJson(req, res, 401, { error: 'Unauthorized' });
    }
    try {
      const body = await readJsonBody(req);
      const action = body.action ?? url.searchParams.get('action') ?? undefined;
      const devices =
        body.devices !== undefined
          ? body.devices
          : url.searchParams.has('devices')
            ? url.searchParams.get('devices')
            : undefined;
      const result = scraperControl.handleCommand({ action, devices });
      store.syncActiveDevices(scraperControl.getActiveDevices());
      return sendJson(req, res, 200, result);
    } catch (err) {
      return sendJson(req, res, 400, { error: err.message });
    }
  }

  // Live SSE command stream consumed by eagles-scrapper (Scraper-only X-API-Key)
  if (req.method === 'GET' && url.pathname === '/api/scraper/events') {
    if (!isScraperAuthed(req)) {
      return sendJson(req, res, 401, { error: 'Unauthorized' });
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      ...buildSecurityHeaders(req, ALLOWED_ORIGINS),
    });

    const unsubscribe = scraperControl.subscribe((event, payload) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    });

    res.write(`event: state\ndata: ${JSON.stringify(scraperControl.getStatus())}\n\n`);

    const heartbeat = setInterval(() => {
      res.write(': keepalive\n\n');
    }, 25000);

    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
    return;
  }

  // Ingest runner location pings (Scraper-only X-API-Key)
  if (req.method === 'POST' && url.pathname === '/api/locations') {
    if (!isScraperAuthed(req)) {
      return sendJson(req, res, 401, { error: 'Unauthorized' });
    }
    try {
      const body = await readJsonBody(req);
      const pings = Array.isArray(body) ? body : Array.isArray(body.pings) ? body.pings : [body];
      const results = pings.map((p) => {
        if (p?.runnerId && (p.batteryPct !== undefined || p.batteryStatus !== undefined)) {
          scraperControl.updateDeviceBattery(p.runnerId, {
            batteryPct: p.batteryPct,
            batteryStatus: p.batteryStatus,
          });
        }
        const customName = scraperControl.getDisplayName(p?.runnerId, p?.name);
        return store.ingestPing(customName ? { ...p, name: customName } : p);
      });
      return sendJson(req, res, 200, { accepted: results.length, runners: results });
    } catch (err) {
      return sendJson(req, res, 400, { error: err.message });
    }
  }

  // Protected web UI (/, /devices, and their static assets require a valid session cookie)
  if (req.method === 'GET') {
    if (!isSessionAuthed(req)) {
      const isPage =
        url.pathname === '/' ||
        url.pathname === '/devices' ||
        url.pathname === '/devices/' ||
        url.pathname === '/map' ||
        url.pathname === '/map/' ||
        url.pathname.endsWith('.html');
      if (isPage) {
        return redirectToLogin(req, res, url.pathname + url.search);
      }
      res.writeHead(401, {
        'Content-Type': 'text/plain; charset=utf-8',
        ...buildSecurityHeaders(req, ALLOWED_ORIGINS),
      });
      res.end('Unauthorized');
      return;
    }
    return serveStatic(req, url.pathname, res);
  }

  res.writeHead(405, buildSecurityHeaders(req, ALLOWED_ORIGINS));
  res.end('Method Not Allowed');
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (!url.pathname.startsWith('/auth/') || !isSessionAuthed(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  const upstreamPath = (url.pathname.slice('/auth'.length) || '/') + url.search;
  const upstream = net.connect(SCRAPER_NOVNC_PORT, SCRAPER_NOVNC_HOST, () => {
    const headerLines = [`${req.method} ${upstreamPath} HTTP/${req.httpVersion}`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i];
      const value = req.rawHeaders[i + 1];
      if (name.toLowerCase() === 'host') {
        headerLines.push(`Host: ${SCRAPER_NOVNC_HOST}:${SCRAPER_NOVNC_PORT}`);
      } else {
        headerLines.push(`${name}: ${value}`);
      }
    }
    upstream.write(`${headerLines.join('\r\n')}\r\n\r\n`);
    if (head && head.length > 0) {
      upstream.write(head);
    }
    upstream.pipe(socket);
    socket.pipe(upstream);
  });

  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
});

server.listen(PORT, HOST, () => {
  const primary = mapManager.getPrimaryMap();
  console.log(`Marathon Tracker backend running at http://localhost:${PORT}`);
  console.log(
    `Loaded primary route: ${primary.name} (${(primary.totalMeters / 1000).toFixed(2)} km, ${primary.points.length} waypoints; ${mapManager.getOpenMaps().length} open map(s))`
  );
  if (!API_KEY) console.warn('WARNING: INGEST_API_KEY is not set.');
  if (!APP_API_TOKEN) console.warn('WARNING: APP_API_TOKEN is not set (mobile app API calls will be rejected).');
  if (!ADMIN_PASSWORD) console.warn('WARNING: ADMIN_PASSWORD is not set (web login disabled).');
});
