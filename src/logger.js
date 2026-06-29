/**
 * Lightweight structured logger — zero dependencies.
 * Outputs timestamped, leveled log lines to stdout.
 * Set LOG_LEVEL=debug|info|warn|error to control verbosity (default: info).
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const CURRENT_LEVEL = LEVELS[process.env.LOG_LEVEL || 'info'] || LEVELS.info;

function format(level, msg, meta) {
  const ts = new Date().toISOString();
  const metaStr = meta && Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
  return `[${ts}] ${level.toUpperCase()} ${msg}${metaStr}`;
}

function log(level, msg, meta) {
  if (LEVELS[level] < CURRENT_LEVEL) return;
  const line = format(level, msg, meta);
  if (level === 'error') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

module.exports = {
  debug: (msg, meta) => log('debug', msg, meta),
  info: (msg, meta) => log('info', msg, meta),
  warn: (msg, meta) => log('warn', msg, meta),
  error: (msg, meta) => log('error', msg, meta),
  child: (prefix) => ({
    debug: (msg, meta) => log('debug', `[${prefix}] ${msg}`, meta),
    info: (msg, meta) => log('info', `[${prefix}] ${msg}`, meta),
    warn: (msg, meta) => log('warn', `[${prefix}] ${msg}`, meta),
    error: (msg, meta) => log('error', `[${prefix}] ${msg}`, meta),
  }),
};
