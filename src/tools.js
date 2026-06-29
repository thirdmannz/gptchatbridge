/**
 * Local Tools - File read/write/list and shell execution for the agent loop.
 *
 * All file paths are resolved against `repoRoot` and rejected if they escape it
 * (path traversal protection). `run` executes shell commands with a timeout.
 */
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const { EventEmitter } = require('events');
const { TOOLS: CFG } = require('./config');

const events = new EventEmitter();

const RUN_TIMEOUT_MS = CFG.RUN_TIMEOUT_MS;
const MAX_FILE_READ_BYTES = CFG.MAX_FILE_READ_BYTES;
const MAX_LIST_ENTRIES = CFG.MAX_LIST_ENTRIES;

/**
 * Resolve `relPath` against `repoRoot` and verify it stays inside repoRoot.
 * Returns the absolute path or throws.
 */
function safeResolve(repoRoot, relPath) {
  const root = path.normalize(path.resolve(repoRoot));
  const abs = path.normalize(path.resolve(root, relPath || '.'));
  // Must be inside root (root itself is allowed for list_dir '.')
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`Path escapes repo root: ${relPath}`);
  }
  return abs;
}

async function read_file({ path: relPath }, repoRoot) {
  const abs = safeResolve(repoRoot, relPath);
  const stat = await fs.promises.stat(abs);
  if (stat.isDirectory()) throw new Error(`Not a file: ${relPath}`);
  if (stat.size > MAX_FILE_READ_BYTES) {
    throw new Error(`File too large (${stat.size} bytes > ${MAX_FILE_READ_BYTES}): ${relPath}`);
  }
  const content = await fs.promises.readFile(abs, 'utf8');
  return { path: relPath, size: stat.size, content };
}

async function write_file({ path: relPath, content }, repoRoot) {
  if (typeof content !== 'string') throw new Error('write_file requires `content` string');
  const abs = safeResolve(repoRoot, relPath);
  await fs.promises.mkdir(path.dirname(abs), { recursive: true });
  await fs.promises.writeFile(abs, content, 'utf8');
  return { path: relPath, bytes: Buffer.byteLength(content, 'utf8') };
}

async function list_dir({ path: relPath = '.' }, repoRoot) {
  const abs = safeResolve(repoRoot, relPath);
  const stat = await fs.promises.stat(abs);
  if (!stat.isDirectory()) throw new Error(`Not a directory: ${relPath}`);
  const entries = await fs.promises.readdir(abs, { withFileTypes: true });
  const items = entries
    .slice(0, MAX_LIST_ENTRIES)
    .map(e => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' }));
  return { path: relPath || '.', entries: items, truncated: entries.length > MAX_LIST_ENTRIES };
}

// Blocklist of catastrophic commands — the agent loop intentionally allows
// arbitrary shell execution, but these patterns have no legitimate use in
// code assistance and would cause irreversible damage.
const DANGEROUS_PATTERNS = [
  /rm\s+-rf\s+\/(?!\w)/,         // rm -rf / (not /home/...)
  /rm\s+-rf\s+~/,                // rm -rf ~
  /rm\s+-rf\s+\*\s*$/,           // rm -rf *
  /mkfs/,                        // format filesystem
  /:\(\)\{\s*:\|:\&\s*\};\s*:/,  // fork bomb
  /\bdd\s+.*of=\/dev\/sd/,       // dd to disk device
  /shred\s+\/dev\/sd/,           // shred disk
  />\s*\/dev\/sd[a-z]/,          // write to disk device
  /curl\s+.*\|\s*(sh|bash|zsh)/, // pipe-to-shell (remote code exec)
  /wget\s+.*\|\s*(sh|bash|zsh)/, // pipe-to-shell
];

function isDangerous(cmd) {
  const lower = cmd.toLowerCase();
  return DANGEROUS_PATTERNS.some(p => p.test(lower));
}

function run({ cmd, timeout = RUN_TIMEOUT_MS }, repoRoot) {
  return new Promise((resolve) => {
    if (typeof cmd !== 'string' || !cmd.trim()) {
      return resolve({ cmd, error: 'run requires `cmd` string' });
    }
    if (isDangerous(cmd)) {
      return resolve({ cmd, error: 'Blocked: command matches dangerous pattern blocklist', blocked: true });
    }
    console.log(`[tools] run: ${cmd} (cwd: ${repoRoot})`); // kept as console.log for tool audit trail
    exec(cmd, { cwd: repoRoot, timeout, maxBuffer: CFG.EXEC_MAX_BUFFER }, (err, stdout, stderr) => {
      resolve({
        cmd,
        exitCode: err ? (err.code || 1) : 0,
        stdout: stdout.toString('utf8').slice(0, CFG.STDOUT_SLICE),
        stderr: stderr.toString('utf8').slice(0, CFG.STDERR_SLICE),
        timedOut: !!(err && err.killed && err.signal === 'SIGTERM'),
      });
    });
  });
}

const TOOL_HANDLERS = {
  read_file,
  write_file,
  list_dir,
  run,
};

const TOOL_NAMES = Object.keys(TOOL_HANDLERS);

/**
 * Execute a parsed tool call. Returns { tool, args, result } or { tool, args, error }.
 */
async function execute(toolCall, repoRoot) {
  const { tool, args = {} } = toolCall;
  const handler = TOOL_HANDLERS[tool];
  if (!handler) {
    return { tool, args, error: `Unknown tool: ${tool}` };
  }
  try {
    const result = await handler(args, repoRoot);
    events.emit('tool_result', { tool, args, result });
    return { tool, args, result };
  } catch (err) {
    events.emit('tool_result', { tool, args, error: err.message });
    return { tool, args, error: err.message };
  }
}

module.exports = {
  execute,
  events,
  TOOL_NAMES,
  safeResolve,
  isDangerous,
};
