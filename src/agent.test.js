import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { runTask } from "./agent.js";

let browser;

before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });

const newPage = () => browser.newPage({ viewport: { width: 400, height: 300 } });

// A model that replays a fixed list of actions.
const scripted = (...actions) => {
  let i = 0;
  return { model: "fake", async chooseAction() { return { action: actions[i++] }; } };
};

const collect = (events) => (e) => events.push(e);

test("streams observe/action/result then done", async () => {
  const page = await newPage();
  const events = [];

  const run = await runTask({
    task: "t", page,
    llm: scripted({ name: "wait", reason: "settle" }, { name: "done", result: "42", reason: "found" }),
    onEvent: collect(events),
  });

  assert.equal(run.status, "done");
  assert.equal(run.result, "42");
  assert.deepEqual(events.map(e => e.type), ["observe", "action", "result", "observe", "action", "done"]);
});

test("emits gave_up with a reason at the step limit", async () => {
  const page = await newPage();
  const events = [];

  const run = await runTask({
    task: "t", page, maxSteps: 2,
    llm: scripted({ name: "wait", reason: "x" }, { name: "wait", reason: "x" }),
    onEvent: collect(events),
  });

  assert.equal(run.status, "gave_up");
  assert.equal(run.kind, "step_limit");
  assert.match(run.reason, /step limit reached \(2 steps\)/);
  assert.equal(events.at(-1).type, "gave_up");
  assert.equal(events.at(-1).kind, "step_limit");
});

test("passes the model's error kind through to gave_up", async () => {
  const page = await newPage();

  const run = await runTask({
    task: "t", page,
    llm: { model: "fake", async chooseAction() { return { error: "429 quota", kind: "quota" }; } },
  });

  assert.equal(run.kind, "quota");
  assert.equal(run.reason, "429 quota");
});

test("stops mid-run when the signal aborts", async () => {
  const page = await newPage();
  const events = [];
  const controller = new AbortController();
  let steps = 0;

  const run = await runTask({
    task: "t", page,
    llm: { model: "fake", async chooseAction() {
      if (++steps >= 2) controller.abort();
      return { action: { name: "wait", reason: "x" } };
    } },
    signal: controller.signal,
    onEvent: collect(events),
  });

  assert.equal(run.status, "gave_up");
  assert.equal(run.kind, "stopped");
  // Cancelled well before MAX_STEPS.
  assert.ok(steps <= 3, `ran ${steps} steps after stop`);
  assert.equal(events.at(-1).type, "gave_up");
});

test("abort cuts an in-flight model call short", async () => {
  const page = await newPage();
  const controller = new AbortController();

  // A model that never answers unless aborted.
  const hanging = { model: "fake", chooseAction: (_t, _s, _h, { signal }) => new Promise(resolve => {
    signal.addEventListener("abort", () => resolve({ error: "aborted", kind: "stopped" }));
  }) };

  setTimeout(() => controller.abort(), 50);
  const started = Date.now();
  const run = await runTask({ task: "t", page, llm: hanging, signal: controller.signal });

  assert.equal(run.kind, "stopped");
  assert.ok(Date.now() - started < 1000, "stop waited on the model");
});

test("attaches a screenshot to each observe only when asked", async () => {
  const page = await newPage();
  const withShots = [];
  const without = [];

  const llm = () => scripted({ name: "done", result: "r", reason: "x" });
  await page.goto("data:text/html,<h1>hello</h1>");

  await runTask({ task: "t", page, llm: llm(), screenshots: true, onEvent: collect(withShots) });
  await runTask({ task: "t", page, llm: llm(), onEvent: collect(without) });

  const shot = withShots.find(e => e.type === "observe").screenshot;
  assert.equal(typeof shot, "string");
  assert.ok(shot.length > 100, "screenshot looks empty");
  assert.equal(without.find(e => e.type === "observe").screenshot, undefined);
});

test("blocks navigation outside the allowlist and keeps going", async () => {
  const page = await newPage();
  const events = [];

  const run = await runTask({
    task: "t", page,
    llm: scripted(
      { name: "navigate", url: "https://example.com/", reason: "x" },
      { name: "done", result: "r", reason: "x" },
    ),
    onEvent: collect(events),
  });

  const blocked = events.find(e => e.type === "result");
  assert.equal(blocked.ok, false);
  assert.match(blocked.message, /not an allowed demo site/);
  // A blocked navigation is feedback, not a fatal error.
  assert.equal(run.status, "done");
});

test("skips the screenshot on the blank starting page", async () => {
  const page = await newPage();
  const events = [];

  await runTask({
    task: "t", page, screenshots: true,
    llm: scripted({ name: "done", result: "r", reason: "x" }),
    onEvent: collect(events),
  });

  assert.equal(events.find(e => e.type === "observe").screenshot, undefined);
});
