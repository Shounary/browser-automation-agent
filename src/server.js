// WebSocket server: one run per connection.
//
//   client -> { type: 'start', task }   { type: 'stop' }
//   server -> { type: 'status' | 'observe' | 'action' | 'result' | 'done' | 'gave_up', ... }
//
// Run: node src/server.js   (PORT=3001 to change)

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { WebSocketServer } from 'ws';
import { chromium } from 'playwright';
import { suppressPopups } from './page-actions.js';
import { createGeminiClient } from './llm-gemini.js';
import { runTask, ALLOWED_DOMAINS, MAX_STEPS } from './agent.js';

try {
  process.loadEnvFile();
} catch {}

const PORT = Number(process.env.PORT ?? 3001);
const CLIENT = new URL('./client.html', import.meta.url);

// Fails fast at boot rather than on the first connection.
const llm = createGeminiClient();

const http = createServer(async (req, res) => {
  if (req.url === '/' || req.url === '/client.html') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(await readFile(CLIENT));
    return;
  }
  res.writeHead(404).end('not found');
});

new WebSocketServer({ server: http }).on('connection', socket => {
  let running = false;
  let controller = null;
  let browser = null;

  const send = event => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
  };

  socket.on('message', async raw => {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return send({ type: 'error', message: 'malformed json' });
    }

    if (message.type === 'stop') {
      controller?.abort();
      return;
    }

    if (message.type !== 'start') return;
    if (running) return send({ type: 'error', message: 'a run is already in progress' });

    const task = String(message.task ?? '').trim();
    if (!task) return send({ type: 'error', message: 'task is empty' });

    running = true;
    controller = new AbortController();
    send({ type: 'status', status: 'running', task, model: llm.model, maxSteps: MAX_STEPS, allowedDomains: ALLOWED_DOMAINS });

    try {
      browser = await chromium.launch();
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      const popups = await suppressPopups(page.context(), page);

      const run = await runTask({
        task, page, llm, popups,
        screenshots: true,
        signal: controller.signal,
        onEvent: send,
      });

      send({ type: 'status', status: run.status, ...run });
    } catch (err) {
      send({ type: 'gave_up', kind: 'crash', reason: String(err?.message ?? err) });
      send({ type: 'status', status: 'gave_up' });
    } finally {
      await browser?.close().catch(() => {});
      browser = null;
      running = false;
    }
  });

  // A closed tab must not leave a browser running.
  socket.on('close', () => {
    controller?.abort();
  });
});

http.listen(PORT, () => {
  console.log(`http://localhost:${PORT}  (open for the test client)`);
  console.log(`model: ${llm.models.join(' -> ')}`);
});
