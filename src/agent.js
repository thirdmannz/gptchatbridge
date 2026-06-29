/**
 * Agent Loop - Lets ChatGPT web read/write files and run commands in a repo.
 *
 * Protocol: we inject a system prefix teaching ChatGPT to emit tool calls as
 * fenced blocks tagged with a tool name. After each assistant reply we scan for
 * tool calls, execute them locally, and feed the results back as the next
 * prompt. The loop ends when ChatGPT produces a reply with no tool calls.
 *
 * Tool call format (one or more per reply):
 *   ```tool
 *   {"tool":"read_file","args":{"path":"src/server.js"}}
 *   ```
 *   ```tool
 *   {"tool":"run","args":{"cmd":"npm test"}}
 *   ```
 */
const tools = require('./tools');
const fs = require('fs');
const path = require('path');
const { AGENT: CFG } = require('./config');

const { EventEmitter } = require('events');
const events = new EventEmitter();

const MAX_ITERATIONS = CFG.MAX_ITERATIONS;

const CONTEXT_MAX_FILES = CFG.CONTEXT_MAX_FILES;
const CONTEXT_MAX_FILE_BYTES = CFG.CONTEXT_MAX_FILE_BYTES;
const CONTEXT_MAX_TOTAL_BYTES = CFG.CONTEXT_MAX_TOTAL_BYTES;

// Default ignore patterns (in addition to .gitignore)
const DEFAULT_IGNORE = [
  'node_modules', '.git', 'browser-data', 'downloads',
  '*.log', '.env', '.DS_Store', 'dist', 'build', '.next',
];

function matchesGlob(name, patterns) {
  return patterns.some(p => {
    if (p === name) return true;
    if (p.startsWith('*.')) {
      const ext = p.slice(1); // ".ext"
      return name.endsWith(ext);
    }
    return false;
  });
}

function readGitignore(root) {
  try {
    const content = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    return content.split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'));
  } catch {
    return [];
  }
}

/**
 * Build a read-only repo context string: file tree + selected file contents.
 * @param {string} repoRoot - absolute path
 * @param {object} [opts] - { glob, maxFiles, maxFileBytes, maxTotalBytes }
 * @returns {Promise<string>} markdown context
 */
async function buildRepoContext(repoRoot, opts = {}) {
  const root = path.resolve(repoRoot);
  const {
    glob: globFilter,
    maxFiles = CONTEXT_MAX_FILES,
    maxFileBytes = CONTEXT_MAX_FILE_BYTES,
    maxTotalBytes = CONTEXT_MAX_TOTAL_BYTES,
  } = opts;

  const ignorePatterns = [...DEFAULT_IGNORE, ...readGitignore(root)];

  const tree = [];
  const collected = [];
  let totalBytes = 0;
  let fileCount = 0;

  async function walk(dir, depth = 0) {
    if (fileCount >= maxFiles || totalBytes >= maxTotalBytes) return;
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
    catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (matchesGlob(entry.name, ignorePatterns)) continue;
      const rel = path.relative(root, path.join(dir, entry.name));
      const indent = '  '.repeat(depth);
      if (entry.isDirectory()) {
        tree.push(`${indent}${entry.name}/`);
        if (depth < 4) await walk(path.join(dir, entry.name), depth + 1);
      } else {
        tree.push(`${indent}${entry.name}`);
        if (fileCount >= maxFiles || totalBytes >= maxTotalBytes) continue;
        if (globFilter && !matchesGlob(entry.name, [globFilter])) continue;
        try {
          const stat = await fs.promises.stat(path.join(dir, entry.name));
          if (stat.size > maxFileBytes) {
            collected.push(`### ${rel} (${stat.size} bytes, skipped — too large)\n`);
            continue;
          }
          const content = await fs.promises.readFile(path.join(dir, entry.name), 'utf8');
          collected.push(`### ${rel}\n\`\`\`\n${content}\n\`\`\`\n`);
          totalBytes += content.length;
          fileCount++;
        } catch {}
      }
    }
  }

  await walk(root);

  const header = `# Repository Context: ${root}\n\n## File Tree\n\`\`\`\n${tree.join('\n')}\n\`\`\`\n\n## File Contents (${fileCount} files)\n`;
  return header + collected.join('\n');
}

const SYSTEM_PREFIX = (repoRoot) => `You are operating inside a local repository at ${repoRoot}.
You can inspect and modify it using tool calls. To call a tool, emit a fenced code block tagged \`tool\` containing a single JSON object on one line:

\`\`\`tool
{"tool":"read_file","args":{"path":"src/server.js"}}
\`\`\`

Available tools:
- read_file   args: { "path": "<repo-relative path>" }            -> returns file content
- write_file  args: { "path": "<repo-relative path>", "content": "<string>" }  -> writes file, returns bytes
- list_dir    args: { "path": "<repo-relative path, default '.'>" } -> returns entries [{name,type}]
- run         args: { "cmd": "<shell command>" }                   -> runs in repo root, returns stdout/stderr/exitCode

Rules:
- Emit each tool call in its own \`\`\`tool block.
- After you receive the tool results, continue reasoning or call more tools.
- When you have finished and want to give the final answer, reply WITHOUT any tool block.
- Keep tool calls minimal; prefer reading only what you need.
- Paths are relative to the repo root and cannot escape it.

Now continue with the user's request below.
`;

