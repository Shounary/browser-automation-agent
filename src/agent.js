// The agent loop: observe -> decide -> execute -> observe again.
// Provider-agnostic

import { extractInteractiveElements } from './page-extractor.js';
import { executeAction } from './page-actions.js';

export const MAX_STEPS = 15;
// Generous, because the free tier answers 503 under load and the client
// backs off rather than failing the run.
export const RUN_TIMEOUT_MS = 300_000;
const HISTORY_WINDOW = 8;
const SCREENSHOT = { type: 'jpeg', quality: 55 };

// SPEC 9/10: navigate is restricted to the curated demo targets
export const ALLOWED_DOMAINS = [
  'wikipedia.org',
  'saucedemo.com',
  'news.ycombinator.com',
];

export async function runTask({
  task,
  page,
  llm,
  popups,
  maxSteps = MAX_STEPS,
  timeoutMs = RUN_TIMEOUT_MS,
  allowedDomains = ALLOWED_DOMAINS,
  onEvent = () => {},
  screenshots = false,
  signal,
}) {
  const deadline = Date.now() + timeoutMs;
  const history = [];

  for (let step = 0; step < maxSteps; step++) {
    if (signal?.aborted) return stopped(step, onEvent);
    if (Date.now() > deadline) {
      return gaveUp('timeout', `run timeout reached after ${step} steps`, step, onEvent);
    }

    // Re-extract every iteration. Never reuse a map across actions.
    const state = await extractInteractiveElements(page);
    onEvent({
      type: 'observe',
      step,
      url: state.url,
      title: state.title,
      elements: state.map.length,
      // The starting page is blank; keep the UI's placeholder up instead.
      screenshot: screenshots && state.url !== 'about:blank' ? await capture(page) : undefined,
    });

    const { action, error, kind } = await llm.chooseAction(task, state, history.slice(-HISTORY_WINDOW), { signal });
    // Checked before `error`: an aborted model call also comes back as one.
    if (signal?.aborted) return stopped(step, onEvent);
    if (error) return gaveUp(kind ?? 'model', error, step, onEvent);

    onEvent({ type: 'action', step, action });

    if (action.name === 'done') {
      onEvent({ type: 'done', step, result: action.result });
      return { status: 'done', result: action.result, steps: step + 1, history };
    }

    const result = action.name === 'navigate' && !isAllowed(action.url, allowedDomains)
      ? { ok: false, message: `${action.url} is not an allowed demo site. Allowed: ${allowedDomains.join(', ')}` }
      : await executeAction(page, state.map, action, { popups });

    history.push(`${history.length + 1}. ${action.name} — ${result.message}`);
    onEvent({ type: 'result', step, ok: result.ok, message: result.message });
  }

  return gaveUp('step_limit', `step limit reached (${maxSteps} steps)`, maxSteps, onEvent);
}

async function capture(page) {
  return page.screenshot(SCREENSHOT).then(b => b.toString('base64')).catch(() => undefined);
}

// kind: 'stopped' | 'timeout' | 'step_limit' | 'quota' | 'model' (server adds 'crash')
function gaveUp(kind, reason, steps, onEvent) {
  onEvent({ type: 'gave_up', kind, reason, steps });
  return { status: 'gave_up', kind, reason, steps };
}

const stopped = (steps, onEvent) => gaveUp('stopped', `stopped after ${steps} steps`, steps, onEvent);

function isAllowed(rawUrl, allowedDomains) {
  let host;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    host = url.hostname.toLowerCase();
  } catch {
    return false;
  }

  return allowedDomains.some(d => host === d || host.endsWith(`.${d}`));
}
