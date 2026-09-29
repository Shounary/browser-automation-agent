# Browser Automation Agent

Type a task in plain English. An agent drives a real Chromium browser to do it,
and you watch each step happen live — the page it sees, the action it picked, and
why.

<!-- TODO: record docs/demo.gif (a full Wikipedia run, ~15s) and uncomment
![demo](docs/demo.gif)
-->

```
"who was Ada Lovelace"
  step 0  about:blank              -> navigate https://en.wikipedia.org/wiki/Ada_Lovelace
  step 1  Ada Lovelace - Wikipedia -> done
  "Ada Lovelace (1815–1852) was an English mathematician and writer, chiefly
   known for her work on Charles Babbage's proposed mechanical general-purpose
   computer, the analytical engine. She was the first to recognize that the
   machine had applications beyond pure calculation..."
```

## The problem

An LLM cannot see a web page. It gets text. So the interesting question in
browser automation is not "how do I call Playwright" — it is **how do you
describe a page to a model so that its next click is the right one**, cheaply
enough to do fifteen times in a row.

That question is what this project is about. The three parts worth reading are
the [agent loop](src/agent.js), the [page grounding](src/page-extractor.js), and
the [streaming layer](src/server.js).

## The loop

```
   ┌─────────────────────────────────────────────────┐
   │                                                 │
observe ──> decide ──> execute ──> feed result back ─┘
   │          │           │
extract    Gemini     Playwright
elements   function     click/type/
as text      call       navigate
```

Every iteration re-reads the page from scratch. Element ids are numbered per
step and never reused across steps, because a page changes under the agent's
feet after every action — stale ids are the single biggest source of wrong
clicks in this kind of system.

One step, concretely:

1. **Observe** — `extractInteractiveElements(page)` returns a numbered list of
   what can be acted on, the page's readable text, its URL and title.
2. **Decide** — that state plus the task and the last 8 steps of history go to
   Gemini, with the action space as function declarations and tool choice forced
   to `ANY`, so exactly one action comes back.
3. **Execute** — `executeAction` runs it and returns `{ok, message}`, where the
   message is written *for the model*: `"scrolled down — this is the bottom of
   the page"`, `"no element with id 91 — this page has 71 (0–70)"`.
4. **Repeat** — that message becomes the next turn's history, so a failed action
   teaches the next decision instead of repeating itself.

### The action space

`navigate(url)` · `click(id)` · `type(id, text)` · `scroll(direction)` ·
`wait()` · `done(result)`

Every action carries a `reason` string, which is
what the timeline shows as the agent's thinking. Asking for prose *alongside* a
forced function call is unreliable, so the rationale is a parameter of the call
itself.


## Reliability

- **Hard step limit** (15) and **run timeout** (5 minutes), enforced in
  `runTask`.
- **Domain allowlist.** `navigate` only reaches wikipedia.org, saucedemo.com and
  news.ycombinator.com. A blocked navigation is not a crash: the model is told
  it was blocked and keeps going.
- **No credentialed logins, no CAPTCHA solving.** The saucedemo demo uses the
  credentials that site prints on its own login page. Bot detection exists to
  stop exactly this, and working around it is not a portfolio project.
- **Model fallback chain.** Google's free tier answers 429 and 503 under load
  often enough to kill a run, so the client walks a chain of six models
  (`gemini-3.8-flash` down to `gemini-2.5-flash-lite`), with jittered
  exponential backoff. Falling back is sticky within a run and reset between
  runs, so one bad minute doesn't pin every later run to the weakest model.
- **Schema validation by hand.** Gemini has no `strict` equivalent for function
  arguments, so `validateAction` coerces string ids to numbers, range-checks
  them against the element count, and rejects unknown actions — each with an
  error written for the model, which then gets two retries to fix its call.
- **Cancellation.** Stop aborts the in-flight model call
  through an `AbortSignal` (and interrupts a backoff sleep), so it takes ~40ms
  instead of waiting out the request.
- **Typed failures.** A run that ends badly reports *why* in a machine-readable
  `kind`, and the UI turns each one into a plain sentence instead of showing a
  stack trace:

  | kind | what the viewer sees |
  |---|---|
  | `stopped` | Stopped after N steps |
  | `step_limit` | Ran out of steps — try a more specific task |
  | `timeout` | Timed out |
  | `quota` | Model quota used up — the free tier resets daily |
  | `model` | Model error |
  | `crash` | Something broke |
  | `disconnected` | Lost connection — the UI reconnects on its own |

## Streaming

WebSocket, not SSE, because the client needs to talk back: Stop is a message
from the browser. One run per connection.

```
client -> { type: 'start', task } | { type: 'stop' }
server -> status | observe | action | result | done | gave_up
```

Each `observe` carries a base64 JPEG of the page (quality 55, ~110KB for a real
page), which is the live view. The frontend strips screenshots out of the events
before they land in timeline state, and skips the capture entirely while the
page is still `about:blank`, so the first frame the viewer sees is a real page.

## Stack

| Layer | Choice |
|---|---|
| Frontend | Next.js 16 (App Router), React 19, plain CSS |
| Backend | Node 24 (ESM), Playwright, `ws` |
| LLM | Gemini via `@google/genai`, function calling, `temperature: 0` |
| Tests | `node --test`, playwright pages, scripted fake model |


## Running it

Needs Node 20.12+ (for `process.loadEnvFile`) and a free Gemini API key from
[aistudio.google.com](https://aistudio.google.com/apikey).

```sh
npm install
npx playwright install chromium
echo 'GEMINI_API_KEY=your-key' > .env

node src/server.js          # agent + WebSocket on :3001
cd web && npm install && npm run dev   # UI on :3000
```

Then open <http://localhost:3000>, pick one of the three example tasks, and
press Start.

Without the UI:

```sh
HEADED=1 node src/run.js "what is the top story on Hacker News right now"
```

`HEADED=1` shows the browser. `GEMINI_MODEL` overrides the fallback chain
(comma-separated). `AGENT_WS` points the frontend at a different backend.

## Tests

```sh
npm test    # 37 tests
```

The agent tests drive a **real** Playwright page with a **scripted fake model**,
so the loop, the cancellation path, the step limit and the allowlist are all
covered without spending a single API call. The Gemini client is tested against
a fake that returns 429s and 503s on demand, which is how the fallback chain and
the abort path are verified.

## Known limits

- **Curated sites only**, by design. Working on an arbitrary site is a research
  problem.
- **Free-tier quota is about ten runs a day.** A public deployment needs a paid
  key with a cap and a per-visitor rate limit.
- **Vision mode is not implemented** — see the writeup above.
- **SIGTERM doesn't stop the backend mid-run.** Playwright installs its own
  handler that closes Chromium without exiting the process, which matters for a
  host that redeploys by sending SIGTERM.
