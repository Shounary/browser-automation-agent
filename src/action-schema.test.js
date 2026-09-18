import { test } from "node:test";
import assert from "node:assert/strict";
import { ACTION_DECLARATIONS, ACTION_NAMES, validateAction } from "./action-schema.js";

// Gemini has no strict-schema mode, so these arguments arrive unvalidated.
// Everything here is a shape the model has a real chance of producing.
const on = (count) => ({ elementCount: count });

test("declares exactly the six actions in the spec", () => {
  assert.deepEqual(ACTION_NAMES, ["navigate", "click", "type", "scroll", "wait", "done"]);
});

test("every declaration requires a reason, for the timeline", () => {
  for (const d of ACTION_DECLARATIONS) {
    assert.ok(d.parameters.properties.reason, `${d.name} has no reason property`);
    assert.ok(d.parameters.required.includes("reason"), `${d.name} does not require reason`);
  }
});

test("coerces a string id to an integer", () => {
  const { action } = validateAction({ name: "click", args: { id: "3", reason: "r" } }, on(10));
  assert.deepEqual(action, { name: "click", id: 3, reason: "r" });
});

test("rejects an out-of-range id and names the valid range", () => {
  const { action, error } = validateAction({ name: "click", args: { id: 99, reason: "r" } }, on(10));
  assert.equal(action, undefined);
  assert.match(error, /no element with id 99.*10.*0–9/);
});

test("rejects a non-numeric id rather than coercing it to NaN", () => {
  const { error } = validateAction({ name: "type", args: { id: "the search box", text: "x", reason: "r" } }, on(10));
  assert.match(error, /no element with id/);
});

test("accepts scroll direction case-insensitively but rejects invented ones", () => {
  assert.equal(validateAction({ name: "scroll", args: { direction: "DOWN", reason: "r" } }, on(3)).action.direction, "down");

  const { error } = validateAction({ name: "scroll", args: { direction: "bottom", reason: "r" } }, on(3));
  assert.match(error, /must be "up" or "down"/);
});

test("rejects done with no result — the result is the whole point", () => {
  const { error } = validateAction({ name: "done", args: { reason: "r" } }, on(3));
  assert.match(error, /needs a "result" string/);
});

test("rejects an action outside the space and lists the real ones", () => {
  const { error } = validateAction({ name: "press_enter", args: {} }, on(3));
  assert.match(error, /unknown action "press_enter"/);
  assert.match(error, /navigate, click, type, scroll, wait, done/);
});

test("supplies a placeholder when the model omits the reason", () => {
  const { action } = validateAction({ name: "wait", args: {} }, on(3));
  assert.deepEqual(action, { name: "wait", reason: "(none given)" });
});
