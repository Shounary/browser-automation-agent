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
  isCancelled = () => false,
}) {
  const deadline = Date.now() + timeoutMs;
  const history = [];

  for (let step = 0; step < maxSteps; step++) {
    if (isCancelled()) return gaveUp('stopped', step, onEvent);
    if (Date.now() > deadline) {
      return gaveUp(`run timeout reached after ${step} steps`, step, onEvent);
    }

    // Re-extract every iteration. Never reuse a map across actions.
    const state = await extractInteractiveElements(page);
    onEvent({
      type: 'observe',
      step,
      url: state.url,
      title: state.title,
      elements: state.map.length,
      screenshot: screenshots ? await capture(page) : undefined,
    });

    const { action, error } = await llm.chooseAction(task, state, history.slice(-HISTORY_WINDOW));
    if (error) return gaveUp(error, step, onEvent);
    // The model call is the slow part; a stop pressed during it lands here.
    if (isCancelled()) return gaveUp('stopped', step, onEvent);

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

  return gaveUp(`step limit reached (${maxSteps} steps)`, maxSteps, onEvent);
}

async function capture(page) {
  return page.screenshot(SCREENSHOT).then(b => b.toString('base64')).catch(() => undefined);
}

function gaveUp(reason, steps, onEvent) {
  onEvent({ type: 'gave_up', reason });
  return { status: 'gave_up', reason, steps };
}

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
