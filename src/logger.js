const LEVELS = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40, FATAL: 50 };
const MIN_LEVEL = LEVELS[(process.env.LOG_LEVEL || 'INFO').toUpperCase()] ?? LEVELS.INFO;

function formatMeta(meta) {
  if (!meta || typeof meta !== 'object') return '';
  const parts = Object.entries(meta)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => {
      const str = String(v).replace(/\r?\n/g, ' ');
      return /\s/.test(str) ? `${k}="${str.replace(/"/g, '\\"')}"` : `${k}=${str}`;
    });
  return parts.length ? ` ${parts.join(' ')}` : '';
}

export function createLogger(scope) {
  const emit = (level, method, message, meta) => {
    if (LEVELS[level] < MIN_LEVEL) return;
    const prefix = method ? `[${level}][${scope}][${method}]` : `[${level}][${scope}]`;
    const cleanMsg = String(message).replace(/\r?\n/g, ' ');
    const line = `${prefix} ${cleanMsg}${formatMeta(meta)}`;
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
