import { test } from "node:test";
import assert from "node:assert/strict";
import { createGeminiClient } from "./llm-gemini.js";

const STATE = { map: [{ line: '[0] button "Go"' }], text: '[0] button "Go"', url: "https://x/", title: "X", pageText: "" };

// Minimal stand-in for GoogleGenAI. `behaviour` maps model -> what to do.
function fakeClient(behaviour, log = []) {
  return {
    models: {
      async generateContent({ model, config }) {
        log.push(model);
        const act = behaviour[model];
        if (act === "ok") {
          return { functionCalls: [{ name: "click", args: { id: 0, reason: "r" } }] };
        }
        // Like the real SDK: only the abort signal can end it.
        if (act === "hang") return new Promise((_, reject) => {
          config.abortSignal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        });
        const message = act === 503 ? "high demand" : act === 429 ? "quota exceeded" : `model ${model} not found`;
        throw Object.assign(new Error(message), { status: act });
      },
    },
  };
}

const opts = (behaviour, log) => ({
  models: ["busy-model", "spare-model"],
  client: fakeClient(behaviour, log),
  backoffBaseMs: 1,
});

test("falls back to the next model when the first is unavailable", async () => {
  const log = [];
  const llm = createGeminiClient(opts({ "busy-model": 503, "spare-model": "ok" }, log));

  const { action } = await llm.chooseAction("task", STATE, []);

  assert.deepEqual(action, { name: "click", id: 0, reason: "r" });
  assert.ok(log.includes("spare-model"), "never reached the fallback");
  assert.equal(llm.model, "spare-model");
});

test("stays on the fallback for the rest of the run", async () => {
  const log = [];
  const llm = createGeminiClient(opts({ "busy-model": 503, "spare-model": "ok" }, log));

  await llm.chooseAction("task", STATE, []);
  const firstRunLength = log.length;
  await llm.chooseAction("task", STATE, []);

  // The second step must not re-try the busy model.
  assert.deepEqual(log.slice(firstRunLength), ["spare-model"]);
});

test("gives up with a message, not a throw, when the whole chain is down", async () => {
  const llm = createGeminiClient(opts({ "busy-model": 503, "spare-model": 503 }));

  const { action, error } = await llm.chooseAction("task", STATE, []);

  assert.equal(action, undefined);
  assert.match(error, /spare-model unreachable/);
});

test("does not fall back on a non-transient error", async () => {
  const log = [];
  const llm = createGeminiClient(opts({ "busy-model": 404, "spare-model": "ok" }, log));

  const { error } = await llm.chooseAction("task", STATE, []);

  // A bad model name should surface, not be papered over by the fallback.
  assert.match(error, /busy-model unreachable/);
  assert.ok(!log.includes("spare-model"), "fell back on a non-transient error");
});

test("labels an exhausted chain of 429s as quota", async () => {
  const llm = createGeminiClient(opts({ "busy-model": 429, "spare-model": 429 }));

  const { kind } = await llm.chooseAction("task", STATE, []);

  assert.equal(kind, "quota");
});

test("labels other failures as model errors", async () => {
  const llm = createGeminiClient(opts({ "busy-model": 404 }));

  const { kind } = await llm.chooseAction("task", STATE, []);

  assert.equal(kind, "model");
});

test("an abort during backoff returns promptly as stopped", async () => {
  const log = [];
  // Long backoff, so only the abort can end this quickly.
  const llm = createGeminiClient({ ...opts({ "busy-model": 503, "spare-model": "ok" }, log), backoffBaseMs: 60_000 });
  const controller = new AbortController();

  setTimeout(() => controller.abort(), 50);
  const started = Date.now();
  const { kind } = await llm.chooseAction("task", STATE, [], { signal: controller.signal });

  assert.equal(kind, "stopped");
  assert.ok(Date.now() - started < 1000, "abort waited out the backoff");
  assert.ok(!log.includes("spare-model"), "fell back after an abort");
});

test("an abort cancels the in-flight request", async () => {
  const llm = createGeminiClient(opts({ "busy-model": "hang" }));
  const controller = new AbortController();

  setTimeout(() => controller.abort(), 50);
  const { kind } = await llm.chooseAction("task", STATE, [], { signal: controller.signal });

  assert.equal(kind, "stopped");
});
