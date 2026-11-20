import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRoute } from './gpx-matcher.js';
import { RunnerStore } from './store.js';
import { ScraperController } from './scraper-control.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const ROUTE_FILE =
  process.env.ROUTE_FILE || path.resolve(__dirname, '../data/curitiba-route.json');
const PUBLIC_DIR = path.resolve(__dirname, '../public');
const API_KEY = process.env.INGEST_API_KEY || '';
const SCRAPER_NOVNC_HOST = process.env.SCRAPER_NOVNC_HOST || 'eagles-scrapper';
const SCRAPER_NOVNC_PORT = Number(process.env.SCRAPER_NOVNC_PORT || 6080);
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || '';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const route = loadRoute(ROUTE_FILE);
const store = new RunnerStore(route);
const scraperControl = new ScraperController();

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key',
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
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

function serveStatic(reqPath, res) {
  let safePath = reqPath;
  if (safePath === '/') {
    safePath = '/index.html';
  } else if (safePath === '/devices' || safePath === '/devices/') {
    safePath = '/devices.html';
  }
  const fullPath = path.resolve(PUBLIC_DIR, `.${safePath}`);
  if (!fullPath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(fullPath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    const ext = path.extname(fullPath);
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(content);
  });
}

function checkOptionalBasicAuth(req, res) {
  if (!AUTH_PASSWORD) return true;
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Basic ')) {
    const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
    const sep = decoded.indexOf(':');
    const pass = sep >= 0 ? decoded.slice(sep + 1) : decoded;
    if (pass === AUTH_PASSWORD) return true;
  }
  res.writeHead(401, {
    'WWW-Authenticate': 'Basic realm="Eagles Auth"',
    'Content-Type': 'text/plain; charset=utf-8',
  });
  res.end('Authentication required');
  return false;
}

function proxyNoVncHttp(req, res, url) {
  if (!checkOptionalBasicAuth(req, res)) return;

  if (url.pathname === '/auth' || url.pathname === '/auth/') {
    res.writeHead(302, {
      Location: '/auth/vnc.html?autoconnect=1&resize=scale&path=auth/websockify',
    });
    res.end();
    return;
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
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    res.end('Sign-in service is currently unavailable. Please try again in a moment.');
  });

  req.pipe(proxyReq);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key',
    });
    res.end();
    return;
  }

  // Health check
  if (req.method === 'GET' && url.pathname === '/api/health') {
    return sendJson(res, 200, {
      ok: true,
      route: route.name,
      totalKm: Number((route.totalMeters / 1000).toFixed(2)),
      runnerCount: store.runners.size,
      scraper: scraperControl.getStatus(),
    });
  }

  // Full marathon route geometry for the map
  if (req.method === 'GET' && url.pathname === '/api/route') {
    return sendJson(res, 200, {
      name: route.name,
      city: route.city,
      totalMeters: Math.round(route.totalMeters),
      totalKm: Number((route.totalMeters / 1000).toFixed(2)),
      points: route.points,
      cumulativeMeters: route.cumulativeMeters.map((m) => Math.round(m)),
    });
  }

  // Snapshot of all runners
  if (req.method === 'GET' && url.pathname === '/api/state') {
    return sendJson(res, 200, store.getSnapshot());
  }

  // Live SSE stream for mobile viewers
  if (req.method === 'GET' && url.pathname === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    // Send initial snapshot immediately
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

  // Remote browser login UI (proxied to eagles-scrapper noVNC)
  if (url.pathname === '/auth' || url.pathname.startsWith('/auth/')) {
    return proxyNoVncHttp(req, res, url);
  }

  // Scraper control status
  if (req.method === 'GET' && url.pathname === '/api/scraper') {
    return sendJson(res, 200, scraperControl.getStatus());
  }

  // Report scraper Google authentication status
  if (req.method === 'POST' && url.pathname === '/api/scraper/status') {
    if (API_KEY && req.headers['x-api-key'] !== API_KEY) {
      return sendJson(res, 401, { error: 'Unauthorized: invalid X-API-Key' });
    }
    try {
      const body = await readJsonBody(req);
      const auth = scraperControl.setAuthStatus(body);
      return sendJson(res, 200, { ok: true, auth });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // Register configured devices reported by eagles-scrapper
  if (req.method === 'POST' && url.pathname === '/api/scraper/devices') {
    if (API_KEY && req.headers['x-api-key'] !== API_KEY) {
      return sendJson(res, 401, { error: 'Unauthorized: invalid X-API-Key' });
    }
    try {
      const body = await readJsonBody(req);
      const devices = Array.isArray(body) ? body : body.devices;
      const registered = scraperControl.setKnownDevices(devices);
      store.syncActiveDevices(scraperControl.getActiveDevices());
      return sendJson(res, 200, { ok: true, count: registered.length, knownDevices: registered });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // Rename a device (updates /devices, live web map, and mobile app)
  if (req.method === 'POST' && url.pathname === '/api/scraper/rename') {
    try {
      const body = await readJsonBody(req);
      const updated = scraperControl.renameDevice(body.runnerId, body.name);
      store.renameRunner(updated.runnerId, updated.name);
      return sendJson(res, 200, { ok: true, ...updated });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // Scraper start/stop command endpoint (single endpoint for start & stop + device selection)
  if (req.method === 'POST' && url.pathname === '/api/scraper') {
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
      return sendJson(res, 200, result);
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // Live SSE command stream consumed by eagles-scrapper
  if (req.method === 'GET' && url.pathname === '/api/scraper/events') {
    if (API_KEY && req.headers['x-api-key'] !== API_KEY) {
      return sendJson(res, 401, { error: 'Unauthorized: invalid X-API-Key' });
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    const unsubscribe = scraperControl.subscribe((event, payload) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    });

    // Send current state immediately so reconnecting scrapers sync up
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

  // Ingest one or many runner location pings (called by the scraper or simulator)
  if (req.method === 'POST' && url.pathname === '/api/locations') {
    if (API_KEY && req.headers['x-api-key'] !== API_KEY) {
      return sendJson(res, 401, { error: 'Unauthorized: invalid X-API-Key' });
    }
    try {
      const body = await readJsonBody(req);
      const pings = Array.isArray(body) ? body : Array.isArray(body.pings) ? body.pings : [body];
      const results = pings.map((p) => {
        const customName = scraperControl.getDisplayName(p?.runnerId, p?.name);
        return store.ingestPing(customName ? { ...p, name: customName } : p);
      });
      return sendJson(res, 200, { accepted: results.length, runners: results });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // Serve mobile web UI
  if (req.method === 'GET') {
    return serveStatic(url.pathname, res);
  }

  res.writeHead(405);
  res.end('Method Not Allowed');
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (!url.pathname.startsWith('/auth/')) {
    socket.destroy();
    return;
  }

  if (AUTH_PASSWORD) {
    const authHeader = req.headers.authorization || '';
    let ok = false;
    if (authHeader.startsWith('Basic ')) {
      const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
      const sep = decoded.indexOf(':');
      const pass = sep >= 0 ? decoded.slice(sep + 1) : decoded;
      ok = pass === AUTH_PASSWORD;
    }
    if (!ok) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="Eagles Auth"\r\n\r\n');
      socket.destroy();
      return;
    }
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
  console.log(`Marathon Tracker backend running at http://localhost:${PORT}`);
  console.log(
    `Loaded route: ${route.name} (${(route.totalMeters / 1000).toFixed(2)} km, ${route.points.length} waypoints)`
  );
});