// Match ```tool ... ``` blocks (non-greedy, dotall)
const TOOL_BLOCK_RE = /```tool\s*([\s\S]*?)```/g;

function parseToolCalls(text) {
  const calls = [];
  let m;
  TOOL_BLOCK_RE.lastIndex = 0;
  while ((m = TOOL_BLOCK_RE.exec(text)) !== null) {
    const raw = m[1].trim();
    try {
      const obj = JSON.parse(raw);
      if (obj && typeof obj.tool === 'string') {
        calls.push({ tool: obj.tool, args: obj.args || {} });
      }
    } catch {
      // ignore malformed
    }
  }
  return calls;
}

function stripToolBlocks(text) {
  return text.replace(TOOL_BLOCK_RE, '').trim();
}

function formatToolResult(result) {
  if (result.error) {
    return `Tool error: ${result.error}`;
  }
  if (result.result && typeof result.result === 'object') {
    // Truncate large content for the prompt
    const r = result.result;
    if (r.content && r.content.length > CFG.TRUNCATE_OUTPUT_BYTES) {
      r = { ...r, content: r.content.slice(0, CFG.TRUNCATE_OUTPUT_BYTES) + '\n... (truncated)' };
    }
    if (r.stdout && r.stdout.length > CFG.TRUNCATE_OUTPUT_BYTES) {
      r = { ...r, stdout: r.stdout.slice(0, CFG.TRUNCATE_OUTPUT_BYTES) + '\n... (truncated)' };
    }
    return JSON.stringify(r, null, 2);
  }
  return JSON.stringify(result, null, 2);
}

/**
 * Run the agent loop.
 * @param {object} chatgpt - ChatGPTController instance for this user
 * @param {string} sessionId
 * @param {string} prompt - user request
 * @param {string} repoRoot - absolute path to the repo
 * @param {function} [onEvent] - optional callback for each step
 * @returns {Promise<{iterations, finalText, history}>}
 */
async function runAgentLoop(chatgpt, sessionId, prompt, repoRoot, onEvent) {
  const emit = (evt) => {
    events.emit('agent', { sessionId, ...evt });
    if (onEvent) onEvent(evt);
  };

  const history = [];
  const prefix = SYSTEM_PREFIX(repoRoot);
  let currentPrompt = `${prefix}\n\nUser request:\n${prompt}`;
  let iterations = 0;

  while (iterations < MAX_ITERATIONS) {
    iterations++;
    emit({ type: 'iteration', index: iterations });

    // Send the current prompt and wait for the full reply.
    // Error boundary: if sendMessage fails mid-loop, emit an error event
    // and return partial results instead of crashing the caller.
    let res;
    try {
      res = await chatgpt.sendMessage(sessionId, currentPrompt);
    } catch (err) {
      const partialText = history.filter(h => h.role === 'assistant').pop()?.content || '';
      emit({ type: 'error', error: err.message, iteration: iterations });
      emit({ type: 'done', finalText: partialText, iterations, error: err.message });
      return { iterations, finalText: partialText, history, error: err.message };
    }
    const replyText = res.response || '';
    history.push({ role: 'assistant', content: replyText, iteration: iterations });
    emit({ type: 'assistant', content: replyText, iteration: iterations });

    const calls = parseToolCalls(replyText);
    if (calls.length === 0) {
      // No tool calls -> final answer
      const finalText = stripToolBlocks(replyText);
      emit({ type: 'done', finalText, iterations });
      return { iterations, finalText, history };
    }

    // Execute each tool call and collect results
    const results = [];
    for (const call of calls) {
      emit({ type: 'tool_call', tool: call.tool, args: call.args, iteration: iterations });
      // Error boundary per tool: a failing tool shouldn't crash the loop
      let result;
      try {
        result = await tools.execute(call, repoRoot);
      } catch (err) {
        result = { tool: call.tool, error: err.message };
      }
      results.push(result);
      emit({
        type: 'tool_result',
        tool: call.tool,
        args: call.args,
        result: result.result,
        error: result.error,
        iteration: iterations,
      });
    }

    // Feed results back as the next prompt
    const resultBlock = results.map((r, i) =>
      `Tool result ${i + 1} (${r.tool}):\n${formatToolResult(r)}`
    ).join('\n\n');

    currentPrompt = `Here are the results of your tool calls:\n\n${resultBlock}\n\nContinue. Call more tools if needed, or give your final answer without any tool block.`;
    history.push({ role: 'tool_results', content: resultBlock, iteration: iterations });
  }

  // Hit iteration cap
  const finalText = history.filter(h => h.role === 'assistant').pop()?.content || '';
  emit({ type: 'done', finalText, iterations, capped: true });
  return { iterations, finalText, history, capped: true };
}

module.exports = {
  runAgentLoop,
  buildRepoContext,
  parseToolCalls,
  stripToolBlocks,
  events,
  SYSTEM_PREFIX,
  MAX_ITERATIONS,
};
