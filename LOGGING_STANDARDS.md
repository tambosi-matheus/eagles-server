# Boomhut Logging Standards

Consistent, parseable logging rules for all Boomhut services and apps (`eagles-server`, `eagles-scrapper`, `eagles-app`, `music-dash-server`, `vps-watch`, `boomhut-proxy`).

---

## 1. Standard Log Pattern

Every log line **must** follow this format:

```text
[LEVEL][ClassOrFile][method] message
```

When logging outside a specific method/function (e.g., module startup or top-level script), omit the third bracket:

```text
[LEVEL][ClassOrFile] message
```

Append structured metadata at the end as `key=value` pairs (quote values containing spaces):

```text
[INFO][server] Server listening host=0.0.0.0 port=3000
[INFO][RunnerStore][ingestPing] Ping accepted runnerId=poco-f5 distanceKm=4.20
[WARN][scrape-google-find][pollDevice] Device not visible device="POCO F5" url=https://www.google.com/android/find/
[ERROR][client][sendLocations] Request failed attempt=3 status=502 error="Bad Gateway"
[FATAL][server] Failed to load route file path=/app/data/route.gpx error="ENOENT"
```

---

## 2. Log Levels

Use uppercase level tags only:

| Level   | Stream   | When to use |
| ------- | -------- | ----------- |
| `DEBUG` | `stdout` | High-volume diagnostics, payload shapes, internal loop ticks. Off by default in production. |
| `INFO`  | `stdout` | Lifecycle events (startup, shutdown), state transitions (`idle -> active`, `connected -> disconnected`), key completed actions. |
| `WARN`  | `stderr` | Recoverable issues: retries, auth/validation failures, missing optional config, degraded upstream responses. |
| `ERROR` | `stderr` | Operation failed unexpectedly (exceptions, failed I/O, 5xx errors) while the process continues running. |
| `FATAL` | `stderr` | Unrecoverable failure immediately before process exit (`process.exit(1)`). |

---

## 3. Core Logging Rules

1. **Never log secrets or credentials**
   - Never print passwords, `INGEST_API_KEY`, `APP_API_TOKEN`, `SESSION_SECRET`, Bearer tokens, cookies, HMAC signatures, private keys, or full `Authorization` headers.
   - Log only presence/status (e.g., `hasApiKey=true`, `auth=invalid`) or redacted previews if strictly required.

2. **One event = one line**
   - Keep each log entry on a single line so `docker logs`, `vps-watch`, and `grep` can filter reliably.
   - Avoid pretty-printed JSON dumps (`JSON.stringify(obj, null, 2)`). For errors, log `err.message` (include stack traces only on `ERROR`/`FATAL` when diagnosing unexpected crashes).

3. **Do not duplicate timestamps inside Docker**
   - Docker (`docker logs -t`) and log collectors already attach UTC ISO-8601 timestamps to every line.
   - Outside containers (local CLIs/scripts), prefix UTC ISO-8601 (`new Date().toISOString()`) only if needed.

4. **Log state transitions, not noisy loops**
   - Avoid logging every heartbeat, keepalive, or unchanged polling tick at `INFO` — log them at `DEBUG` or only when state changes.
   - Always log transitions: startup, shutdown, connect/disconnect, auth lost/restored, and start/stop commands.

5. **Include actionable context**
   - State *what happened* plus relevant identifiers (`runnerId`, `deviceName`, `method`, `path`, `status`, `durationMs`, `attempt`).
   - Avoid vague messages like `"error"`, `"failed"`, or `"done"`.

6. **Consistent `[ClassOrFile]` and `[method]` naming**
   - Use the **class name** inside classes (e.g., `[RunnerStore][ingestPing]`, `[ScraperController][handleCommand]`).
   - Use the **file basename without extension** in functional modules (e.g., `[server][POST /api/scraper]`, `[scrape-google-find][pollDevice]`, `[client][connectCommandStream]`).

7. **Respect `LOG_LEVEL`**
   - Read `process.env.LOG_LEVEL` (default `INFO` in production, `DEBUG` in local dev) so verbosity can be adjusted without code changes.

8. **Respect stdout vs. stderr**
   - `DEBUG` / `INFO` → `stdout` (`console.log`)
   - `WARN` → `stderr` (`console.warn`)
   - `ERROR` / `FATAL` → `stderr` (`console.error`)

---

## 4. Reference Logger Helper (JS / TS)

```js
const LEVELS = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40, FATAL: 50 };
const MIN_LEVEL = LEVELS[(process.env.LOG_LEVEL || 'INFO').toUpperCase()] ?? LEVELS.INFO;

function formatMeta(meta) {
  if (!meta || typeof meta !== 'object') return '';
  const parts = Object.entries(meta)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => {
      const str = String(v);
      return /\s/.test(str) ? `${k}="${str.replace(/"/g, '\\"')}"` : `${k}=${str}`;
    });
  return parts.length ? ` ${parts.join(' ')}` : '';
}

export function createLogger(scope) {
  const emit = (level, method, message, meta) => {
    if (LEVELS[level] < MIN_LEVEL) return;
    const prefix = method ? `[${level}][${scope}][${method}]` : `[${level}][${scope}]`;
    const line = `${prefix} ${message}${formatMeta(meta)}`;
    if (level === 'ERROR' || level === 'FATAL') console.error(line);
    else if (level === 'WARN') console.warn(line);
    else console.log(line);
  };

  return {
    debug: (method, msg, meta) => emit('DEBUG', method, msg, meta),
    info: (method, msg, meta) => emit('INFO', method, msg, meta),
    warn: (method, msg, meta) => emit('WARN', method, msg, meta),
    error: (method, msg, meta) => emit('ERROR', method, msg, meta),
    fatal: (method, msg, meta) => emit('FATAL', method, msg, meta),
  };
}
```
