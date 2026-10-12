import assert from "node:assert/strict";
import test from "node:test";

import {
  elapsedMs,
  extractCompletionText,
  extractLlmDiagnostics,
  extractSessionDiagnostics,
  isTimeoutError,
  toSerializable,
} from "../src/record-utils.js";

test("extractCompletionText supports Anna completion response variants", () => {
  assert.equal(extractCompletionText("plain"), "plain");
  assert.equal(extractCompletionText({ text: "top-level" }), "top-level");
  assert.equal(extractCompletionText({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }), "ab");
  assert.equal(extractCompletionText({ message: { content: { type: "text", text: "nested" } } }), "nested");
});

test("extractLlmDiagnostics reads Anna completion metadata without exposing raw JSON", () => {
  const diagnostics = extractLlmDiagnostics({
    role: "assistant",
    content: { type: "text", text: "Hello!" },
    model: "google/gemini-3-flash-preview",
    stopReason: "endTurn",
    usage: { inputTokens: 1, outputTokens: 9, totalTokens: 10 },
    _meta: {
      provider: "openrouter",
      latencyMs: 1845,
      quotaConsumed: 0.023275862068965515,
      appSessionUuid: "aps_test",
    },
  });

  assert.deepEqual(diagnostics, {
    output_text: "Hello!",
    model: "google/gemini-3-flash-preview",
    stop_reason: "endTurn",
    token_usage: { inputTokens: 1, outputTokens: 9, totalTokens: 10 },
    provider: "openrouter",
    latency_ms: 1845,
    quota_consumed: 0.023275862068965515,
    app_session_uuid: "aps_test",
  });
});

test("extractLlmDiagnostics prefers persisted record fields and supports snake_case aliases", () => {
  const diagnostics = extractLlmDiagnostics({
    output_text: "已持久化的回复",
    response: {
      model_name: "model-from-response",
      token_usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
      stop_reason: "stop",
      meta: { provider: "provider-from-response", latency_ms: 12 },
    },
    response_metadata: {
      model: "model-from-metadata",
      provider: "provider-from-metadata",
      quota_consumed: 0.5,
    },
  });

  assert.equal(diagnostics.output_text, "已持久化的回复");
  assert.equal(diagnostics.model, "model-from-response");
  assert.deepEqual(diagnostics.token_usage, { input_tokens: 2, output_tokens: 3, total_tokens: 5 });
  assert.equal(diagnostics.provider, "provider-from-response");
  assert.equal(diagnostics.latency_ms, 12);
  assert.equal(diagnostics.quota_consumed, 0.5);
});

