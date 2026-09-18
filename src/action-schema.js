// The action space as Gemini function declarations
//
// Gemini has no strict-schema mode (the Anthropic API's `strict: true`), everything that
// crosses this boundary is checked by hand in `validateAction`.

import { Type } from '@google/genai';

const MAX_RESULT_LEN = 1200;

// Every action carries a `reason`
const reason = {
  type: Type.STRING,
  description: 'One short sentence: why this action, in service of the task.',
};

export const ACTION_DECLARATIONS = [
  {
    name: 'navigate',
    description:
      'Load a URL. Call this to start the task, or to jump straight to a page ' +
      'you already know the address of. Only the allowed demo sites will load.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        url: { type: Type.STRING, description: 'Absolute URL, including https://' },
        reason,
      },
      required: ['url', 'reason'],
    },
  },
  {
    name: 'click',
    description:
      'Click one element from the numbered list of the current page. Call this ' +
      'to follow a link, submit a form, or open a section.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        id: { type: Type.INTEGER, description: 'The [n] id of the element, from this step\'s list' },
        reason,
      },
      required: ['id', 'reason'],
    },
  },
  {
    name: 'type',
    description:
      'Type text into an input or textarea from the numbered list. Replaces any ' +
      'existing content. Typing does not submit — click the search or submit ' +
      'button afterwards.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        id: { type: Type.INTEGER, description: 'The [n] id of the input, from this step\'s list' },
        text: { type: Type.STRING, description: 'The text to enter' },
        reason,
      },
      required: ['id', 'text', 'reason'],
    },
  },
  {
    name: 'scroll',
    description:
      'Scroll the page by about one screen. Call this when what you need is ' +
      'probably further down the page — only elements currently on screen are listed.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        direction: { type: Type.STRING, enum: ['up', 'down'], description: 'up or down' },
        reason,
      },
      required: ['direction', 'reason'],
    },
  },
  {
    name: 'wait',
    description:
      'Pause about a second for the page to settle. Call this only when the page ' +
      'looks mid-load; it is never the way to make progress on the task itself.',
    parameters: {
      type: Type.OBJECT,
      properties: { reason },
      required: ['reason'],
    },
  },
  {
    name: 'done',
    description:
      'End the run. Call this as soon as the page shows the answer, or when the ' +
      'task is clearly impossible from here. Put the actual answer in `result` — ' +
      'the user sees only that, not the page.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        result: {
          type: Type.STRING,
          description: 'The answer to the task, or why it could not be completed',
        },
        reason,
      },
      required: ['result', 'reason'],
    },
  },
];

export const ACTION_NAMES = ACTION_DECLARATIONS.map(d => d.name);

// -> { action } | { error }   — `error` is phrased for the model, and goes
// back to it as the result of the step.
export function validateAction(call, { elementCount }) {
  const name = call?.name;
  const args = call?.args ?? {};
  const reason = str(args.reason) || '(none given)';

  switch (name) {
    case 'navigate': {
      const url = str(args.url);
      if (!url) return { error: 'navigate needs a "url" string' };
      return { action: { name, url, reason } };
    }

    case 'click': {
      const id = asId(args.id, elementCount);
      if (id.error) return id;
      return { action: { name, id: id.value, reason } };
    }

    case 'type': {
      const id = asId(args.id, elementCount);
      if (id.error) return id;
      const text = str(args.text);
      if (text === null) return { error: 'type needs a "text" string' };
      return { action: { name, id: id.value, text, reason } };
    }

    case 'scroll': {
      const direction = str(args.direction)?.toLowerCase();
      if (direction !== 'up' && direction !== 'down') {
        return { error: `scroll direction must be "up" or "down", got ${JSON.stringify(args.direction)}` };
      }
      return { action: { name, direction, reason } };
    }

    case 'wait':
      return { action: { name, reason } };

    case 'done': {
      const result = str(args.result);
      if (!result) return { error: 'done needs a "result" string — the answer to the task' };
      return { action: { name, result: result.slice(0, MAX_RESULT_LEN), reason } };
    }

    default:
      return { error: `unknown action "${name}" — use one of: ${ACTION_NAMES.join(', ')}` };
  }
}

// Gemini returns ids as numbers most of the time and as strings sometimes.
function asId(raw, elementCount) {
  const n = typeof raw === 'string' ? Number(raw.trim()) : raw;
  const range = elementCount ? `0–${elementCount - 1}` : 'none';

  if (!Number.isInteger(n) || n < 0 || n >= elementCount) {
    return { error: `no element with id ${JSON.stringify(raw)} — this page has ${elementCount} (${range})` };
  }
  return { value: n };
}

function str(v) {
  if (typeof v !== 'string') return v == null ? null : String(v);
  return v.trim();
}
