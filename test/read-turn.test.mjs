import assert from "node:assert/strict";
import test from "node:test";
import { readTurn } from "../src/read-turn.js";

function stream(frames) {
  return {
    runId: "run-1",
    streamId: "stream-1",
    async *[Symbol.asyncIterator]() { yield* frames; },
  };
}

test("tutorial helper streams text and tool progress while checking the task result", async () => {
  const text = [];
  const tools = [];
  const result = await readTurn(stream([
    { event: "run_meta", model: "test-model" },
    { event: "sse", choices: [{ delta: { content: "Hello " } }] },
    { event: "sse", choices: [{ delta: { tool_start: { id: "tool-1", name: "web_search" } } }] },
    { event: "sse", choices: [{ delta: { tool_end: { id: "tool-1", output: "{}" }, content: "world" } }] },
    { event: "sse", choices: [{ delta: { task_complete: { status: "completed" } } }] },
    { event: "end" },
  ]), {
    onText: (_chunk, fullText) => text.push(fullText),
    onMeta: (meta) => assert.equal(meta.model, "test-model"),
    onToolStart: (tool) => tools.push(["start", tool.id]),
    onToolEnd: (tool) => tools.push(["end", tool.id]),
  });
  assert.deepEqual(text, ["Hello ", "Hello world"]);
  assert.deepEqual(tools, [["start", "tool-1"], ["end", "tool-1"]]);
  assert.deepEqual(result, { text: "Hello world", status: "succeeded", error: null, runId: "run-1", streamId: "stream-1" });
});

test("tutorial helper retains partial text and does not infer success from an ended stream", async () => {
  const partial = { event: "sse", choices: [{ delta: { content: "Partial answer" } }] };
  const failed = await readTurn(stream([partial, { event: "error", code: "test_error", message: "Failed" }, { event: "end" }]));
  assert.equal(failed.status, "failed");
  assert.equal(failed.text, "Partial answer");
  assert.equal(failed.error.code, "test_error");
  const unknown = await readTurn(stream([partial, { event: "end" }]));
  assert.equal(unknown.status, "unknown");
});
