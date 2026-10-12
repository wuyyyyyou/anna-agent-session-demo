import { classifySessionFrames, extractSessionFrameText } from "./session-run.js";

// A small teaching helper for the tutorial. The diagnostics UI uses
// recordSessionRun instead to preserve timestamps and raw Runtime envelopes.
export async function readTurn(stream, {
  onText = () => {},
  onMeta = () => {},
  onToolStart = () => {},
  onToolEnd = () => {},
} = {}) {
  const frames = [];
  let text = "";

  for await (const frame of stream) {
    frames.push(frame);
    if (frame.event === "run_meta") onMeta(frame);
    const chunk = extractSessionFrameText(frame);
    if (chunk) {
      text += chunk;
      onText(chunk, text);
    }
    for (const choice of frame.choices ?? []) {
      const delta = choice.delta ?? {};
      if (delta.tool_start) onToolStart(delta.tool_start);
      if (delta.tool_end) onToolEnd(delta.tool_end);
    }
  }

  return {
    text,
    ...classifySessionFrames(frames),
    runId: stream.runId,
    streamId: stream.streamId,
  };
}