test("toSerializable preserves error fields and replaces circular references", () => {
  const error = new Error("failed");
  error.code = "E_TEST";
  const value = { error, bigint: 12n };
  value.self = value;

  const serialized = toSerializable(value);
  assert.equal(serialized.error.name, "Error");
  assert.equal(serialized.error.message, "failed");
  assert.equal(serialized.error.code, "E_TEST");
  assert.equal(serialized.bigint, "12n");
  assert.match(serialized.self, /^\[Circular /);
});

test("elapsedMs returns millisecond precision without negative values", () => {
  assert.equal(elapsedMs(10, 25.1234), 15.123);
  assert.equal(elapsedMs(25, 10), 0);
});

test("isTimeoutError recognizes common timeout messages", () => {
  assert.equal(isTimeoutError(new Error("Request timed out")), true);
  assert.equal(isTimeoutError(new Error("请求超时")), true);
  assert.equal(isTimeoutError(new Error("network failed")), false);
});

test("extractSessionDiagnostics groups tool calls and reads completion metadata", () => {
  const record = {
    output_text: "最终回复",
    stream_frames: [
      {
        received_at: "2026-08-17T06:05:50.000Z",
        envelope: {
          payload: {
            choices: [{ delta: { run_meta: { run_id: "run-1", model: "gpt-test" } } }],
          },
        },
      },
      {
        received_at: "2026-08-17T06:05:51.000Z",
        envelope: {
          payload: {
            choices: [{ delta: { tool_start: { id: "tool-1", name: "fs_write_file", input: { path: "/tmp/a" } } } }],
          },
        },
      },
      {
        received_at: "2026-08-17T06:05:52.000Z",
        envelope: {
          payload: {
            choices: [{ delta: { tool_end: { id: "tool-1", name: "fs_write_file", output: '{"success":true}' } } }],
          },
        },
      },
      {
        received_at: "2026-08-17T06:05:53.000Z",
        envelope: {
          payload: {
            choices: [{ delta: { task_complete: { status: "completed", token_usage: {
              total_prompt_tokens: 100,
              total_completion_tokens: 20,
              total_tokens: 120,
            } } } }],
          },
        },
      },
    ],
  };

  const diagnostics = extractSessionDiagnostics(record);
  assert.equal(diagnostics.model, "gpt-test");
  assert.equal(diagnostics.output_text, "最终回复");
  assert.equal(diagnostics.token_usage.total_tokens, 120);
  assert.deepEqual(diagnostics.tools, [{
    index: 0,
    id: "tool-1",
    name: "fs_write_file",
    status: "completed",
    input: { path: "/tmp/a" },
    output: '{"success":true}',
    started_at: "2026-08-17T06:05:51.000Z",
    ended_at: "2026-08-17T06:05:52.000Z",
  }]);
});

test("extractSessionDiagnostics falls back to streamed text and tool call chunks", () => {
  const diagnostics = extractSessionDiagnostics({
    stream_frames: [{
      elapsed_ms: 1234.5,
      received_at: "2026-08-17T06:00:01.234Z",
      envelope: {
        payload: {
          choices: [{ delta: {
            content: "回答",
            tool_calls: [{ id: "call-1", function: { name: "fs_read_file", arguments: '{"path":"/tmp/a"}' } }],
          } }],
        },
      },
    }],
  });

  assert.equal(diagnostics.output_text, "回答");
  assert.equal(diagnostics.first_text_ms, 1234.5);
  assert.equal(diagnostics.first_text_at, "2026-08-17T06:00:01.234Z");
  assert.equal(diagnostics.tools[0].name, "fs_read_file");
  assert.deepEqual(diagnostics.tools[0].input, { path: "/tmp/a" });
});

test("extractSessionDiagnostics does not duplicate streamed tool arguments when tool_start follows", () => {
  const diagnostics = extractSessionDiagnostics({
    stream_frames: [
      { envelope: { payload: { choices: [{ delta: { tool_calls: [{
        index: 0,
        id: "call-model-id",
        function: { name: "fs_write_file", arguments: "" },
      }] } }] } } },
      { envelope: { payload: { choices: [{ delta: { tool_calls: [{
        index: 0,
        id: null,
        function: { name: null, arguments: '{"path":"/tmp/a"}' },
      }] } }] } } },
      { envelope: { payload: { choices: [{ delta: { tool_start: {
        id: "runtime-exec-id",
        name: "fs_write_file",
        input: { path: "/tmp/a" },
      } } }] } } },
      { envelope: { payload: { choices: [{ delta: { tool_end: {
        id: "runtime-exec-id",
        name: "fs_write_file",
        output: "ok",
      } } }] } } },
    ],
  });

  assert.equal(diagnostics.tools.length, 1);
  assert.equal(diagnostics.tools[0].status, "completed");
});

test("extractSessionDiagnostics accepts a top-level run_meta frame", () => {
  const diagnostics = extractSessionDiagnostics({
    stream_frames: [{
      envelope: {
        payload: {
          event: "run_meta",
          model: "google/gemini-3.5-flash",
          inherit_host_tools: false,
          granted_tools: ["fs_read_file"],
        },
      },
    }],
  });

  assert.equal(diagnostics.model, "google/gemini-3.5-flash");
  assert.deepEqual(diagnostics.run_meta.granted_tools, ["fs_read_file"]);
});
