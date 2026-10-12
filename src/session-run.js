import { elapsedMs, nowIso, toSerializable } from "./record-utils.js";

export function extractSessionFrameText(frame) {
  if (!frame || typeof frame !== "object") return "";
  if (Array.isArray(frame.choices)) {
    return frame.choices.map((choice) => {
      const delta = choice?.delta || {};
      return [delta.content, delta.text].filter((value) => typeof value === "string").join("");
    }).join("");
  }
  if (["model_token", "token", "delta"].includes(frame.event)) {
    return [frame.text, frame.content, frame.delta].find((value) => typeof value === "string") || "";
  }
  return "";
}

// Only inspect protocol fields, not arbitrary tool outputs that may contain
// business fields named "error", "status", or "task_complete".
function taskSignals(frame) {
  const choices = Array.isArray(frame?.choices) ? frame.choices : [];
  const values = [frame, ...choices.map((choice) => choice?.delta)].filter(Boolean);
  return values.flatMap((value) => [
    ...(value.task_complete ? [{ kind: "complete", value: value.task_complete }] : []),
    ...(value.task_cancelled ? [{ kind: "cancelled", value: value.task_cancelled }] : []),
    ...(["task_complete", "complete"].includes(value.event) ? [{ kind: "complete", value }] : []),
    ...(value.event === "task_cancelled" ? [{ kind: "cancelled", value }] : []),
  ]);
}

export function classifySessionFrames(frames) {
  let completed = false;
  let cancelled = false;
  let error = null;
  for (const frame of frames) {
    if (frame?.event === "error") error = toSerializable(frame);
    for (const signal of taskSignals(frame)) {
      const value = signal.value;
      const status = value?.status;
      if (signal.kind === "cancelled" || value?.aborted === true || value?.cancelled === true
        || ["cancelled", "canceled", "aborted"].includes(status)) {
        cancelled = true;
      } else if (value?.error || ["failed", "error"].includes(status)) {
        error = toSerializable(value.error || { message: "Agent run failed", ...value });
      } else if (status == null || ["completed", "succeeded", "success"].includes(status)) {
        completed = true;
      }
    }
  }
  return { status: error ? "failed" : cancelled ? "cancelled" : completed ? "succeeded" : "unknown", error };
}

/**
 * Run through the SDK's ordered iterator while independently recording the
 * Runtime envelopes. SDK recovery payloads are kept in sdk_frames; they are
 * never presented as raw realtime envelopes. An error does not stop capture:
 * consume the iterator through its terminal frame to retain the whole trace.
 */
export async function recordSessionRun({ runtime, session, request, record, startedPerf, onChange = () => {} }) {
  record.stream_frames = [];
  record.sdk_frames = [];
  record.output_text = "";
  record.run_id = request.run_id || "";
  record.stream_id = "";
  record.iterator_finished = false;
  record.terminal_frame_received = false;
  record.metrics = {
    first_frame_ms: null, first_frame_at: null, first_sdk_frame_ms: null,
    first_text_ms: null, first_text_at: null, stream_complete_ms: null,
    frame_count: 0, sdk_frame_count: 0, max_frame_gap_ms: 0,
  };
  record.events ||= [];
  let stream;
  let lastFramePerf = null;
  const earlyFrames = [];
  const note = (event, detail = {}) => record.events.push({ event, at: nowIso(), elapsed_ms: elapsedMs(startedPerf), ...detail });

  function capture(captured) {
    const { envelope, receivedAt, receivedPerf } = captured;
    if (envelope.stream_id !== record.stream_id) return;
    const gap = lastFramePerf == null ? null : elapsedMs(lastFramePerf, receivedPerf);
    lastFramePerf = receivedPerf;
    record.stream_frames.push({
      index: record.stream_frames.length, received_at: receivedAt,
      elapsed_ms: elapsedMs(startedPerf, receivedPerf), gap_ms: gap,
      envelope: toSerializable(envelope),
    });
    record.metrics.frame_count = record.stream_frames.length;
    if (record.metrics.first_frame_ms == null) {
      record.metrics.first_frame_ms = elapsedMs(startedPerf, receivedPerf);
      record.metrics.first_frame_at = receivedAt;
    }
    if (gap != null) record.metrics.max_frame_gap_ms = Math.max(record.metrics.max_frame_gap_ms, gap);
    if (envelope.done === true) record.terminal_frame_received = true;
    note("session.run.stream_frame", { seq: envelope.seq, done: envelope.done === true });
    onChange();
  }

  function syncHandle() {
    if (stream?.runId) record.run_id = stream.runId;
    if (!stream?.streamId) return;
    record.stream_id = stream.streamId;
    // These are public handle fields, not a captured raw RPC response.
    record.response = { sdk_stream: { stream_id: record.stream_id, run_id: record.run_id } };
    for (const captured of earlyFrames.splice(0)) capture(captured);
  }

  const unsubscribe = runtime.on("rpc.stream", (envelope) => {
    if (!envelope || typeof envelope !== "object") return;
    const captured = { envelope: toSerializable(envelope), receivedAt: nowIso(), receivedPerf: performance.now() };
    syncHandle();
    if (!record.stream_id) earlyFrames.push(captured);
    else capture(captured);
  });
  try {
    // AgentSession.run returns immediately; its initial RPC rejection is
    // delivered as an error payload by the SDK, not necessarily thrown here.
    stream = session.run(request);
    for await (const frame of stream) {
      syncHandle();
      const at = nowIso();
      const ms = elapsedMs(startedPerf);
      record.sdk_frames.push({ index: record.sdk_frames.length, received_at: at, elapsed_ms: ms, payload: toSerializable(frame) });
      record.metrics.sdk_frame_count = record.sdk_frames.length;
      record.metrics.first_sdk_frame_ms ??= ms;
      const text = extractSessionFrameText(frame);
      if (text) {
        record.output_text += text;
        record.metrics.first_text_ms ??= ms;
        record.metrics.first_text_at ??= at;
      }
      if (frame?.event === "end") record.terminal_frame_received = true;
      note("session.run.sdk_frame", { event_kind: frame?.event || "unknown" });
      onChange();
    }
    syncHandle();
    record.iterator_finished = true;
    record.metrics.stream_complete_ms = elapsedMs(startedPerf);
    return classifySessionFrames(record.sdk_frames.map((frame) => frame.payload));
  } finally {
    unsubscribe();
  }
}
