export const RECORD_SCHEMA_VERSION = 2;

export function nowIso() {
  return new Date().toISOString();
}

export function elapsedMs(startedAt, endedAt = performance.now()) {
  return Math.max(0, Math.round((endedAt - startedAt) * 1000) / 1000);
}

export function createRecordId(category) {
  const random = typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${category}-${random}`;
}

export function extractCompletionText(result) {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return "";
  if (typeof result.text === "string") return result.text;
  return extractContentText(result.content) || extractContentText(result.message?.content);
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null) ?? null;
}

/**
 * Extracts the user-facing fields from an llm.complete response. The raw
 * response stays on the call record; this model is only for the compact LLM
 * result view and accepts both the Anna camelCase fields and older snake_case
 * variants.
 */
export function extractLlmDiagnostics(recordOrResult) {
  const value = recordOrResult && typeof recordOrResult === "object"
    ? recordOrResult
    : {};
  const response = value.response && typeof value.response === "object"
    ? value.response
    : value;
  const metadata = value.response_metadata && typeof value.response_metadata === "object"
    ? value.response_metadata
    : {};
  const responseMeta = response._meta && typeof response._meta === "object"
    ? response._meta
    : (response.meta && typeof response.meta === "object" ? response.meta : {});
  const metadataMeta = metadata._meta && typeof metadata._meta === "object"
    ? metadata._meta
    : {};

  const usage = firstDefined(
    response.usage,
    response.token_usage,
    response.tokenUsage,
    metadata.usage,
    metadata.token_usage,
    metadata.tokenUsage,
  );
  const outputText = typeof value.output_text === "string" && value.output_text
    ? value.output_text
    : extractCompletionText(response);
  const model = firstDefined(
    response.model,
    response.model_name,
    response.modelName,
    metadata.model,
    metadata.model_name,
    metadata.modelName,
  );
  const stopReason = firstDefined(
    response.stopReason,
    response.stop_reason,
    response.finishReason,
    response.finish_reason,
    metadata.stop_reason,
    metadata.stopReason,
  );
  const provider = firstDefined(
    responseMeta.provider,
    metadataMeta.provider,
    metadata.provider,
  );
  const latencyMs = firstDefined(
    responseMeta.latencyMs,
    responseMeta.latency_ms,
    metadataMeta.latencyMs,
    metadataMeta.latency_ms,
    metadata.latency_ms,
    metadata.latencyMs,
  );
  const quotaConsumed = firstDefined(
    responseMeta.quotaConsumed,
    responseMeta.quota_consumed,
    metadataMeta.quotaConsumed,
    metadataMeta.quota_consumed,
    metadata.quota_consumed,
    metadata.quotaConsumed,
  );
  const appSessionUuid = firstDefined(
    responseMeta.appSessionUuid,
    responseMeta.app_session_uuid,
    metadataMeta.appSessionUuid,
    metadataMeta.app_session_uuid,
    metadata.app_session_uuid,
    metadata.appSessionUuid,
  );
  const normalizedLatencyMs = latencyMs == null
    ? null
    : (Number.isFinite(Number(latencyMs)) ? Number(latencyMs) : String(latencyMs));

  return {
    output_text: outputText,
    model: model == null ? null : String(model),
    stop_reason: stopReason == null ? null : String(stopReason),
    token_usage: isRecordObject(usage) ? toSerializable(usage) : null,
    provider: provider == null ? null : String(provider),
    latency_ms: normalizedLatencyMs,
    quota_consumed: quotaConsumed == null ? null : quotaConsumed,
    app_session_uuid: appSessionUuid == null ? null : String(appSessionUuid),
  };
}

function extractContentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(extractContentText).join("");
  return content?.type === "text" && typeof content.text === "string" ? content.text : "";
}

export function toSerializable(value) {
  const seen = new WeakMap();

  function visit(input, path) {
    if (input === null || typeof input === "string" || typeof input === "boolean") return input;
    if (typeof input === "number") return Number.isFinite(input) ? input : String(input);
    if (typeof input === "undefined") return "[Undefined]";
    if (typeof input === "bigint") return `${input}n`;
    if (typeof input === "symbol") return `[Symbol ${input.description || ""}]`;
    if (typeof input === "function") return `[Function ${input.name || "anonymous"}]`;
    if (typeof input !== "object") return String(input);

    const previousPath = seen.get(input);
    if (previousPath) return `[Circular ${previousPath}]`;
    seen.set(input, path);

    if (input instanceof Date) return input.toISOString();
    if (input instanceof RegExp) return String(input);
    if (input instanceof Error) {
      const result = {
        name: input.name,
        message: input.message,
        stack: input.stack,
      };
      for (const key of Reflect.ownKeys(input)) {
        if (typeof key !== "string" || key in result) continue;
        try {
          result[key] = visit(input[key], `${path}.${key}`);
        } catch (error) {
          result[key] = `[Unreadable: ${String(error?.message || error)}]`;
        }
      }
      return result;
    }
    if (Array.isArray(input)) {
      return input.map((item, index) => visit(item, `${path}[${index}]`));
    }

    const result = {};
    for (const key of Reflect.ownKeys(input)) {
      if (typeof key !== "string") continue;
      try {
        result[key] = visit(input[key], `${path}.${key}`);
      } catch (error) {
        result[key] = `[Unreadable: ${String(error?.message || error)}]`;
      }
    }
    if (Object.keys(result).length === 0) {
      const name = input.constructor?.name;
      if (name && name !== "Object") return `[${name}]`;
    }
    return result;
  }

  return visit(value, "$root");
}

export function isTimeoutError(error) {
  const message = String(error?.message || error || "");
  return /timeout|timed out|超时/i.test(message);
}

function isRecordObject(value) {
  return value !== null && typeof value === "object";
}

function parseMaybeJson(value) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function findToolByIdOrName(tools, id, name) {
  if (id) {
    const byId = tools.find((tool) => tool.id === id);
    if (byId) return byId;
  }
  if (name) {
    const byName = [...tools].reverse().find((tool) => tool.name === name && tool.status !== "completed");
    if (byName) return byName;
  }
  return [...tools].reverse().find((tool) => tool.status !== "completed") || null;
}

function extractChoiceText(frame) {
  const payload = frame?.envelope?.payload || frame?.payload || frame;
  const choices = Array.isArray(payload?.choices) ? payload.choices : [];
  return choices.map((choice) => {
    const delta = choice?.delta || {};
    const message = choice?.message || {};
    return [delta.content, delta.text, message.content]
      .filter((item) => typeof item === "string")
      .join("");
  }).join("");
}

/**
 * Converts captured agent.session.run RPC stream frames into a compact,
 * UI-friendly diagnostic model. The raw frames remain persisted on the call
 * record; this function only extracts tool calls, final text, model and usage.
 */
export function extractSessionDiagnostics(record) {
  const tools = [];
  const toolCallChunks = new Map();
  const frames = Array.isArray(record?.sdk_frames) && record.sdk_frames.length
    ? record.sdk_frames
    : (Array.isArray(record?.stream_frames) ? record.stream_frames : []);
  let model = record?.model
    || record?.response?.model
    || record?.response?.metadata?.model
    || null;
  let tokenUsage = record?.token_usage
    || record?.response?.usage
    || record?.response?.token_usage
    || null;
  let taskComplete = null;
  let runMeta = null;
  let firstTextMs = record?.metrics?.first_text_ms ?? null;
  let firstTextAt = record?.metrics?.first_text_at ?? null;
  const fallbackText = [];

  const addToolStart = (value, frame) => {
    if (!isRecordObject(value)) return;
    const id = value.id == null ? "" : String(value.id);
    const name = String(value.name || value.tool_name || "unknown");
    const existing = findToolByIdOrName(tools, id, name);
    if (existing && existing.status !== "completed" && (existing.id === id || !id)) {
      existing.name = name || existing.name;
      if (value.input !== undefined) existing.input = toSerializable(value.input);
      existing.started_at = existing.started_at || frame?.received_at || null;
      return;
    }
    const tool = {
      index: tools.length,
      id,
      name,
      status: "started",
      input: value.input === undefined ? (value.arguments === undefined ? null : parseMaybeJson(value.arguments)) : toSerializable(value.input),
      output: null,
      started_at: frame?.received_at || null,
      ended_at: null,
    };
    tools.push(tool);
  };

  const addToolEnd = (value, frame) => {
    if (!isRecordObject(value)) return;
    const id = value.id == null ? "" : String(value.id);
    const name = String(value.name || value.tool_name || "");
    const tool = findToolByIdOrName(tools, id, name);
    if (!tool) {
      tools.push({
        index: tools.length,
        id,
        name: name || "unknown",
        status: "completed",
        input: null,
        output: value.output === undefined ? (value.result === undefined ? null : toSerializable(value.result)) : toSerializable(value.output),
        started_at: null,
        ended_at: frame?.received_at || null,
      });
      return;
    }
    tool.output = value.output === undefined
      ? (value.result === undefined ? null : toSerializable(value.result))
      : toSerializable(value.output);
    tool.status = "completed";
    tool.ended_at = frame?.received_at || null;
  };

  const visit = (value, frame) => {
    if (!isRecordObject(value)) return;
    if (value.tool_start) addToolStart(value.tool_start, frame);
    if (value.tool_end) addToolEnd(value.tool_end, frame);
    if (value.task_complete) {
      taskComplete = toSerializable(value.task_complete);
      tokenUsage = value.task_complete.token_usage || value.task_complete.usage || tokenUsage;
      model = value.task_complete.model || model;
    }
    if (value.run_meta) {
      runMeta = toSerializable(value.run_meta);
      model = value.run_meta.model || value.run_meta.model_name || model;
    }
    if (value.event === "run_meta") {
      runMeta = toSerializable(value);
      model = value.model || value.model_name || model;
    }
    if (["task_complete", "complete"].includes(value.event)) {
      taskComplete = toSerializable(value);
      tokenUsage = value.token_usage || value.usage || tokenUsage;
      model = value.model || model;
    }
    if (value.response_metadata) {
      tokenUsage = value.response_metadata.token_usage || value.response_metadata.usage || tokenUsage;
      model = value.response_metadata.model || value.response_metadata.model_name || model;
    }
    for (const child of Object.values(value)) visit(child, frame);
  };

  for (const frame of frames) {
    const payload = frame?.envelope?.payload || frame?.payload || frame;
    const frameText = extractChoiceText(frame);
    fallbackText.push(frameText);
    if (frameText && firstTextMs == null) {
      firstTextMs = frame?.elapsed_ms ?? null;
      firstTextAt = frame?.received_at ?? null;
    }
    visit(payload, frame);
    const choices = Array.isArray(payload?.choices) ? payload.choices : [];
    for (const choice of choices) {
      const toolCalls = Array.isArray(choice?.delta?.tool_calls) ? choice.delta.tool_calls : [];
      for (const call of toolCalls) {
        const functionData = call?.function || {};
        const key = String(call?.id ?? call?.index ?? tools.length);
        const current = toolCallChunks.get(key) || { id: call?.id ? String(call.id) : "", name: "", arguments: "" };
        if (functionData.name) current.name = functionData.name;
        if (typeof functionData.arguments === "string") current.arguments += functionData.arguments;
        toolCallChunks.set(key, current);
      }
    }
  }

  const matchedChunkToolIndexes = new Set();
  for (const chunk of toolCallChunks.values()) {
    if (!chunk.name) continue;
    const existingIndex = tools.findIndex((tool, index) => !matchedChunkToolIndexes.has(index) && (
      (chunk.id && tool.id === chunk.id) || (chunk.name && tool.name === chunk.name)
    ));
    const existing = existingIndex >= 0 ? tools[existingIndex] : null;
    if (existing) {
      matchedChunkToolIndexes.add(existingIndex);
      if (existing.input == null && chunk.arguments) existing.input = parseMaybeJson(chunk.arguments);
      continue;
    }
    tools.push({
      index: tools.length,
      id: chunk.id,
      name: chunk.name || "unknown",
      status: "started",
      input: parseMaybeJson(chunk.arguments),
      output: null,
      started_at: null,
      ended_at: null,
    });
  }

  const outputText = typeof record?.output_text === "string" && record.output_text
    ? record.output_text
    : fallbackText.join("");
  const usage = isRecordObject(tokenUsage) ? toSerializable(tokenUsage) : null;
  return {
    tools: tools.map((tool, index) => ({ ...tool, index })),
    output_text: outputText,
    model: model == null ? null : String(model),
    token_usage: usage,
    first_text_ms: firstTextMs,
    first_text_at: firstTextAt,
    task_complete: taskComplete,
    run_meta: runMeta,
  };
}
