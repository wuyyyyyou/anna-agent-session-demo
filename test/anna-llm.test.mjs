import assert from "node:assert/strict";
import test from "node:test";

import { buildLlmInput, invokeAnnaLlm, selectLlmInvocationPath } from "../src/anna-llm.js";

test("buildLlmInput omits an empty system prompt", () => {
  assert.deepEqual(buildLlmInput("", "hello"), {
    messages: [{ role: "user", content: { type: "text", text: "hello" } }],
  });
  assert.equal(buildLlmInput("system", "hello").messages[0].role, "system");
});

test("invokeAnnaLlm prefers runtime.call and forwards timeoutMs", async () => {
  let received;
  const runtime = {
    call: async (...args) => {
      received = args;
      return { text: "ok" };
    },
    llm: { complete: async () => { throw new Error("fallback should not run"); } },
  };
  const input = buildLlmInput("", "hello");
  const result = await invokeAnnaLlm(runtime, input, 120_000);
  assert.equal(result.invocationPath, "runtime.call");
  assert.equal(result.timeoutAppliedByRuntime, true);
  assert.deepEqual(received, ["llm", "complete", input, { timeoutMs: 120_000 }]);
});

test("invokeAnnaLlm falls back without applying a frontend timeout", async () => {
  const runtime = { llm: { complete: async (input) => ({ input }) } };
  const result = await invokeAnnaLlm(runtime, { messages: [] }, 600_000);
  assert.equal(selectLlmInvocationPath(runtime), "runtime.llm.complete");
  assert.equal(result.invocationPath, "runtime.llm.complete");
  assert.equal(result.timeoutAppliedByRuntime, false);
});

test("LLM images use MCP image blocks and records omit the image bytes", async () => {
  const { readLlmImage, summarizeLlmInput } = await import("../src/anna-llm.js");
  const file = { name: "slide.png", type: "image/png", size: 8 };
  const content = await readLlmImage(file, () => ({
    readAsDataURL() {
      this.result = "data:image/png;base64,aW1hZ2U=";
      this.onload();
    },
  }));
  const input = buildLlmInput("system", "compare", [
    { file, status: "ready", content },
    { file: { ...file, name: "second.png" }, status: "ready", content },
  ]);
  assert.deepEqual(input.messages.map((message) => message.content.type), ["text", "text", "image", "image"]);
  assert.deepEqual(input.messages[2], { role: "user", content: { type: "image", data: "aW1hZ2U=", mimeType: "image/png" } });
  assert.ok(!JSON.stringify(summarizeLlmInput(input)).includes("aW1hZ2U="));
  assert.equal(input.messages[2].content.data, "aW1hZ2U=");
  let received;
  await invokeAnnaLlm({ call: async (...args) => { received = args; } }, input, 120_000);
  assert.deepEqual(received[2], input);
});

test("LLM images reject unreadable, unfinished, unsupported and excessive selections", async () => {
  const { readLlmImage } = await import("../src/anna-llm.js");
  const file = { name: "slide.png", type: "image/png", size: 8 };
  await assert.rejects(readLlmImage(file, () => ({ readAsDataURL() { this.onerror(); } })), /could not read the image/);
  await assert.rejects(readLlmImage(file, () => ({ readAsDataURL() { this.onabort(); } })), /cancelled/);
  await assert.rejects(readLlmImage(file, () => ({ readAsDataURL() { this.result = ""; this.onload(); } })), /could not read image data/);
  assert.throws(() => buildLlmInput("", "hello", [{ file, status: "failed" }]), /finish reading/);
  assert.throws(() => buildLlmInput("", "hello", Array(7).fill({ file })), /at most/);
  assert.throws(() => buildLlmInput("", "hello", [{ file: { ...file, type: "application/pdf" } }]), /supported/);
});
