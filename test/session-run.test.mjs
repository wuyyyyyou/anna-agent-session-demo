import assert from "node:assert/strict";
import test from "node:test";
import { classifySessionFrames, recordSessionRun } from "../src/session-run.js";
import { extractSessionDiagnostics } from "../src/record-utils.js";

const textFrame = (text) => ({ event: "sse", choices: [{ delta: { content: text } }] });
const taskFrame = (value) => ({ event: "sse", choices: [{ delta: { task_complete: value } }] });
const end = { event: "end", run_id: "run-1" };
const envelope = (seq, payload, done = false, stream_id = "strm_1") => ({ stream_id, seq, payload, done });

function scenario({ payloads, early = [], realtime = [], errorAfter, streamId = "strm_1" }) {
  let listener;
  let unsubscriptions = 0;
  const runtime = {
    on(kind, callback) {
      assert.equal(kind, "rpc.stream");
      listener = callback;
      return () => { unsubscriptions += 1; listener = null; };
    },
  };
  const session = {
    run(request) {
      assert.equal(request.run_id, "run-1");
      for (const frame of early) listener(frame);
      const stream = {
        streamId: null, runId: request.run_id,
        async *[Symbol.asyncIterator]() {
          stream.streamId = streamId;
          for (const frame of realtime) listener(frame);
          for (const payload of payloads) yield payload;
          if (errorAfter) throw errorAfter;
        },
      };
      return stream;
    },
  };
  const record = { events: [] };
  return {
    record,
    run: () => recordSessionRun({ runtime, session, request: { run_id: "run-1", content: "hello" }, record, startedPerf: performance.now() }),
    unsubscriptions: () => unsubscriptions,
  };
}

test("uses SDK delivery order for text and retains original realtime arrival order", async () => {
  const a = textFrame("你");
  const b = textFrame("好");
  const completed = taskFrame({ status: "completed", model: "actual-model", token_usage: { total_tokens: 8 } });
  const run = scenario({
    early: [envelope(1, a), envelope(1, textFrame("other stream"), false, "strm_other")],
    realtime: [envelope(3, completed), envelope(2, b), envelope(4, end, true)],
    payloads: [a, b, completed, end],
  });
  assert.equal((await run.run()).status, "succeeded");
  assert.equal(run.record.output_text, "你好");
  assert.deepEqual(run.record.stream_frames.map((frame) => frame.envelope.seq), [1, 3, 2, 4]);
  assert.equal(run.record.sdk_frames.length, 4);
  assert.equal(run.record.iterator_finished, true);
  assert.equal(run.record.terminal_frame_received, true);
  assert.equal(run.unsubscriptions(), 1);
  const diagnostics = extractSessionDiagnostics(run.record);
  assert.equal(diagnostics.model, "actual-model");
  assert.equal(diagnostics.token_usage.total_tokens, 8);
});

test("retains error details, partial text and the terminal frame after an error", async () => {
  const payloads = [textFrame("partial"), { event: "error", code: "APP_QUOTA_EXCEEDED", message: "quota", details: { remaining: 0 } }, end];
  const run = scenario({ payloads, realtime: payloads.map((payload, index) => envelope(index + 1, payload, payload === end)) });
  const outcome = await run.run();
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.error.code, "APP_QUOTA_EXCEEDED");
  assert.equal(outcome.error.details.remaining, 0);
  assert.equal(run.record.output_text, "partial");
  assert.equal(run.record.stream_frames.at(-1).envelope.payload.event, "end");
  assert.equal(run.record.sdk_frames.at(-1).payload.event, "end");
});

test("handles initial RPC rejection delivered by the SDK as an error payload", async () => {
  const run = scenario({ streamId: null, payloads: [{ event: "error", code: "permission_denied", message: "denied" }] });
  assert.equal((await run.run()).status, "failed");
  assert.equal(run.record.iterator_finished, true);
  assert.equal(run.record.terminal_frame_received, false);
  assert.equal(run.record.stream_frames.length, 0);
  assert.equal(run.unsubscriptions(), 1);
});

test("keeps SDK recovery payloads without inventing realtime envelopes", async () => {
  const run = scenario({ payloads: [textFrame("recovered"), taskFrame({ status: "completed" }), end] });
  assert.equal((await run.run()).status, "succeeded");
  assert.equal(run.record.output_text, "recovered");
  assert.equal(run.record.stream_frames.length, 0);
  assert.equal(run.record.sdk_frames.length, 3);
  assert.equal(run.record.metrics.first_frame_ms, null);
  assert.ok(run.record.metrics.first_sdk_frame_ms >= 0);
});

test("keeps partial output and unsubscribes when the iterator throws", async () => {
  const run = scenario({ payloads: [textFrame("partial")], errorAfter: new Error("disconnected") });
  await assert.rejects(run.run(), /disconnected/);
  assert.equal(run.record.output_text, "partial");
  assert.equal(run.record.iterator_finished, false);
  assert.equal(run.unsubscriptions(), 1);
});

test("requires task evidence rather than inferring success from transport end", () => {
  assert.equal(classifySessionFrames([end]).status, "unknown");
  assert.equal(classifySessionFrames([taskFrame({ status: "failed", error: { code: "E_TASK" } }), end]).status, "failed");
  assert.equal(classifySessionFrames([taskFrame({ status: "completed" }), end]).status, "succeeded");
});

test("cancellation acknowledgement alone does not override actual task completion", async () => {
  const run = scenario({ payloads: [taskFrame({ status: "completed" }), end] });
  run.record.cancel_requested = true;
  assert.equal((await run.run()).status, "succeeded");
  assert.equal(classifySessionFrames([{ event: "sse", choices: [{ delta: { task_cancelled: { run_id: "run-1" } } }] }, end]).status, "cancelled");
  assert.equal(classifySessionFrames([{ event: "complete", aborted: true }]).status, "cancelled");
});

test("business errors and unknown frame kinds do not become protocol failures", () => {
  const tool = { event: "sse", choices: [{ delta: { tool_end: { output: { task_complete: { status: "failed" }, error: "business data" } } } }] };
  assert.equal(classifySessionFrames([tool, { event: "future", choices: {} }, taskFrame({ status: "completed" }), end]).status, "succeeded");
});
