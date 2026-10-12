export const TOOL_MODES = Object.freeze({
  NONE: "none",
  ALL: "all",
  SELECTED: "selected",
  MANUAL: "manual",
});

export const PLATFORM_TOOL_OPTIONS = Object.freeze([
  { name: "web_search", group: "Web", access: "read" },
]);

export const DEFAULT_SELECTED_TOOLS = Object.freeze(["web_search"]);

export function uniqueToolNames(values) {
  return [...new Set((values || [])
    .filter((value) => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean))];
}

export function parseManualTools(value) {
  if (typeof value !== "string") return [];
  return uniqueToolNames(value.split(/[\s,，;；]+/));
}

export function selectedToolsForMode({ mode, selectedTools, manualTools }) {
  if (mode === TOOL_MODES.MANUAL) return parseManualTools(manualTools);
  if (mode === TOOL_MODES.SELECTED) return uniqueToolNames(selectedTools);
  return [];
}

function normalizedPrompt(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function buildSessionCreateInput({ mode, selectedTools, manualTools, systemPrompt }) {
  const normalizedSystemPrompt = normalizedPrompt(systemPrompt);
  if (mode === TOOL_MODES.ALL) {
    return {
      submode: "auto",
      ...(normalizedSystemPrompt ? { systemPrompt: normalizedSystemPrompt } : {}),
    };
  }

  const allowedTools = selectedToolsForMode({ mode, selectedTools, manualTools });

  return {
    submode: "auto",
    quotaCaps: {
      allowed_tools: allowedTools,
    },
    ...(normalizedSystemPrompt ? { systemPrompt: normalizedSystemPrompt } : {}),
  };
}

export function buildModelPreferences(modelId) {
  const normalized = typeof modelId === "string" ? modelId.trim() : "";
  return normalized ? { hints: [{ name: normalized }] } : undefined;
}

export function buildSessionRunInput({ appSessionUuid, runId, userPrompt, systemPrompt, modelId, attachments = [] }) {
  const content = normalizedPrompt(userPrompt);
  if (!content) throw new Error("User prompt cannot be empty");
  const normalizedSystemPrompt = normalizedPrompt(systemPrompt);
  const modelPreferences = buildModelPreferences(modelId);
  return {
    app_session_uuid: appSessionUuid,
    ...(runId ? { run_id: runId } : {}),
    content,
    ...(attachments.length ? { attachments: attachments.map((attachment) => ({ ...attachment })) } : {}),
    ...(normalizedSystemPrompt ? { systemPrompt: normalizedSystemPrompt } : {}),
    ...(modelPreferences ? { modelPreferences } : {}),
  };
}

export function unknownToolNames(toolNames, catalog) {
  const catalogNames = new Set((catalog?.platform_tools || [])
    .map((item) => item?.name)
    .filter((name) => typeof name === "string" && name));
  if (catalogNames.size === 0) return [];
  return uniqueToolNames(toolNames).filter((name) => !catalogNames.has(name));
}
