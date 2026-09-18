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
  assert.match(run.reason, /step limit reached \(2 steps\)/);
  assert.equal(events.at(-1).type, "gave_up");
});

test("stops mid-run when isCancelled goes true", async () => {
  const page = await newPage();
  const events = [];
  let steps = 0;

  const run = await runTask({
    task: "t", page,
    llm: { model: "fake", async chooseAction() { steps++; return { action: { name: "wait", reason: "x" } }; } },
    isCancelled: () => steps >= 2,
    onEvent: collect(events),
  });

  assert.equal(run.status, "gave_up");
  assert.equal(run.reason, "stopped");
  // Cancelled well before MAX_STEPS.
  assert.ok(steps <= 3, `ran ${steps} steps after stop`);
  assert.equal(events.at(-1).type, "gave_up");
});

test("attaches a screenshot to each observe only when asked", async () => {
  const page = await newPage();
  const withShots = [];
  const without = [];

  const llm = () => scripted({ name: "done", result: "r", reason: "x" });

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
