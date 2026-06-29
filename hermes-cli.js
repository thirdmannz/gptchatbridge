#!/usr/bin/env node
/**
 * Hermes CLI Helper - Interact with ChatGPT Bridge from command line
 * 
 * Usage:
 *   node hermes-cli.js status
 *   node hermes-cli.js sessions
 *   node hermes-cli.js messages <session-id>
 *   node hermes-cli.js send <session-id> "your prompt here"
 *   node hermes-cli.js images <session-id>
 *   node hermes-cli.js save-image <image-url> [filename]
 *   node hermes-cli.js ask "your prompt"  (auto-creates session if needed)
 */

const BASE = process.env.BRIDGE_URL || 'http://localhost:3400';

async function api(path, opts = {}) {
  const resp = await fetch(`${BASE}/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  return resp.json();
}

async function main() {
  const [,, cmd, ...args] = process.argv;

  switch (cmd) {
    case 'status': {
      const data = await api('/status');
      console.log(JSON.stringify(data, null, 2));
      break;
    }

    case 'sessions': {
      const data = await api('/sessions');
      if (data.ok) {
        data.sessions.forEach(s => {
          console.log(`  ${s.id.substring(0, 16)}  ${s.title}`);
        });
        console.log(`\nTotal: ${data.count} sessions`);
      } else {
        console.error('Error:', data.error);
      }
      break;
    }

    case 'messages': {
      const id = args[0];
      if (!id) { console.error('Usage: messages <session-id>'); process.exit(1); }
      const data = await api(`/sessions/${id}`);
      if (data.ok) {
        data.messages.forEach(m => {
          console.log(`\n--- ${m.role.toUpperCase()} ---`);
          console.log(m.content.substring(0, 2000));
          if (m.content.length > 2000) console.log('... (truncated)');
        });
      } else {
        console.error('Error:', data.error);
      }
      break;
    }

    case 'send': {
      const id = args[0];
      const prompt = args.slice(1).join(' ');
      if (!id || !prompt) { console.error('Usage: send <session-id> "prompt"'); process.exit(1); }
      console.log(`Sending to ${id}...`);
      const data = await api(`/sessions/${id}/messages`, {
        method: 'POST',
        body: JSON.stringify({ prompt }),
      });
      if (data.ok) {
        console.log('\n=== Response ===');
        console.log(data.response?.content || JSON.stringify(data.response, null, 2));
        if (data.response?.images?.length) {
          console.log(`\n${data.response.images.length} image(s) found`);
        }
      } else {
        console.error('Error:', data.error);
      }
      break;
    }

    case 'images': {
      const id = args[0];
      if (!id) { console.error('Usage: images <session-id>'); process.exit(1); }
      const data = await api(`/sessions/${id}/images`);
      if (data.ok) {
        data.images.forEach(img => {
          console.log(`  [${img.index}] ${img.width}x${img.height} - ${img.alt || 'no alt'}`);
          console.log(`       ${img.src.substring(0, 100)}...`);
        });
        console.log(`\nTotal: ${data.count} images`);
      } else {
        console.error('Error:', data.error);
      }
      break;
    }

    case 'save-image': {
      const url = args[0];
      const filename = args[1];
      if (!url) { console.error('Usage: save-image <image-url> [filename]'); process.exit(1); }
      const data = await api('/images/save', {
        method: 'POST',
        body: JSON.stringify({ url, filename }),
      });
      if (data.ok) {
        console.log(`Saved: ${data.path}`);
      } else {
        console.error('Error:', data.error);
      }
      break;
    }

    case 'ask': {
      const prompt = args.join(' ');
      if (!prompt) { console.error('Usage: ask "your prompt"'); process.exit(1); }
      
      // Create new chat first
      console.log('Creating new chat...');
      const newData = await api('/sessions/new', { method: 'POST' });
      
      // Get latest sessions to find the new one
      const sessData = await api('/sessions');
      if (!sessData.ok || sessData.sessions.length === 0) {
        console.error('Could not get sessions');
        process.exit(1);
      }
      
      const latestSession = sessData.sessions[0];
      console.log(`Session: ${latestSession.id}`);
      console.log(`Sending: ${prompt.substring(0, 100)}...`);
      
      const data = await api(`/sessions/${latestSession.id}/messages`, {
        method: 'POST',
        body: JSON.stringify({ prompt }),
      });
      
      if (data.ok) {
        console.log('\n=== ChatGPT Response ===');
        console.log(data.response?.content || JSON.stringify(data.response, null, 2));
      } else {
        console.error('Error:', data.error);
      }
      break;
    }

    case 'stream': {
      const id = args[0];
      const prompt = args.slice(1).join(' ');
      if (!id || !prompt) { console.error('Usage: stream <session-id> "prompt"'); process.exit(1); }
      console.log(`Streaming from ${id}...`);
      const resp = await fetch(`${BASE}/api/sessions/${id}/messages?stream=1`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
      });
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let lastFull = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const evt = JSON.parse(line.slice(6));
            if (evt.type === 'stream' && evt.full && evt.full !== lastFull) {
              process.stdout.write(evt.full.slice(lastFull.length));
              lastFull = evt.full;
            } else if (evt.type === 'error') {
              console.error('\nError:', evt.error);
            }
          } catch {}
        }
      }
      console.log('\n\n[stream ended]');
      break;
    }

    case 'agent': {
      const id = args[0];
      const prompt = args[1];
      const repoPath = args[2];
      if (!id || !prompt || !repoPath) {
        console.error('Usage: agent <session-id> "prompt" /path/to/repo [--context]');
        process.exit(1);
      }
      const withContext = args.includes('--context');
      console.log(`Agent loop on ${id}, repo: ${repoPath}${withContext ? ' (+context)' : ''}`);
      const resp = await fetch(`${BASE}/api/sessions/${id}/agent?stream=1`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, repoPath, repoContext: withContext || undefined }),
      });
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const evt = JSON.parse(line.slice(6));
            if (evt.type === 'agent') {
              switch (evt.type) {
                case 'iteration':
                  console.log(`\n--- Iteration ${evt.index} ---`);
                  break;
                case 'tool_call':
                  console.log(`  [tool] ${evt.tool}(${JSON.stringify(evt.args)})`);
                  break;
                case 'tool_result':
                  if (evt.error) console.log(`  [result] ERROR: ${evt.error}`);
                  else {
                    const r = JSON.stringify(evt.result);
                    console.log(`  [result] ${r.length > 200 ? r.substring(0, 200) + '...' : r}`);
                  }
                  break;
                case 'assistant':
                  console.log(`  [assistant] ${evt.content.substring(0, 300)}${evt.content.length > 300 ? '...' : ''}`);
                  break;
              }
            } else if (evt.type === 'done') {
              console.log(`\n=== Agent done (${evt.iterations} iterations) ===`);
              if (evt.finalText) console.log(evt.finalText);
            } else if (evt.type === 'error') {
              console.error('Agent error:', evt.error);
            }
          } catch {}
        }
      }
      break;
    }

    default:
      console.log(`
ChatGPT Bridge CLI

Usage:
  node hermes-cli.js status                    - Check bridge status
  node hermes-cli.js sessions                  - List all sessions
  node hermes-cli.js messages <id>             - View session messages
  node hermes-cli.js send <id> "prompt"        - Send a prompt (wait for full)
  node hermes-cli.js stream <id> "prompt"      - Send a prompt (SSE streaming)
  node hermes-cli.js agent <id> "prompt" /repo - Agent loop (read/write/run files)
  node hermes-cli.js agent <id> "prompt" /repo --context  - + repo context injected
  node hermes-cli.js images <id>               - List session images
  node hermes-cli.js save-image <url> [name]   - Save image to disk
  node hermes-cli.js ask "prompt"              - New chat + send prompt

Environment:
  BRIDGE_URL=http://localhost:3400  (default)
      `);
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
