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

// Public-demo caps. An empty origin list means local dev, which has no deploy origin to match.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean);
const DAILY_LIMIT = Number(process.env.DAILY_LIMIT ?? 40);
const COOLDOWN_MS = Number(process.env.COOLDOWN_MS ?? 120_000);

// Fails fast at boot rather than on the first connection.
const { models } = createGeminiClient();

// Shared across every connection: one browser at a time, whoever is asking.
let active = false;
const lastRun = new Map();
const utcDay = () => new Date().toISOString().slice(0, 10);
let day = utcDay();
let used = 0;

const http = createServer(async (req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, active, used, limit: DAILY_LIMIT }));
    return;
  }
  if (req.url === '/' || req.url === '/client.html') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(await readFile(CLIENT));
    return;
  }
  res.writeHead(404).end('not found');
});

new WebSocketServer({ server: http }).on('connection', (socket, req) => {
  // Browsers set Origin and scripts can forge it, so this only stops other sites embedding us.
  if (ALLOWED_ORIGINS.length && !ALLOWED_ORIGINS.includes(req.headers.origin)) {
    return socket.close(1008, 'origin not allowed');
  }
  // Render's proxy is remoteAddress for every visitor; the real client is first in x-forwarded-for.
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;

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

    const refusal = admit(ip);
    if (refusal) {
      send(refusal);
      // The client is optimistically 'running'; without this the banner spins forever.
      return send({ type: 'status', status: 'gave_up' });
    }

    running = true;
    active = true;
    used++; // counted on start, so a crash loop cannot walk past the cap
    lastRun.set(ip, Date.now());
    controller = new AbortController();
    // Per run, so one run's fallback doesn't pin every later run to a weaker model.
    const llm = createGeminiClient();
    send({ type: 'status', status: 'running', task, model: llm.model, maxSteps: MAX_STEPS, allowedDomains: ALLOWED_DOMAINS });

    let final;
    try {
      // Render's free tier is 512MB with a tiny /dev/shm, which crashes Chromium on heavy pages.
      browser = await chromium.launch({ args: ['--disable-dev-shm-usage', '--disable-gpu', '--no-zygote'] });
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      const popups = await suppressPopups(page.context(), page);

      const run = await runTask({
        task, page, llm, popups,
        screenshots: true,
        signal: controller.signal,
        onEvent: send,
      });

      final = { type: 'status', status: run.status, ...run };
    } catch (err) {
      send({ type: 'gave_up', kind: 'crash', reason: String(err?.message ?? err) });
      final = { type: 'status', status: 'gave_up' };
    } finally {
      await browser?.close().catch(() => {});
      browser = null;
      running = false;
      active = false;
    }
    // Only after cleanup, so a Start sent straight back isn't rejected as busy.
    send(final);
  });

  // A closed tab must not leave a browser running.
  socket.on('close', () => {
    controller?.abort();
  });
});

// Refuses a run as a gave_up event the UI already knows how to phrase.
function admit(ip) {
  if (day !== utcDay()) {
    day = utcDay();
    used = 0;
  }
  if (used >= DAILY_LIMIT) {
    return { type: 'gave_up', kind: 'quota', reason: `The demo's cap of ${DAILY_LIMIT} runs a day is used up.` };
  }
  if (active) {
    return { type: 'gave_up', kind: 'busy', reason: 'Someone else is running a task right now.' };
  }
  // Prune first, or this Map grows for every visitor the process ever sees.
  for (const [addr, at] of lastRun) if (Date.now() - at > COOLDOWN_MS) lastRun.delete(addr);
  const since = Date.now() - (lastRun.get(ip) ?? 0);
  if (since < COOLDOWN_MS) {
    const wait = Math.ceil((COOLDOWN_MS - since) / 1000);
    return { type: 'gave_up', kind: 'rate_limited', reason: `You just ran one. Try again in ${wait}s.` };
  }
  return null;
}

http.listen(PORT, () => {
  console.log(`http://localhost:${PORT}  (open for the test client)`);
  console.log(`model: ${models.join(' -> ')}`);
  if (ALLOWED_ORIGINS.length) console.log(`origins: ${ALLOWED_ORIGINS.join(', ')}`);
  console.log(`caps: ${DAILY_LIMIT}/day, ${COOLDOWN_MS / 1000}s per ip, 1 at a time`);
});

// Playwright installs its own SIGTERM handler that closes Chromium without exiting.
process.on('SIGTERM', () => {
  http.close();
  process.exit(0);
});
