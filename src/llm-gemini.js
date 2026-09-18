// chooseAction(task, state, history) -> { action } | { error }
//
// One stateless call per step. The conversation is rebuilt from scratch every
// time, because element ids are only valid for the step they were extracted
// in — replaying old turns would invite the model to reuse dead ids.
//
// Nothing Gemini-shaped escapes this file. `action` is the plain object that
// page-actions.js already understands, so swapping providers is a one-file job.

import { GoogleGenAI, FunctionCallingConfigMode } from '@google/genai';
import { ACTION_DECLARATIONS, ACTION_NAMES, validateAction } from './action-schema.js';

const DEFAULT_MODEL = process.env.GEMINI_MODEL ?? 'gemini-3.8-flash';
const SCHEMA_RETRIES = 2;     // malformed arguments
const TRANSIENT_RETRIES = 5;  // free-tier RPM, and capacity 503s
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

export function createGeminiClient({ model = DEFAULT_MODEL, apiKey } = {}) {
  if (!apiKey && !process.env.GEMINI_API_KEY && !process.env.GOOGLE_API_KEY) {
    throw new Error(
      'No Gemini API key. Get a free one at https://aistudio.google.com/apikey ' +
      'and run: export GEMINI_API_KEY="..."'
    );
  }

  const ai = new GoogleGenAI(apiKey ? { apiKey } : {});

  return {
    model,

    async chooseAction(task, state, history) {
      const corrections = [];

      for (let attempt = 0; attempt <= SCHEMA_RETRIES; attempt++) {
        let response;
        try {
          response = await callWithBackoff(ai, model, {
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
            },
          });
        } catch (err) {
          // Out of retries, or something not worth retrying. The run ends
          // with a message instead of a stack trace.
          return { error: `${model} unreachable: ${String(err?.message ?? err).slice(0, 200)}` };
        }

        // ANY mode forces a function call, but it does not cap the count at
        // one. The first call is the step; anything after it is discarded.
        const call = response.functionCalls?.[0];
        if (!call) {
          corrections.push('You replied without calling a function. Call exactly one.');
          continue;
        }

        const { action, error } = validateAction(call, { elementCount: state.map.length });
        if (action) return { action };

        corrections.push(`Your call to ${call.name} was rejected: ${error}`);
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

// The free tier is rate limited per minute, and a 15-step run is 15 calls in
// under a minute. Free-tier capacity also returns 503 under load. Either one
// kills a demo mid-run if it is not retried.
async function callWithBackoff(ai, model, request) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await ai.models.generateContent({ model, ...request });
    } catch (err) {
      const reason = transientReason(err);
      if (attempt >= TRANSIENT_RETRIES || !reason) throw err;

      const delay = Math.round(Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS) * (1 + Math.random()));
      console.error(`  ${reason}, retrying in ${delay / 1000}s`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

// -> a short label to log, or null if the error is not worth retrying.
function transientReason(err) {
  // The SDK surfaces the status inconsistently depending on transport, so
  // check the places it shows up rather than one typed field.
  const status = err?.status ?? err?.code ?? err?.response?.status;
  const message = String(err?.message ?? err);

  if (status === 429 || /RESOURCE_EXHAUSTED|rate limit|quota/i.test(message)) return 'rate limited';
  if (status === 503 || /UNAVAILABLE|high demand|overloaded/i.test(message)) return 'model busy';
  if (status === 500 || status === 502 || status === 504) return `server error ${status}`;
  return null;
}
