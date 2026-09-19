// chooseAction(task, state, history, { signal }) -> { action } | { error, kind }
//
// One stateless call per step. The conversation is rebuilt from scratch every
// time, because element ids are only valid for the step they were extracted
// in — replaying old turns would invite the model to reuse dead ids.
//
// Nothing Gemini-shaped escapes this file. `action` is the plain object that
// page-actions.js already understands, so swapping providers is a one-file job.

import { setTimeout as sleep } from 'node:timers/promises';
import { GoogleGenAI, FunctionCallingConfigMode } from '@google/genai';
import { ACTION_DECLARATIONS, ACTION_NAMES, validateAction } from './action-schema.js';

// Comma-separated; first is preferred, the rest are fallbacks.
const MODEL_CHAIN = (process.env.GEMINI_MODEL ??
  'gemini-3.8-flash,gemini-3.7-flash,gemini-3.5-flash,gemini-2.5-flash,gemini-3.5-flash-lite,gemini-2.5-flash-lite')
  .split(',').map(m => m.trim()).filter(Boolean);
const SCHEMA_RETRIES = 2;     // malformed arguments
const TRANSIENT_RETRIES = 1;  // per model, before dropping to the next
const BACKOFF_BASE_MS = 2000;
const BACKOFF_MAX_MS = 20_000;

// Frozen — nothing per-step is interpolated in here.
const SYSTEM_INSTRUCTION = `You drive a real web browser to complete a task for a user.

Each turn you are shown the page you are currently on: its URL, its title, the
text visible on it, and a numbered list of the elements you can act on. You then
call exactly one function to take one action. You will be shown the result and
the next page.

Rules:
- The numbered ids are valid for THIS turn only. The list is re-read after every
  action. Never use an id from an earlier turn.
- You can only act on elements in the list. If what you want is not there, it may
  be further down the page — scroll.
- You cannot see the page as an image. The page text is all you get to read.
- Typing into a field does not submit it. Click the search or submit button.
- If an action fails, you are told why. Read it and try something different —
  do not repeat the action that just failed.
- You have a limited number of steps. Go straight for the task; do not explore.
- Call done as soon as the answer is on screen. Put the answer itself in
  \`result\`, written for someone who never saw the page. If the task turns out
  to be impossible from here, call done and say so in \`result\`.`;

// `client` and `backoffBaseMs` exist so tests can drive the fallback without
// waiting on a real outage.
export function createGeminiClient({
  models = MODEL_CHAIN,
  apiKey,
  client,
  backoffBaseMs = BACKOFF_BASE_MS,
} = {}) {
  if (!client && !apiKey && !process.env.GEMINI_API_KEY && !process.env.GOOGLE_API_KEY) {
    throw new Error(
      'No Gemini API key. Get a free one at https://aistudio.google.com/apikey ' +
      'and run: export GEMINI_API_KEY="..."'
    );
  }

  const ai = client ?? new GoogleGenAI(apiKey ? { apiKey } : {});

  // Sticky: a run drops down the chain but never climbs back up.
  let active = 0;

  const call = async (request, signal) => {
    for (; ; active++) {
      try {
        return await callWithBackoff(ai, models[active], request, backoffBaseMs, signal);
      } catch (err) {
        if (!transientReason(err) || active === models.length - 1) throw err;
        console.error(`  ${models[active]} unavailable — falling back to ${models[active + 1]}`);
      }
    }
  };

  return {
    models,
    get model() { return models[active]; },

    async chooseAction(task, state, history, { signal } = {}) {
      const corrections = [];

      for (let attempt = 0; attempt <= SCHEMA_RETRIES; attempt++) {
        let response;
        try {
          response = await call({
            contents: buildPrompt(task, state, history, corrections),
            config: {
              systemInstruction: SYSTEM_INSTRUCTION,
              tools: [{ functionDeclarations: ACTION_DECLARATIONS }],
              toolConfig: {
                functionCallingConfig: {
                  mode: FunctionCallingConfigMode.ANY,
                  allowedFunctionNames: ACTION_NAMES,
                },
              },
              temperature: 0,
              // Client-side only: Google still finishes (and may bill) the request.
              abortSignal: signal,
            },
          }, signal);
        } catch (err) {
          // Out of retries, or something not worth retrying. The run ends
          // with a message instead of a stack trace.
          return {
            error: `${models[active]} unreachable: ${String(err?.message ?? err).slice(0, 200)}`,
            kind: signal?.aborted ? 'stopped' : transientReason(err) === 'rate limited' ? 'quota' : 'model',
          };
        }

        // ANY mode forces a function call, but it does not cap the count at
        // one. The first call is the step; anything after it is discarded.
        const fnCall = response.functionCalls?.[0];
        if (!fnCall) {
          corrections.push('You replied without calling a function. Call exactly one.');
          continue;
        }

        const { action, error } = validateAction(fnCall, { elementCount: state.map.length });
        if (action) return { action };

        corrections.push(`Your call to ${fnCall.name} was rejected: ${error}`);
      }

      return { error: `model produced no valid action in ${SCHEMA_RETRIES + 1} attempts: ${corrections.at(-1)}` };
    },
  };
}

function buildPrompt(task, state, history, corrections) {
  const parts = [
    `TASK: ${task}`,
    '',
    `CURRENT PAGE: ${state.title || '(untitled)'}`,
    `URL: ${state.url}`,
  ];

  if (state.pageText) {
    parts.push('', 'PAGE TEXT:', state.pageText);
  }

  parts.push(
    '',
    `ELEMENTS YOU CAN ACT ON (${state.map.length}):`,
    state.map.length ? state.text : '(none on screen — try scrolling)',
  );

  if (history.length) {
    parts.push('', 'WHAT YOU HAVE DONE SO FAR:', ...history);
  } else {
    parts.push('', 'This is your first step.');
  }

  if (corrections.length) {
    parts.push('', 'YOUR LAST ATTEMPT WAS INVALID:', ...corrections);
  }

  parts.push('', 'Call one function now.');
  return parts.join('\n');
}

// Free-tier 429s and capacity 503s both kill a run if they are not retried.
async function callWithBackoff(ai, model, request, backoffBaseMs, signal) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await ai.models.generateContent({ model, ...request });
    } catch (err) {
      const reason = transientReason(err);
      if (attempt >= TRANSIENT_RETRIES || !reason) throw err;

      const delay = Math.round(Math.min(backoffBaseMs * 2 ** attempt, BACKOFF_MAX_MS) * (1 + Math.random()));
      console.error(`  ${reason}, retrying in ${delay / 1000}s`);
      await sleep(delay, undefined, { signal });
    }
  }
}

// -> a short label to log, or null if the error is not worth retrying.
function transientReason(err) {
  // The SDK surfaces the status inconsistently depending on transport, so
  // check the places it shows up rather than one typed field.
  if (err?.name === 'AbortError') return null;
  const status = err?.status ?? err?.code ?? err?.response?.status;
  const message = String(err?.message ?? err);

  if (status === 429 || /RESOURCE_EXHAUSTED|rate limit|quota/i.test(message)) return 'rate limited';
  if (status === 503 || /UNAVAILABLE|high demand|overloaded/i.test(message)) return 'model busy';
  if (status === 500 || status === 502 || status === 504) return `server error ${status}`;
  return null;
}
