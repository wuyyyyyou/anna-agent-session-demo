import { TUTORIAL_PROMPTS } from "./tutorial-prompts.js";
import {
  clearCallRecords,
  deleteCallRecord,
  listCallRecords,
  markUnfinishedRecordsInterrupted,
  putCallRecord,
} from "./record-store.js";
import {
  RECORD_SCHEMA_VERSION,
  createRecordId,
  elapsedMs,
  extractLlmDiagnostics,
  extractSessionDiagnostics,
  isTimeoutError,
  nowIso,
  toSerializable,
} from "./record-utils.js";
import { buildLlmInput, invokeAnnaLlm, selectLlmInvocationPath, readLlmImage, summarizeLlmInput } from "./anna-llm.js";
import { recordSessionRun } from "./session-run.js";
import {
  buildSessionImageAttachments, imageFileMetadata, uploadSessionImage, validateImageSelection,
} from "./image-attachments.js";
import {
  DEFAULT_SELECTED_TOOLS,
  PLATFORM_TOOL_OPTIONS,
  TOOL_MODES,
  buildSessionCreateInput,
  buildSessionRunInput,
  selectedToolsForMode,
  unknownToolNames,
} from "./session-config.js";

const ANNA_RUNTIME_SDK_URLS = [
  "/static/anna-apps/_sdk/latest/index.js",
];
const SESSION_STORAGE_KEY = "anna-agent-session-demo.saved-session-ids.v1";
const SETTINGS_STORAGE_KEY = "anna-agent-session-demo.settings.v1";

const els = Object.fromEntries(
  [
    "conn-dot", "conn-label", "connection-error", "background-count", "record-count", "refresh-runtime",
    "selected-tools-panel", "manual-tools-panel", "manual-tools", "tool-checkbox-list",
    "select-all-tools", "clear-selected-tools",
    "catalog-status", "refresh-catalog", "catalog-json", "tool-policy-warning",
    "create-session", "delete-selected", "delete-all", "stop-session-wait",
    "cancel-session-run", "list-sessions", "refresh-session", "session-history", "run-status", "read-session-frames",
    "manual-session-id", "attach-manual", "save-selected", "clear-saved",
    "session-count", "saved-count", "session-list", "saved-list",
    "selected-session-id", "selected-session-source", "selected-session-state", "selected-session-tool-policy",
    "selected-session-system-prompt", "active-session-record",
    "selected-session-expires-at", "selected-session-max-lifetime-at",
    "create-system-prompt", "run-system-prompt", "run-content", "run-selected", "run-manual",
    "session-model",
    "session-images", "upload-session-images", "clear-session-images", "session-image-list",
    "session-image-status", "session-image-detail",
    "session-summary", "session-records", "copy-session-report",
    "llm-system-prompt", "llm-user-prompt",
    "llm-images", "clear-llm-images", "llm-image-list", "llm-image-status",
    "llm-timeout-seconds", "run-llm", "stop-llm-wait", "copy-llm-result",
    "active-llm-record", "llm-invocation-path", "llm-duration",
    "llm-result-view", "llm-result-empty", "llm-result-status", "llm-result-metrics", "llm-output-text",
    "record-category-filter", "record-status-filter", "refresh-records",
    "copy-all-records", "clear-records", "record-list", "record-json",
    "clear-records-confirmation", "confirm-clear-records", "cancel-clear-records", "record-action-status",
    "copy-record", "delete-record",
  ].map((id) => [id.replaceAll("-", "_"), document.querySelector(`#${id}`)])
);

let anna = null;
let connected = false;
let selectedSessionId = "";
let sessions = [];
let savedSessionIds = [];
let logs = [];
let lastLlmResult = null;
let callRecords = [];
let selectedRecordId = "";
let activeSessionRecordId = "";
let activeLlmRecordId = "";
let toolCatalog = null;
let catalogLoading = false;
let sessionImages = [];
let llmImages = [];
let llmImageReadBusy = false;
let imageUploadBusy = false;
let clearingRecords = false;

const liveOperations = new Map();
const saveQueues = new Map();
const sessionHandles = new Map();
const frameCursors = new Map();

function getAnnaAppRuntime() {
  return globalThis.AnnaAppRuntime || null;
}

async function loadAnnaRuntimeSdk() {
  const existingRuntime = getAnnaAppRuntime();
  if (existingRuntime) return existingRuntime;
  for (const sdkUrl of ANNA_RUNTIME_SDK_URLS) {
    try {
      const runtimeModule = await import(sdkUrl);
      const runtime = runtimeModule?.AnnaAppRuntime || runtimeModule?.default || getAnnaAppRuntime();
      if (runtime) {
        globalThis.AnnaAppRuntime = runtime;
        return runtime;
      }
    } catch {
      // Try the next SDK path; production staging currently serves `latest`.
    }
  }
  return null;
}

function nowTime() {
  return new Date().toLocaleTimeString("en-US", { hour12: false });
}

function stringifyDetail(detail) {
  if (detail == null) return "";
  if (typeof detail === "string") return detail;
  try {
    return JSON.stringify(toSerializable(detail));
  } catch {
    return String(detail);
  }
}

function addLog(level, source, message, detail) {
  logs.push({ time: nowTime(), level, source, message, detail: stringifyDetail(detail) });
  if (logs.length > 800) logs = logs.slice(-800);
  renderLogs();
}

function renderLogs() {
  if (!els.logs) return;
  els.logs.innerHTML = "";
  for (const item of logs) {
    const li = document.createElement("li");
    li.className = `log log--${item.level}`;
    const time = document.createElement("span");
    time.className = "log__time";
    time.textContent = item.time;
    const source = document.createElement("span");
    source.className = "log__source";
    source.textContent = item.source;
    const message = document.createElement("span");
    message.className = "log__message";
    message.textContent = item.detail ? `${item.message} ${item.detail}` : item.message;
    li.append(time, source, message);
    els.logs.appendChild(li);
  }
  els.logs.scrollTop = els.logs.scrollHeight;
}

function queueRecordSave(record) {
  const snapshot = toSerializable(record);
  const previous = saveQueues.get(record.record_id) || Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(() => putCallRecord(snapshot))
    .catch((error) => {
      addLog("error", "IndexedDB", "Could not save the call record; results remain available on this page", error);
    });
  saveQueues.set(record.record_id, next);
  void next.finally(() => {
    if (saveQueues.get(record.record_id) === next) saveQueues.delete(record.record_id);
  });
  return next;
}

function appendRecordEvent(entry, event, detail = {}) {
  entry.record.events.push({
    event,
    at: nowIso(),
    elapsed_ms: elapsedMs(entry.startedPerf),
    ...toSerializable(detail),
  });
}

function beginOperation(category, operation, request, { foreground = true } = {}) {
  const recordId = createRecordId(category);
  const startedAt = nowIso();
  const record = {
    schema_version: RECORD_SCHEMA_VERSION,
    record_id: recordId,
    category,
    operation,
    status: "running",
    started_at: startedAt,
    ended_at: null,
    duration_ms: null,
    request: toSerializable(request),
    response: null,
    error: null,
    events: [{ event: `${operation}.started`, at: startedAt, elapsed_ms: 0 }],
  };
  const entry = { record, startedPerf: performance.now(), background: false, foreground };
  liveOperations.set(recordId, entry);
  if (category === "session" && foreground) activeSessionRecordId = recordId;
  if (category === "llm") activeLlmRecordId = recordId;
  void queueRecordSave(record);
  void loadRecords();
  render();
  return entry;
}

async function finishOperation(entry, status, patch = {}) {
  const { record } = entry;
  Object.assign(record, toSerializable(patch));
  record.status = status;
  record.ended_at = nowIso();
  record.duration_ms = elapsedMs(entry.startedPerf);
  appendRecordEvent(entry, `${record.operation}.${status}`, { duration_ms: record.duration_ms });
  liveOperations.delete(record.record_id);
  if (activeSessionRecordId === record.record_id) activeSessionRecordId = "";
  if (activeLlmRecordId === record.record_id) activeLlmRecordId = "";
  await queueRecordSave(record);
  await loadRecords();
  render();
  return record;
}

function stopWaiting(category) {
  const recordId = category === "session" ? activeSessionRecordId : activeLlmRecordId;
  const entry = liveOperations.get(recordId);
  if (!entry) return;
  entry.background = true;
  entry.record.status = "waiting_stopped";
  appendRecordEvent(entry, "ui.waiting_stopped", {
    message: "The user stopped waiting; the request and background recording continue",
  });
  if (category === "session") activeSessionRecordId = "";
  if (category === "llm") activeLlmRecordId = "";
  void queueRecordSave(entry.record);
  addLog("warn", entry.record.operation, "Waiting stopped; background recording continues", entry.record.record_id);
  void loadRecords();
  render();
}

function readJsonStorage(key, fallback) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || "null");
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function readSavedSessionIds() {
  const parsed = readJsonStorage(SESSION_STORAGE_KEY, []);
  return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string" && item.trim()) : [];
}

function writeSavedSessionIds(ids) {
  savedSessionIds = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
  localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(savedSessionIds));
  render();
}

function getToolMode() {
  return document.querySelector('input[name="tool-mode"]:checked')?.value || TOOL_MODES.NONE;
}

function getCheckedToolNames() {
  return [...els.tool_checkbox_list.querySelectorAll('input[type="checkbox"]:checked')]
    .map((input) => input.value);
}

function currentRequestedTools() {
  return selectedToolsForMode({
    mode: getToolMode(),
    selectedTools: getCheckedToolNames(),
    manualTools: els.manual_tools.value,
  });
}

function toolPolicyLabel(mode, tools = []) {
  if (mode === TOOL_MODES.ALL) return "All declared tools";
  if (tools.length === 0) return "No tools";
  return `${mode === TOOL_MODES.MANUAL ? "Manual" : "Selected"}: ${tools.join(", ")}`;
}

function catalogToolsByName() {
  return new Map((toolCatalog?.platform_tools || [])
    .filter((item) => item?.name)
    .map((item) => [item.name, item]));
}

// Render the Session tool policy using the Host catalog.
function renderToolCheckboxList(container, checkedNames) {
  const checked = new Set(checkedNames);
  const catalogByName = catalogToolsByName();
  container.innerHTML = "";
  let currentGroup = "";
  for (const tool of PLATFORM_TOOL_OPTIONS) {
    if (tool.group !== currentGroup) {
      currentGroup = tool.group;
      const heading = document.createElement("div");
      heading.className = "tool-group-title";
      heading.textContent = currentGroup;
      container.appendChild(heading);
    }
    const catalogEntry = catalogByName.get(tool.name);
    const label = document.createElement("label");
    label.className = `tool-checkbox${catalogEntry && !catalogEntry.eligible ? " tool-checkbox--blocked" : ""}`;
    if (catalogEntry?.blocked_by) label.title = `Unavailable: blocked_by=${catalogEntry.blocked_by}`;
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = tool.name;
    input.checked = checked.has(tool.name);
    input.addEventListener("change", () => {
      saveSettings();
      render();
    });
    const name = document.createElement("span");
    name.className = "tool-checkbox__name";
    name.textContent = tool.name;
    const access = document.createElement("span");
    access.className = "tool-access";
    access.textContent = catalogEntry && !catalogEntry.eligible
      ? `blocked:${catalogEntry.blocked_by || "unknown"}`
      : tool.access;
    label.append(input, name, access);
    container.appendChild(label);
  }
}

function renderToolCheckboxes(checkedNames = getCheckedToolNames()) {
  renderToolCheckboxList(els.tool_checkbox_list, checkedNames);
}

/**
 * Diagnostics for a requested Session tool policy: the catalog can
 * report that a name is absent or not declared in the app manifest.
 */
function toolPolicyWarnings(mode, requestedTools) {
  const warnings = [];
  const unknown = unknownToolNames(requestedTools, toolCatalog);
  if (unknown.length > 0) warnings.push(`Unknown tools will be ignored: ${unknown.join(", ")}`);
  const catalogByName = catalogToolsByName();
  const blocked = requestedTools
    .map((name) => catalogByName.get(name))
    .filter((item) => item && !item.eligible)
    .map((item) => `${item.name} (${item.blocked_by || "unknown"})`);
  if (blocked.length > 0) warnings.push(`Unavailable: ${blocked.join(", ")}`);
  return warnings;
}

function renderToolConfiguration() {
  const mode = getToolMode();
  els.selected_tools_panel.hidden = mode !== TOOL_MODES.SELECTED;
  els.manual_tools_panel.hidden = mode !== TOOL_MODES.MANUAL;
  els.refresh_catalog.disabled = !canUseSession() || catalogLoading;

  const warnings = toolPolicyWarnings(mode, currentRequestedTools());
  els.tool_policy_warning.hidden = warnings.length === 0;
  els.tool_policy_warning.textContent = warnings.join(" ");
}

function setCheckedTools(names) {
  renderToolCheckboxes(names);
  saveSettings();
  render();
}

function saveSettings() {
  const settings = {
    tool_mode: getToolMode(),
    selected_tools: getCheckedToolNames(),
    manual_tools: els.manual_tools.value,
    session_model: els.session_model.value,
    create_system_prompt: els.create_system_prompt.value,
    run_system_prompt: els.run_system_prompt.value,
    run_content: els.run_content.value,
    llm_system_prompt: els.llm_system_prompt.value,
    llm_user_prompt: els.llm_user_prompt.value,
    llm_timeout_seconds: els.llm_timeout_seconds.value,
  };
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
}

function restoreSettings() {
  const settings = readJsonStorage(SETTINGS_STORAGE_KEY, {});
  const mode = Object.values(TOOL_MODES).includes(settings.tool_mode) ? settings.tool_mode : TOOL_MODES.NONE;
  const modeInput = document.querySelector(`input[name="tool-mode"][value="${mode}"]`);
  if (modeInput) modeInput.checked = true;
  renderToolCheckboxes(Array.isArray(settings.selected_tools) ? settings.selected_tools : DEFAULT_SELECTED_TOOLS);
  if (typeof settings.manual_tools === "string") els.manual_tools.value = settings.manual_tools;
  if (typeof settings.session_model === "string") els.session_model.value = settings.session_model;
  const legacySystemPrompt = typeof settings.session_system_prompt === "string" ? settings.session_system_prompt : "";
  if (typeof settings.create_system_prompt === "string") els.create_system_prompt.value = settings.create_system_prompt;
  else if (legacySystemPrompt) els.create_system_prompt.value = legacySystemPrompt;
  if (typeof settings.run_system_prompt === "string") els.run_system_prompt.value = settings.run_system_prompt;
  if (typeof settings.run_content === "string") els.run_content.value = settings.run_content;
  if (typeof settings.llm_system_prompt === "string") els.llm_system_prompt.value = settings.llm_system_prompt;
  if (typeof settings.llm_user_prompt === "string") els.llm_user_prompt.value = settings.llm_user_prompt;
  if (typeof settings.llm_timeout_seconds === "string") els.llm_timeout_seconds.value = settings.llm_timeout_seconds;
}

function setConnection(nextConnected, label) {
  connected = nextConnected;
  els.conn_dot.classList.toggle("dot--on", connected);
  els.conn_dot.classList.toggle("dot--off", !connected);
  els.conn_label.textContent = label;
  render();
}

function upsertSession(session) {
  const index = sessions.findIndex((item) => item.app_session_uuid === session.app_session_uuid);
  const next = {
    created_at: new Date().toISOString(), state: "held", last_run_at: "", last_error: "",
    ...(index >= 0 ? sessions[index] : {}), ...session, updated_at: new Date().toISOString(),
  };
  if (index >= 0) sessions = sessions.map((item, itemIndex) => itemIndex === index ? next : item);
  else sessions = [...sessions, next];
  if (!selectedSessionId) selectedSessionId = session.app_session_uuid;
  render();
}

function updateSession(id, patch) {
  sessions = sessions.map((item) => item.app_session_uuid === id
    ? { ...item, ...patch, updated_at: new Date().toISOString() }
    : item);
  render();
}

function removeSession(id) {
  sessionHandles.delete(id);
  sessions = sessions.filter((item) => item.app_session_uuid !== id);
  if (selectedSessionId === id) selectedSessionId = sessions[0]?.app_session_uuid || "";
  render();
}

function findSelectedSession() {
  return sessions.find((item) => item.app_session_uuid === selectedSessionId) || null;
}

function getManualSessionId() {
  return els.manual_session_id.value.trim();
}

function canUseSession() {
  return connected && typeof anna?.agent?.session === "function"
    && typeof anna.agent.session.attach === "function";
}

function canUseLlm() {
  return connected && selectLlmInvocationPath(anna) !== "unavailable";
}

function imageStatus(message, failed = false) {
  els.session_image_status.textContent = message;
  els.session_image_status.classList.toggle("image-status--error", failed);
}

function removeSessionImages(ids) {
  sessionImages = sessionImages.filter((image) => {
    if (!ids.has(image.id)) return true;
    URL.revokeObjectURL(image.previewUrl);
    return false;
  });
  imageStatus(sessionImages.length ? "Image list updated. Review it before running." : "No images selected. This run will use text only.");
  render();
}

function renderSessionImages() {
  els.session_images.disabled = imageUploadBusy;
  els.clear_session_images.disabled = imageUploadBusy || !sessionImages.length;
  els.upload_session_images.disabled = imageUploadBusy || !connected || !sessionImages.length;
  els.upload_session_images.textContent = imageUploadBusy ? "Uploading…" : "Upload / re-upload images";
  els.session_image_list.replaceChildren();
  for (const image of sessionImages) {
    const item = document.createElement("li");
    item.className = "session-image";
    const preview = document.createElement("img");
    preview.src = image.previewUrl;
    preview.alt = image.file.name;
    const info = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = image.file.name;
    const status = document.createElement("p");
    const labels = { pending: "Pending upload", uploading: "Uploading", uploaded: "Uploaded", failed: "Upload failed" };
    const expiry = image.upload?.expires_at_ms;
    status.textContent = `${(image.file.size / 1024).toFixed(1)} KB · ${labels[image.status]}`
      + (expiry != null ? ` · URL expires at ${new Date(expiry).toLocaleString("en-US")}` : "")
      + (image.error ? `: ${image.error}` : "");
    info.append(name, status);
    const remove = createMiniButton("Remove", () => removeSessionImages(new Set([image.id])));
    remove.setAttribute("aria-label", `Remove image ${image.file.name}`);
    remove.disabled = imageUploadBusy;
    item.append(preview, info, remove);
    els.session_image_list.appendChild(item);
  }
}

async function uploadSelectedImages() {
  if (imageUploadBusy || !connected || !sessionImages.length) return;
  imageUploadBusy = true;
  const runtime = anna;
  const images = [...sessionImages];
  // Re-upload always starts a fresh transaction; stale URLs cannot survive a failed attempt.
  for (const image of images) Object.assign(image, { status: "pending", upload: null, error: "" });
  imageStatus("Uploading images. Run the session once every upload succeeds.");
  const entry = beginOperation("upload", "session.images.upload", { files: images.map((image) => imageFileMetadata(image.file)) });
  const results = [];
  try {
    for (const image of images) {
      image.status = "uploading";
      renderSessionImages();
      const started = performance.now();
      let phase = "negotiate";
      try {
        image.upload = await uploadSessionImage(runtime, image.file, {
          onPhase(nextPhase, status) {
            phase = nextPhase;
            appendRecordEvent(entry, `upload.${phase}.${status}`, { filename: image.file.name });
            void queueRecordSave(entry.record);
          },
        });
        image.status = "uploaded";
        image.uploadRecordId = entry.record.record_id;
        results.push({ ...image.upload, duration_ms: elapsedMs(started), status: "succeeded" });
      } catch (error) {
        image.status = "failed";
        image.error = error?.message || String(error);
        results.push({ filename: image.file.name, phase, duration_ms: elapsedMs(started), status: "failed", error: toSerializable(error) });
        appendRecordEvent(entry, `upload.${phase}.failed`, results.at(-1));
      }
      entry.record.response = { images: results };
      await queueRecordSave(entry.record);
      renderSessionImages();
    }
    const failures = results.filter((result) => result.status === "failed").length;
    imageStatus(failures
      ? `${results.length - failures} uploaded; ${failures} failed. Re-upload or remove failed images before running.`
      : `Uploaded ${results.length} images. Each run will include every image in the list.`, failures > 0);
    await finishOperation(entry, failures ? "failed" : "succeeded", {
      response: { images: results },
      ...(failures ? { error: { message: `${failures} image uploads failed` } } : {}),
    });
  } finally {
    imageUploadBusy = false;
    render();
  }
}

function llmImageStatus(message, failed = false) {
  els.llm_image_status.textContent = message;
  els.llm_image_status.classList.toggle("image-status--error", failed);
}

function removeLlmImages(ids) {
  llmImages = llmImages.filter((image) => {
    if (!ids.has(image.id)) return true;
    URL.revokeObjectURL(image.previewUrl);
    return false;
  });
  llmImageStatus(llmImages.length ? "Image list updated. All images will be included in the call." : "No images selected. This call will use text only.");
  render();
}

function renderLlmImages() {
  els.llm_images.disabled = llmImageReadBusy;
  els.clear_llm_images.disabled = llmImageReadBusy || !llmImages.length;
  els.llm_image_list.replaceChildren();
  for (const image of llmImages) {
    const item = document.createElement("li");
    item.className = "session-image";
    const preview = document.createElement("img");
    preview.src = image.previewUrl;
    preview.alt = image.file.name;
    const info = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = image.file.name;
    const status = document.createElement("p");
    const labels = { reading: "Reading", ready: "Ready", failed: "Read failed" };
    status.textContent = `${(image.file.size / 1024).toFixed(1)} KB · ${labels[image.status]}`
      + (image.error ? `: ${image.error}` : "");
    info.append(name, status);
    const remove = createMiniButton("Remove", () => removeLlmImages(new Set([image.id])));
    remove.setAttribute("aria-label", `Remove image ${image.file.name}`);
    remove.disabled = llmImageReadBusy;
    item.append(preview, info, remove);
    els.llm_image_list.appendChild(item);
  }
}

async function selectLlmImages() {
  const files = [...els.llm_images.files];
  els.llm_images.value = "";
  if (llmImageReadBusy || !files.length) return;
  try {
    validateImageSelection([...llmImages.map((image) => image.file), ...files]);
  } catch (error) {
    llmImageStatus(error.message, true);
    return;
  }
  llmImageReadBusy = true;
  const added = files.map((file) => ({
    id: crypto.randomUUID(), file, previewUrl: URL.createObjectURL(file), status: "reading",
  }));
  llmImages.push(...added);
  llmImageStatus("Reading images…");
  render();
  try {
    for (const image of added) {
      try {
        image.content = await readLlmImage(image.file);
        image.status = "ready";
      } catch (error) {
        image.status = "failed";
        image.error = error.message;
      }
      renderLlmImages();
    }
    const failed = llmImages.some((image) => image.status === "failed");
    llmImageStatus(failed ? "Some images could not be read. Remove them and select them again." : `Ready: ${llmImages.length} images for the LLM call.`, failed);
  } finally {
    llmImageReadBusy = false;
    render();
  }
}

function renderSessionList() {
  els.session_list.innerHTML = "";
  els.session_count.textContent = String(sessions.length);
  if (sessions.length === 0) {
    els.session_list.innerHTML = '<li class="empty">No sessions are available on this page yet.</li>';
    return;
  }
  for (const session of sessions) {
    const li = document.createElement("li");
    li.className = `session-item${session.app_session_uuid === selectedSessionId ? " session-item--active" : ""}`;
    const button = document.createElement("button");
    button.className = "session-item__button";
    button.type = "button";
    button.addEventListener("click", () => {
      selectedSessionId = session.app_session_uuid;
      if (typeof session.model_id === "string") els.session_model.value = session.model_id;
      render();
      addLog("ok", "ui", "Session selected", session.app_session_uuid);
    });
    const id = document.createElement("span");
    id.className = "session-item__id";
    id.textContent = session.app_session_uuid;
    const meta = document.createElement("span");
    meta.className = "session-item__meta";
    meta.textContent = [session.source || "created", session.state || "held", session.tool_policy || "",
      session.model_id ? `model=${session.model_id}` : "model=auto",
      session.expires_at ? `Expires at ${session.expires_at}` : "Expiry unconfirmed"].filter(Boolean).join(" · ");
    button.append(id, meta);
    li.appendChild(button);
    els.session_list.appendChild(li);
  }
}

function renderSavedList() {
  els.saved_list.innerHTML = "";
  els.saved_count.textContent = String(savedSessionIds.length);
  if (savedSessionIds.length === 0) {
    els.saved_list.innerHTML = '<li class="empty">No saved session IDs.</li>';
    return;
  }
  for (const id of savedSessionIds) {
    const li = document.createElement("li");
    li.className = "saved-item";
    const text = document.createElement("span");
    text.textContent = id;
    const actions = document.createElement("span");
    actions.className = "saved-item__actions";
    const useButton = createMiniButton("Restore", () => restoreSessionById(id, "localStorage"));
    const runButton = createMiniButton("run", () => runSessionById(id, "saved"));
    useButton.disabled = !canUseSession() || Boolean(activeSessionRecordId) || Boolean(findLiveSessionRun(id));
    runButton.disabled = !canUseSession() || Boolean(activeSessionRecordId) || Boolean(findLiveSessionRun(id)) || imageUploadBusy;
    const deleteButton = createMiniButton("Remove", () => {
      writeSavedSessionIds(savedSessionIds.filter((item) => item !== id));
    }, "mini-btn mini-btn--danger");
    actions.append(useButton, runButton, deleteButton);
    li.append(text, actions);
    els.saved_list.appendChild(li);
  }
}

function createMiniButton(label, handler, className = "mini-btn") {
  const button = document.createElement("button");
  button.className = className;
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", handler);
  return button;
}

function renderResult(element, result) {
  element.textContent = JSON.stringify(toSerializable(result || {}), null, 2);
}

function formatMetricValue(value, suffix = "") {
  if (value == null || value === "") return "Not returned";
  if (typeof value === "number" && Number.isFinite(value)) return `${value.toLocaleString()}${suffix}`;
  return `${String(value)}${suffix}`;
}

function llmStatusLabel(status) {
  return {
    succeeded: "Succeeded",
    failed: "Failed",
    interrupted: "Interrupted",
    waiting_stopped: "Waiting stopped",
    running: "Running",
    cancelled: "Cancelled",
    unknown: "Unconfirmed",
  }[status] || status || "Unknown";
}

function buildLlmSummary(record) {
  if (!record) return "";
  const diagnostics = extractLlmDiagnostics(record);
  const usage = diagnostics.token_usage || {};
  const tokenSummary = formatTokenUsage(usage);
  return [
    `Response: ${diagnostics.output_text || "(no text returned)"}`,
    `Model: ${diagnostics.model || "Not returned"}`,
    `Token: ${tokenSummary}`,
    `Stop reason: ${diagnostics.stop_reason || "Not returned"}`,
    `Provider: ${diagnostics.provider || "Not returned"}`,
    `Provider latency: ${formatMetricValue(diagnostics.latency_ms, " ms")}`,
    `Quota used: ${formatMetricValue(diagnostics.quota_consumed)}`,
    `Call duration: ${formatMetricValue(record.duration_ms, " ms")}`,
  ].join("\n");
}

function renderLlmResult(record) {
  const hasRecord = Boolean(record);
  els.llm_result_empty.hidden = hasRecord;
  els.llm_result_status.hidden = !hasRecord;
  els.llm_result_metrics.hidden = !hasRecord;
  els.llm_output_text.hidden = !hasRecord;
  els.llm_result_metrics.innerHTML = "";
  els.llm_output_text.textContent = "";
  if (!hasRecord) return;

  const diagnostics = extractLlmDiagnostics(record);
  const status = record.status || "unknown";
  els.llm_result_status.className = `llm-result__status llm-result__status--${status}`;
  els.llm_result_status.textContent = llmStatusLabel(status);
  els.llm_output_text.className = `llm-output-text llm-output-text--${status}`;
  els.llm_output_text.textContent = diagnostics.output_text
    || (record.error ? `Call failed: ${record.error.message || String(record.error)}` : "(no text received)");

  const usage = diagnostics.token_usage || {};
  const inputTokens = usage.inputTokens ?? usage.input_tokens ?? usage.promptTokens ?? usage.prompt_tokens;
  const outputTokens = usage.outputTokens ?? usage.output_tokens ?? usage.completionTokens ?? usage.completion_tokens;
  const totalTokens = usage.totalTokens ?? usage.total_tokens ?? usage.tokens;
  const metrics = [
    ["Actual model", diagnostics.model],
    ["Input tokens", formatMetricValue(inputTokens)],
    ["Output tokens", formatMetricValue(outputTokens)],
    ["Total tokens", formatMetricValue(totalTokens)],
    ["Stop reason", diagnostics.stop_reason],
    ["Provider", diagnostics.provider],
    ["Provider latency", diagnostics.latency_ms == null ? null : `${formatMetricValue(diagnostics.latency_ms)} ms`],
    ["Quota used", diagnostics.quota_consumed],
  ];
  for (const [label, value] of metrics) els.llm_result_metrics.appendChild(createMetric(label, value));
}

function sessionIdForRecord(record) {
  return record?.request?.app_session_uuid
    || record?.session?.app_session_uuid
    || record?.response?.app_session_uuid
    || "";
}

function formatJsonValue(value) {
  if (value == null || value === "") return "-";
  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  try {
    return JSON.stringify(toSerializable(value), null, 2);
  } catch {
    return String(value);
  }
}

function formatTokenUsage(usage) {
  if (!usage || typeof usage !== "object") return "Not returned";
  const prompt = usage.total_prompt_tokens ?? usage.prompt_tokens ?? usage.input_tokens
    ?? usage.inputTokens ?? usage.promptTokens;
  const completion = usage.total_completion_tokens ?? usage.completion_tokens ?? usage.output_tokens
    ?? usage.outputTokens ?? usage.completionTokens;
  const total = usage.total_tokens ?? usage.tokens ?? usage.totalTokens;
  const parts = [];
  if (prompt != null) parts.push(`Input ${formatMetricValue(prompt)}`);
  if (completion != null) parts.push(`Output ${formatMetricValue(completion)}`);
  if (total != null) parts.push(`Total ${formatMetricValue(total)}`);
  return parts.length > 0 ? parts.join(" · ") : "Not returned";
}

function createMetric(label, value) {
  const item = document.createElement("div");
  item.className = "session-metric";
  const title = document.createElement("span");
  title.className = "session-metric__label";
  title.textContent = label;
  const content = document.createElement("strong");
  content.className = "session-metric__value";
  content.textContent = value == null || value === "" ? "-" : String(value);
  item.append(title, content);
  return item;
}

function appendLazyCode(container, label, value, className = "session-code") {
  const details = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = label;
  details.appendChild(summary);
  details.addEventListener("toggle", () => {
    if (!details.open || details.dataset.hydrated === "true") return;
    const pre = document.createElement("pre");
    pre.className = className;
    pre.textContent = formatJsonValue(value);
    details.appendChild(pre);
    details.dataset.hydrated = "true";
  });
  container.appendChild(details);
  return details;
}

function createToolCallDetails(tool) {
  const details = document.createElement("details");
  details.className = "tool-call";
  const summary = document.createElement("summary");
  const title = document.createElement("span");
  title.className = "tool-call__title";
  title.textContent = `${tool.index + 1}. ${tool.name || "unknown"}`;
  const status = document.createElement("span");
  status.className = `tool-call__status tool-call__status--${tool.status || "started"}`;
  status.textContent = tool.status === "completed" ? "Completed" : "Incomplete";
  summary.append(title, status);
  details.appendChild(summary);

  const meta = document.createElement("div");
  meta.className = "tool-call__meta";
  const toolStartedMs = Date.parse(tool.started_at || "");
  const toolEndedMs = Date.parse(tool.ended_at || "");
  const toolDuration = Number.isFinite(toolStartedMs) && Number.isFinite(toolEndedMs)
    ? `${Math.max(0, toolEndedMs - toolStartedMs)} ms`
    : "";
  meta.textContent = [
    tool.id ? `id=${tool.id}` : "",
    toolDuration ? `Duration ${toolDuration}` : "",
    tool.started_at ? `Started ${tool.started_at}` : "",
    tool.ended_at ? `Ended ${tool.ended_at}` : "",
  ].filter(Boolean).join(" · ");
  details.appendChild(meta);

  const body = document.createElement("div");
  body.className = "tool-call__body";
  appendLazyCode(body, "Input (expand)", tool.input);
  appendLazyCode(body, "Output (expand)", tool.output);
  details.appendChild(body);
  return details;
}

function createSessionRecordCard(record) {
  const card = document.createElement("article");
  card.className = `session-record session-record--${record.status || "unknown"}`;

  const header = document.createElement("div");
  header.className = "session-record__header";
  const heading = document.createElement("div");
  const title = document.createElement("h3");
  title.textContent = record.operation || "Session call";
  const subtitle = document.createElement("p");
  subtitle.className = "session-record__subtitle";
  subtitle.textContent = [record.started_at || "-", record.record_id || ""].filter(Boolean).join(" · ");
  heading.append(title, subtitle);
  const status = document.createElement("span");
  status.className = `record-status record-status--${record.status || "unknown"}`;
  status.textContent = llmStatusLabel(record.status);
  header.append(heading, status);
  card.appendChild(header);

  const diagnostics = record.operation === "session.run" ? extractSessionDiagnostics(record) : null;
  const metrics = document.createElement("div");
  metrics.className = "session-record__metrics";
  metrics.appendChild(createMetric("Duration", record.duration_ms == null ? "-" : `${record.duration_ms} ms`));
  if (diagnostics) {
    const usage = diagnostics.token_usage || {};
    metrics.appendChild(createMetric("Image attachments", `${record.request?.attachments?.length || 0} images`));
    metrics.appendChild(createMetric("Requested model", record.request?.requested_model || "Automatic"));
    metrics.appendChild(createMetric("Actual model", diagnostics.model || "Not returned"));
    metrics.appendChild(createMetric("Granted tools", Array.isArray(diagnostics.run_meta?.granted_tools)
      ? diagnostics.run_meta.granted_tools.join(", ") || "No tools"
      : "Not returned"));
    metrics.appendChild(createMetric("Run ID", record.run_id));
    metrics.appendChild(createMetric("Stream ID", record.stream_id));
    metrics.appendChild(createMetric("Raw / SDK frames", `${record.stream_frames?.length || 0} / ${record.sdk_frames?.length || 0}`));
    metrics.appendChild(createMetric("Token", formatTokenUsage(usage)));
    metrics.appendChild(createMetric("Agent calls", usage.total_calls == null ? "Not returned" : `${usage.total_calls} calls`));
    metrics.appendChild(createMetric("Tool calls", `${diagnostics.tools.length} calls`));
    metrics.appendChild(createMetric("Cache read tokens", usage.total_cache_read_tokens == null ? "Not returned" : usage.total_cache_read_tokens.toLocaleString()));
    metrics.appendChild(createMetric("Estimated cost (Anna)", usage.total_estimated_cost == null ? "Not returned" : String(usage.total_estimated_cost)));
    metrics.appendChild(createMetric("First Runtime frame", record.metrics?.first_frame_ms == null ? "-" : `${record.metrics.first_frame_ms} ms`));
    metrics.appendChild(createMetric("First SDK frame", record.metrics?.first_sdk_frame_ms == null ? "-" : `${record.metrics.first_sdk_frame_ms} ms`));
    metrics.appendChild(createMetric("First text", diagnostics.first_text_ms == null ? "-" : `${diagnostics.first_text_ms} ms`));
  }
  card.appendChild(metrics);

  if (diagnostics) {
    const responseSection = document.createElement("section");
    responseSection.className = "session-response";
    const responseTitle = document.createElement("h4");
    responseTitle.textContent = "Session response";
    responseSection.appendChild(responseTitle);
    const output = document.createElement("pre");
    output.className = "session-output";
    output.textContent = diagnostics.output_text || "(no text received)";
    responseSection.appendChild(output);
    card.appendChild(responseSection);

    const toolsSection = document.createElement("section");
    toolsSection.className = "session-tools";
    const toolsTitle = document.createElement("div");
    toolsTitle.className = "session-section-title";
    toolsTitle.textContent = `Tool calls (${diagnostics.tools.length})`;
    toolsSection.appendChild(toolsTitle);
    if (diagnostics.tools.length === 0) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = "No tool calls were observed in this run.";
      toolsSection.appendChild(empty);
    } else {
      const list = document.createElement("div");
      list.className = "tool-call-list";
      diagnostics.tools.forEach((tool) => list.appendChild(createToolCallDetails(tool)));
      toolsSection.appendChild(list);
    }
    card.appendChild(toolsSection);
    if (record.error) appendLazyCode(card, "Error details", record.error);
  } else {
    const rawResponse = document.createElement("div");
    rawResponse.className = "session-raw-response";
    appendLazyCode(rawResponse, "Raw response (expand)", record.response);
    card.appendChild(rawResponse);
  }

  return card;
}

function selectedSessionRecords() {
  if (!selectedSessionId) return [];
  const recordsById = new Map(callRecords
    .filter((record) => record.category === "session" && sessionIdForRecord(record) === selectedSessionId)
    .map((record) => [record.record_id, record]));
  for (const entry of liveOperations.values()) {
    const record = entry.record;
    if (record.category === "session" && sessionIdForRecord(record) === selectedSessionId) {
      recordsById.set(record.record_id, record);
    }
  }
  return [...recordsById.values()]
    .sort((left, right) => String(right.started_at).localeCompare(String(left.started_at)));
}

function buildSessionReport(records) {
  return records.map((record) => {
    const diagnostics = record.operation === "session.run" ? extractSessionDiagnostics(record) : null;
    return {
      operation: record.operation,
      status: record.status,
      started_at: record.started_at,
      duration_ms: record.duration_ms,
      requested_model: record.request?.requested_model || null,
      actual_model: diagnostics?.model || null,
      run_meta: diagnostics?.run_meta || null,
      token_usage: diagnostics?.token_usage || null,
      output_text: diagnostics?.output_text || null,
      tool_calls: diagnostics?.tools || [],
      request: record.request || null,
      response: record.response || null,
    };
  });
}

function renderSessionInspector() {
  if (!els.session_summary || !els.session_records) return;
  const records = selectedSessionRecords();
  els.session_summary.innerHTML = "";
  els.session_records.innerHTML = "";
  els.copy_session_report.disabled = records.length === 0;
  if (!selectedSessionId) {
    els.session_summary.appendChild(Object.assign(document.createElement("p"), {
      className: "empty",
      textContent: "Select a session to inspect its responses.",
    }));
    return;
  }
  const selected = findSelectedSession();
  const runCount = records.filter((record) => record.operation === "session.run").length;
  const latest = records[0];
  const summary = document.createElement("div");
  summary.className = "session-summary__grid";
  summary.append(
    createMetric("Session ID", selectedSessionId),
    createMetric("Total calls", `${records.length} calls`),
    createMetric("Runs", `${runCount} calls`),
    createMetric("Current status", selected?.state || latest?.status || "-"),
    createMetric("Tool policy", selected?.tool_policy || "Unknown (restored session)"),
    createMetric("Requested model", selected?.model_id || "Automatic"),
  );
  els.session_summary.appendChild(summary);
  if (records.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty session-empty-state";
    empty.textContent = "No saved calls for this session yet. Run a turn to see its answer and tool calls here.";
    els.session_records.appendChild(empty);
    return;
  }
  for (const record of records) els.session_records.appendChild(createSessionRecordCard(record));
}

function render() {
  const sessionReady = canUseSession();
  const sessionBusy = Boolean(activeSessionRecordId);
  const manualId = getManualSessionId();
  const selectedRun = findLiveSessionRun(selectedSessionId);
  const manualRun = findLiveSessionRun(manualId);
  const latestRun = latestSelectedRun();
  els.refresh_runtime.disabled = liveOperations.size > 0;
  els.list_sessions.disabled = !sessionReady || sessionBusy;
  els.refresh_session.disabled = !sessionReady || !selectedSessionId || sessionBusy || Boolean(selectedRun);
  els.session_history.disabled = !sessionReady || !selectedSessionId || sessionBusy || Boolean(selectedRun);
  els.run_status.disabled = !sessionReady || !latestRun?.run_id
    || typeof anna?.agent?.session?.runStatus !== "function"
    || [...liveOperations.values()].some((entry) => entry.record.operation === "session.run.status");
  els.read_session_frames.disabled = !sessionReady || !latestRun?.run_id
    || typeof anna?.agent?.session?.frames !== "function"
    || [...liveOperations.values()].some((entry) => entry.record.operation === "session.frames");
  els.cancel_session_run.disabled = !sessionReady || !selectedRun || selectedRun.cancelPending || selectedRun.record.cancel_requested;
  els.create_session.disabled = !sessionReady || sessionBusy;
  els.delete_selected.disabled = !sessionReady || !selectedSessionId || sessionBusy || Boolean(selectedRun);
  els.delete_all.disabled = !sessionReady || sessions.length === 0 || sessionBusy || [...liveOperations.values()].some((entry) => entry.record.operation === "session.run");
  els.stop_session_wait.disabled = liveOperations.get(activeSessionRecordId)?.record.operation !== "session.run";
  els.attach_manual.disabled = !sessionReady || !manualId || sessionBusy || Boolean(manualRun);
  els.save_selected.disabled = !selectedSessionId;
  els.run_selected.disabled = !sessionReady || !selectedSessionId || sessionBusy || Boolean(selectedRun) || imageUploadBusy;
  els.run_manual.disabled = !sessionReady || !manualId || sessionBusy || Boolean(manualRun) || imageUploadBusy;
  els.run_llm.disabled = !canUseLlm() || Boolean(activeLlmRecordId) || llmImageReadBusy;
  els.stop_llm_wait.disabled = !activeLlmRecordId;
  els.copy_llm_result.disabled = !lastLlmResult;
  els.clear_records.disabled = liveOperations.size > 0 || clearingRecords;
  els.confirm_clear_records.disabled = liveOperations.size > 0 || clearingRecords;
  els.cancel_clear_records.disabled = clearingRecords;
  els.background_count.textContent = String([...liveOperations.values()].filter((entry) => entry.background).length);
  els.active_session_record.textContent = activeSessionRecordId || "-";
  els.active_llm_record.textContent = activeLlmRecordId || "-";
  const selected = findSelectedSession();
  els.selected_session_id.textContent = selectedSessionId || "-";
  els.selected_session_source.textContent = selected?.source || "-";
  els.selected_session_state.textContent = selected?.state || "-";
  els.selected_session_expires_at.textContent = selected?.expires_at || "Unconfirmed";
  els.selected_session_max_lifetime_at.textContent = selected?.max_lifetime_at || "Unconfirmed";
  els.selected_session_tool_policy.textContent = selected?.tool_policy || (selectedSessionId ? "Unknown (restored session)" : "-");
  els.selected_session_system_prompt.textContent = selectedSessionId
    ? (selected?.system_prompt || "Unset or unavailable after restore")
    : "-";
  renderToolConfiguration();
  renderSessionImages();
  renderLlmImages();
  renderSessionList();
  renderSavedList();
  renderSessionInspector();
}

function normalizeCreateResult(raw) {
  return {
    app_session_uuid: raw?.app_session_uuid || raw?.appSessionUuid || "",
    expires_in: raw?.expires_in ?? raw?.expiresIn ?? null,
    submode: raw?.submode || "",
    fixed_client_id: raw?.fixed_client_id || raw?.fixedClientId || "",
    system_prompt: raw?.system_prompt ?? raw?.systemPrompt ?? null,
    granted_tools: Array.isArray(raw?.granted_tools) ? raw.granted_tools : [],
    inherit_host_tools: raw?.inherit_host_tools ?? raw?.inheritHostTools ?? null,
    expires_at: raw?.expires_at ?? null,
    max_lifetime_at: raw?.max_lifetime_at ?? null,
    idle_ttl_seconds: raw?.idle_ttl_seconds ?? null,
    session_expires_in: raw?.session_expires_in ?? null,
  };
}

async function refreshSessionCatalog() {
  if (!canUseSession() || typeof anna.agent.session.catalog !== "function") {
    toolCatalog = null;
    els.catalog_status.textContent = "This Runtime does not support agent.session.catalog.";
    renderResult(els.catalog_json, null);
    render();
    return;
  }
  catalogLoading = true;
  els.catalog_status.textContent = "Loading the session tool catalog…";
  render();
  try {
    const result = await anna.agent.session.catalog();
    toolCatalog = result || null;
    const demoToolNames = new Set(PLATFORM_TOOL_OPTIONS.map((tool) => tool.name));
    const demoTools = (toolCatalog?.platform_tools || []).filter((item) => demoToolNames.has(item.name));
    const eligibleCount = demoTools.filter((item) => item?.eligible).length;
    const totalCount = PLATFORM_TOOL_OPTIONS.length;
    els.catalog_status.textContent = `Catalog loaded: ${eligibleCount}/${totalCount} demo tools eligible.`
      + (toolCatalog?._dev_note ? " Local development grants may be permissive." : "");
    renderResult(els.catalog_json, toolCatalog);
    renderToolCheckboxes(getCheckedToolNames());
    addLog("ok", "session.catalog", "Session tool catalog refreshed", { eligible: eligibleCount, total: totalCount });
  } catch (error) {
    toolCatalog = null;
    els.catalog_status.textContent = `Catalog request failed: ${error?.message || error}`;
    renderResult(els.catalog_json, { error: toSerializable(error) });
    addLog("warn", "session.catalog", "Could not load the session tool catalog", error);
  } finally {
    catalogLoading = false;
    render();
  }
}

async function connectAnna() {
  els.connection_error.hidden = true;
  if (liveOperations.size > 0) return;
  setConnection(false, "Connecting…");
  try {
    const runtime = await loadAnnaRuntimeSdk();
    if (!runtime) throw new Error("AnnaAppRuntime SDK is unavailable. Open this app in Anna or through anna-app dev.");
    anna = await runtime.connect();
    if (typeof anna?.agent?.session?.attach !== "function") {
      throw new Error("This SDK lacks session streaming and restore support. Update Anna Runtime and reconnect.");
    }
    sessionHandles.clear();
    setConnection(true, "Connected to Anna");
    addLog("ok", "runtime", "Connected to Anna Runtime");
    await refreshSessionCatalog();
    await listPlatformSessions();
    try {
      await anna.window?.set_title?.({ title: "Anna Agent Session Demo" });
    } catch (error) {
      addLog("warn", "runtime", "Could not set the window title", error);
    }
  } catch (error) {
    anna = null;
    setConnection(false, "Disconnected");
    els.connection_error.textContent = error?.message || String(error);
    els.connection_error.hidden = false;
    addLog("error", "runtime", "Anna Runtime connection failed; controls are disabled", error);
  }
}

async function createSession() {
  if (!canUseSession()) return;
  const mode = getToolMode();
  const requestedTools = currentRequestedTools();
  let createInput;
  try {
    createInput = buildSessionCreateInput({
      mode,
      selectedTools: getCheckedToolNames(),
      manualTools: els.manual_tools.value,
      systemPrompt: els.create_system_prompt.value,
    });
  } catch (error) {
    addLog("warn", "session.create", error?.message || String(error));
    if (mode === TOOL_MODES.MANUAL) els.manual_tools.focus();
    return;
  }
  saveSettings();
  const modelId = els.session_model.value.trim();
  const policyLabel = toolPolicyLabel(mode, requestedTools);
  const entry = beginOperation("session", "session.create", {
    ...createInput,
    ui_selection: {
      tool_mode: mode,
      requested_tools: requestedTools,
      default_model_preference: modelId || null,
    },
  });
  addLog("ok", "session.create", "Creating an agent session", entry.record.record_id);
  try {
    const raw = await anna.agent.session.create(createInput);
    appendRecordEvent(entry, "session.create.response_received");
    const normalized = normalizeCreateResult(raw);
    if (!normalized.app_session_uuid) throw new Error("session.create returned no app_session_uuid");
    sessionHandles.set(normalized.app_session_uuid, anna.agent.session.attach(raw));
    upsertSession({
      ...normalized,
      system_prompt: normalized.system_prompt ?? createInput.systemPrompt ?? "",
      source: "created",
      state: "held",
      tool_mode: mode,
      requested_tools: requestedTools,
      tool_policy: policyLabel,
      model_id: modelId,
    });
    selectedSessionId = normalized.app_session_uuid;
    writeSavedSessionIds([...savedSessionIds, normalized.app_session_uuid]);
    const record = await finishOperation(entry, "succeeded", { response: raw, session: normalized });
    addLog("ok", "session.create", "Session created", { record_id: record.record_id, duration_ms: record.duration_ms });
  } catch (error) {
    await finishOperation(entry, "failed", { error, timed_out: isTimeoutError(error) });
    addLog("error", "session.create", "Could not create the session", error);
  }
}

async function attachManualSession() {
  const id = getManualSessionId();
  if (!id) return;
  await restoreSessionById(id, "manual");
}

function saveSelectedSession() {
  if (!selectedSessionId) return;
  writeSavedSessionIds([...savedSessionIds, selectedSessionId]);
  addLog("ok", "storage", "Selected session ID saved to localStorage", selectedSessionId);
}

function getSessionHandle(id) {
  if (!sessionHandles.has(id)) {
    const info = sessions.find((session) => session.app_session_uuid === id) || { app_session_uuid: id };
    sessionHandles.set(id, anna.agent.session.attach(info));
  }
  return sessionHandles.get(id);
}

function findLiveSessionRun(id) {
  return [...liveOperations.values()].find((entry) => entry.record.operation === "session.run"
    && entry.record.request?.app_session_uuid === id) || null;
}

function latestSelectedRun() {
  return selectedSessionRecords().find((record) => record.operation === "session.run") || null;
}

async function listPlatformSessions() {
  if (!canUseSession() || activeSessionRecordId) return;
  const entry = beginOperation("session", "session.list", { limit: 100 });
  try {
    const result = await anna.agent.session.list({ limit: 100 });
    for (const session of result.sessions || []) {
      upsertSession({ ...session, source: "platform", state: findLiveSessionRun(session.app_session_uuid) ? "running" : "available" });
    }
    await finishOperation(entry, "succeeded", { response: result });
    addLog("ok", "session.list", "Platform session list loaded", { count: result.sessions?.length || 0 });
  } catch (error) {
    await finishOperation(entry, "failed", { error });
    addLog("error", "session.list", "Could not load the platform session list", error);
  }
}

async function restoreSessionById(id, source) {
  if (!canUseSession() || activeSessionRecordId || findLiveSessionRun(id)) return;
  const entry = beginOperation("session", "session.refresh", {
    app_session_uuid: id, source, invocation_path: "session.attach + session.refresh",
  });
  try {
    const result = await getSessionHandle(id).refresh();
    upsertSession({ ...result, app_session_uuid: id, source, state: "held", last_error: "" });
    selectedSessionId = id;
    els.manual_session_id.value = id;
    writeSavedSessionIds([...savedSessionIds, id]);
    await finishOperation(entry, "succeeded", { response: result });
    addLog("ok", "session.refresh", "Session restored and expiry refreshed", result);
  } catch (error) {
    updateSession(id, { state: "restore_failed", last_error: error.message });
    await finishOperation(entry, "failed", { error });
    addLog("error", "session.refresh", "Could not restore the session. If it expired or was revoked, create a new one", error);
  }
}

async function readSelectedHistory() {
  const id = selectedSessionId;
  if (!canUseSession() || !id || activeSessionRecordId || findLiveSessionRun(id)) return;
  const entry = beginOperation("session", "session.history", { app_session_uuid: id, limit: 50 });
  try {
    const result = await getSessionHandle(id).history({ limit: 50 });
    await finishOperation(entry, "succeeded", { response: result });
  } catch (error) {
    await finishOperation(entry, "failed", { error });
  }
}

async function querySelectedRunStatus() {
  const run = latestSelectedRun();
  if (!canUseSession() || !run?.run_id || [...liveOperations.values()].some((entry) => entry.record.operation === "session.run.status")) return;
  const entry = beginOperation("session", "session.run.status", {
    app_session_uuid: selectedSessionId, run_id: run.run_id, run_record_id: run.record_id,
  }, { foreground: false });
  try {
    const handle = getSessionHandle(selectedSessionId);
    if (typeof handle.runStatus !== "function") throw new Error("Run status requires SDK 0.18.0 or later.");
    const result = await handle.runStatus(run.run_id);
    await finishOperation(entry, "succeeded", { response: result });
    addLog("ok", "session.run.status", "Run status received. For a completed run, recover its output before considering a retry", result);
  } catch (error) {
    await finishOperation(entry, "failed", { error });
  }
}

async function readSelectedRunFrames() {
  const run = latestSelectedRun();
  const id = selectedSessionId;
  if (!canUseSession() || !run?.run_id || [...liveOperations.values()].some((entry) => entry.record.operation === "session.frames")) return;
  const entry = beginOperation("session", "session.frames", {
    app_session_uuid: id, run_id: run.run_id, run_record_id: run.record_id,
  }, { foreground: false });
  try {
    const status = run.stream_id ? null : await getSessionHandle(id).runStatus(run.run_id);
    const streamId = run.stream_id || status?.stream_id;
    if (!streamId) throw new Error("No stream ID yet. Check run status again shortly.");
    const args = { stream_id: streamId, after_seq: frameCursors.get(streamId) || 0, limit: 500 };
    Object.assign(entry.record.request, args);
    const result = await anna.agent.session.frames(args);
    const nextSeq = Math.max(args.after_seq, ...(result.frames || []).map((frame) => Number(frame.seq) || 0));
    frameCursors.set(streamId, nextSeq);
    await finishOperation(entry, "succeeded", { response: result, next_after_seq: nextSeq });
    addLog("ok", "session.frames", "Archived frames loaded. Click again to continue; this does not run the model again", { count: result.frames?.length || 0, complete: result.complete, next_after_seq: nextSeq });
  } catch (error) {
    await finishOperation(entry, "failed", { error });
  }
}

async function cancelSelectedRun() {
  const run = findLiveSessionRun(selectedSessionId);
  if (!run || run.cancelPending || run.record.cancel_requested) return;
  run.cancelPending = true;
  const entry = beginOperation("session", "session.cancel", {
    app_session_uuid: selectedSessionId, run_id: run.record.run_id, run_record_id: run.record.record_id,
  }, { foreground: false });
  try {
    const result = await run.handle.cancel(run.record.run_id);
    run.record.cancel_requested = result.cancelled === true;
    appendRecordEvent(run, "session.run.cancel_response", { response: toSerializable(result) });
    await queueRecordSave(run.record);
    if (run.record.cancel_requested && liveOperations.has(run.record.record_id)) {
      updateSession(run.record.request.app_session_uuid, { state: "cancel_requested" });
    }
    await finishOperation(entry, "succeeded", { response: result });
    addLog("warn", "session.cancel", "Cancellation acknowledged; reading frames to confirm the final result", result);
  } catch (error) {
    appendRecordEvent(run, "session.run.cancel_failed", { error: toSerializable(error) });
    await queueRecordSave(run.record);
    await finishOperation(entry, "failed", { error });
  } finally {
    run.cancelPending = false;
    render();
  }
}

async function runSessionById(id, source) {
  if (!canUseSession() || !id || activeSessionRecordId || findLiveSessionRun(id) || imageUploadBusy) return;
  const content = els.run_content.value.trim();
  if (!content) {
    addLog("warn", "session.run", "User prompt is empty; run skipped");
    return;
  }
  saveSettings();
  const session = sessions.find((item) => item.app_session_uuid === id) || null;
  const modelId = (session?.model_id ?? els.session_model.value).trim();
  let attachments;
  try {
    attachments = buildSessionImageAttachments(sessionImages, els.session_image_detail.value);
  } catch (error) {
    imageStatus(error.message, true);
    return;
  }
  const rpcInput = buildSessionRunInput({
    appSessionUuid: id, runId: crypto.randomUUID(), userPrompt: content,
    systemPrompt: els.run_system_prompt.value, modelId, attachments,
  });
  const entry = beginOperation("session", "session.run", {
    ...rpcInput, source, requested_model: modelId || null, invocation_path: "AgentSession.run",
    ...(attachments.length ? { image_upload_record_ids: [...new Set(sessionImages.map((image) => image.uploadRecordId))] } : {}),
  });
  entry.record.run_id = rpcInput.run_id;
  selectedSessionId = id;
  upsertSession({ app_session_uuid: id, state: "running", last_error: "" });
  let renderTimer = null;
  let saveTimer = null;
  const onChange = () => {
    if (!renderTimer) renderTimer = setTimeout(() => {
      renderTimer = null;
      renderSessionInspector();
    }, 100);
    if (!saveTimer) saveTimer = setTimeout(() => {
      saveTimer = null;
      void queueRecordSave(entry.record);
    }, 500);
  };
  try {
    entry.handle = getSessionHandle(id);
    const { app_session_uuid, ...request } = rpcInput;
    const outcome = await recordSessionRun({
      runtime: anna, session: entry.handle, request, record: entry.record,
      startedPerf: entry.startedPerf, onChange,
    });
    updateSession(id, {
      state: outcome.status === "succeeded" || outcome.status === "cancelled" ? "held" : outcome.status,
      last_run_status: outcome.status, last_run_at: nowIso(),
      last_error: outcome.error ? String(outcome.error.message || "Agent run failed") : "",
    });
    await finishOperation(entry, outcome.status, { error: outcome.error });
    addLog(outcome.status === "succeeded" ? "ok" : "warn", "session.run", llmStatusLabel(outcome.status), {
      run_id: entry.record.run_id, stream_id: entry.record.stream_id,
    });
  } catch (error) {
    updateSession(id, { state: "error", last_error: String(error?.message || error) });
    await finishOperation(entry, "failed", { error, timed_out: isTimeoutError(error) });
  } finally {
    clearTimeout(renderTimer);
    clearTimeout(saveTimer);
  }
}

async function deleteSessionById(id, source = "session.delete") {
  if (!canUseSession() || !id) return false;
  const entry = beginOperation("session", "session.delete", { app_session_uuid: id, source });
  addLog("ok", source, "Deleting the session", { record_id: entry.record.record_id, app_session_uuid: id });
  try {
    const result = await anna.agent.session.delete({ app_session_uuid: id });
    removeSession(id);
    const record = await finishOperation(entry, "succeeded", { response: result });
    addLog("ok", source, "Session deleted", { record_id: record.record_id, duration_ms: record.duration_ms });
    return true;
  } catch (error) {
    updateSession(id, { state: "delete_error", last_error: String(error?.message || error) });
    await finishOperation(entry, "failed", { error, timed_out: isTimeoutError(error) });
    addLog("error", source, "Could not delete the session", error);
    return false;
  }
}

async function deleteSelectedSession() {
  const id = selectedSessionId;
  if (!id) return;
  if (await deleteSessionById(id)) writeSavedSessionIds(savedSessionIds.filter((item) => item !== id));
}

async function deleteAllSessions() {
  const ids = sessions.map((session) => session.app_session_uuid);
  addLog("warn", "cleanup", "Deleting all available sessions", { count: ids.length });
  const deletedIds = [];
  for (const id of ids) if (await deleteSessionById(id, "cleanup")) deletedIds.push(id);
  writeSavedSessionIds(savedSessionIds.filter((id) => !deletedIds.includes(id)));
  addLog("ok", "cleanup", "Session cleanup finished");
}

async function runLlm() {
  if (!canUseLlm() || activeLlmRecordId || llmImageReadBusy) return;
  const systemPrompt = els.llm_system_prompt.value.trim();
  const userPrompt = els.llm_user_prompt.value.trim();
  const timeoutSeconds = Number(els.llm_timeout_seconds.value);
  if (!userPrompt) {
    addLog("warn", "llm.complete", "User prompt cannot be empty");
    els.llm_user_prompt.focus();
    return;
  }
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 10 || timeoutSeconds > 600) {
    addLog("warn", "llm.complete", "Timeout must be between 10 and 600 seconds");
    els.llm_timeout_seconds.focus();
    return;
  }
  saveSettings();
  let input;
  try {
    input = buildLlmInput(systemPrompt, userPrompt, llmImages);
  } catch (error) {
    llmImageStatus(error.message, true);
    return;
  }
  const invocationPath = selectLlmInvocationPath(anna);
  const timeoutMs = Math.round(timeoutSeconds * 1000);
  const entry = beginOperation("llm", "llm.complete", {
    input: summarizeLlmInput(input), images: llmImages.map((image) => imageFileMetadata(image.file)),
    timeout_ms: timeoutMs, invocation_path: invocationPath,
    timeout_applied_by_runtime: invocationPath === "runtime.call",
  });
  entry.record.invocation_path = invocationPath;
  entry.record.timeout_ms = timeoutMs;
  els.llm_invocation_path.textContent = invocationPath;
  els.llm_duration.textContent = "Waiting for a response…";
  addLog("ok", "llm.complete", "Starting the LLM call", { record_id: entry.record.record_id, invocation_path: invocationPath });
  try {
    const invocation = await invokeAnnaLlm(anna, input, timeoutMs);
    const result = invocation.result;
    const diagnostics = extractLlmDiagnostics(result);
    const record = await finishOperation(entry, "succeeded", {
      response: result,
      output_text: diagnostics.output_text,
      response_metadata: {
        model: diagnostics.model,
        usage: diagnostics.token_usage,
        stop_reason: diagnostics.stop_reason,
        provider: diagnostics.provider,
        latency_ms: diagnostics.latency_ms,
        quota_consumed: diagnostics.quota_consumed,
        app_session_uuid: diagnostics.app_session_uuid,
      },
      timed_out: false,
    });
    lastLlmResult = record;
    if (!activeLlmRecordId) {
      renderLlmResult(record);
      els.llm_duration.textContent = `${record.duration_ms} ms`;
    }
    render();
    addLog("ok", "llm.complete", "LLM call completed", { record_id: record.record_id, duration_ms: record.duration_ms });
  } catch (error) {
    const record = await finishOperation(entry, "failed", { error, timed_out: isTimeoutError(error) });
    lastLlmResult = record;
    if (!activeLlmRecordId) {
      renderLlmResult(record);
      els.llm_duration.textContent = `${record.duration_ms} ms (failed)`;
    }
    render();
    addLog("error", "llm.complete", "LLM call failed", { record_id: record.record_id, error });
  }
}

async function loadRecords() {
  try {
    callRecords = await listCallRecords();
    if (selectedRecordId && !callRecords.some((record) => record.record_id === selectedRecordId)) selectedRecordId = "";
    renderRecords();
    renderSessionInspector();
  } catch (error) {
    addLog("error", "IndexedDB", "Could not load call records", error);
  }
}

function filteredRecords() {
  const category = els.record_category_filter.value;
  const status = els.record_status_filter.value;
  return callRecords.filter((record) =>
    (category === "all" || record.category === category) &&
    (status === "all" || record.status === status));
}

function renderRecords() {
  els.record_count.textContent = String(callRecords.length);
  els.record_list.innerHTML = "";
  const records = filteredRecords();
  if (records.length === 0) {
    els.record_list.innerHTML = '<li class="empty">No call records match these filters.</li>';
  } else {
    for (const record of records) {
      const li = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = `record-item${record.record_id === selectedRecordId ? " record-item--active" : ""}`;
      const title = document.createElement("span");
      title.className = "record-item__title";
      title.textContent = `${record.operation} · ${record.status}`;
      const meta = document.createElement("span");
      meta.className = "record-item__meta";
      meta.textContent = `${record.started_at || "-"} · ${record.duration_ms ?? "-"} ms`;
      const id = document.createElement("span");
      id.className = "record-item__id";
      id.textContent = record.stream_id ? `${record.record_id} · stream=${record.stream_id}` : record.record_id;
      button.append(title, meta, id);
      button.addEventListener("click", () => {
        selectedRecordId = record.record_id;
        renderRecords();
      });
      li.appendChild(button);
      els.record_list.appendChild(li);
    }
  }
  const selected = callRecords.find((record) => record.record_id === selectedRecordId) || null;
  renderResult(els.record_json, selected);
  els.copy_record.disabled = !selected;
  els.delete_record.disabled = !selected || liveOperations.has(selected.record_id);
}

async function copyText(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    addLog("ok", "clipboard", `${label} copied`);
  } catch (error) {
    addLog("error", "clipboard", `${label} could not be copied`, error);
  }
}

async function clearRecordsConfirmed() {
  if (els.clear_records_confirmation.hidden || clearingRecords || liveOperations.size > 0) return;
  clearingRecords = true;
  els.record_action_status.hidden = false;
  els.record_action_status.textContent = "Clearing call records…";
  render();
  try {
    // Finish outstanding writes before clearing so an older snapshot cannot
    // restore records after the clear transaction.
    await Promise.all([...saveQueues.values()]);
    if (liveOperations.size > 0) throw new Error("Wait for active requests to finish before clearing records.");
    await clearCallRecords();
    selectedRecordId = "";
    await loadRecords();
    els.clear_records_confirmation.hidden = true;
    els.record_action_status.textContent = "All call records cleared.";
    addLog("ok", "IndexedDB", "All call records cleared");
  } catch (error) {
    els.record_action_status.textContent = `Could not clear records: ${error?.message || String(error)}`;
    addLog("error", "IndexedDB", "Could not clear call records", error);
  } finally {
    clearingRecords = false;
    render();
    if (els.clear_records_confirmation.hidden) els.clear_records.focus();
  }
}

function switchTab(name) {
  for (const button of document.querySelectorAll("[data-tab]")) {
    button.classList.toggle("tab--active", button.dataset.tab === name);
  }
  for (const panel of document.querySelectorAll(".tab-panel")) {
    panel.classList.toggle("tab-panel--active", panel.id === `tab-${name}`);
  }
  if (name === "records") void loadRecords();
}

function bindEvents() {
  els.llm_images.addEventListener("change", selectLlmImages);
  els.clear_llm_images.addEventListener("click", () => removeLlmImages(new Set(llmImages.map((image) => image.id))));
  els.session_images.addEventListener("change", () => {
    const files = [...els.session_images.files];
    els.session_images.value = "";
    if (imageUploadBusy || !files.length) return;
    try {
      validateImageSelection([...sessionImages.map((image) => image.file), ...files]);
      sessionImages.push(...files.map((file) => ({
        id: crypto.randomUUID(), file, previewUrl: URL.createObjectURL(file), status: "pending", upload: null,
      })));
      imageStatus(`Selected ${sessionImages.length} images. Upload them before running.`);
      render();
    } catch (error) {
      imageStatus(error.message, true);
    }
  });
  els.upload_session_images.addEventListener("click", uploadSelectedImages);
  els.clear_session_images.addEventListener("click", () => removeSessionImages(new Set(sessionImages.map((image) => image.id))));
  for (const button of document.querySelectorAll("[data-tab]")) {
    button.addEventListener("click", () => switchTab(button.dataset.tab));
  }
  for (const button of document.querySelectorAll("[data-example]")) {
    button.addEventListener("click", () => {
      const example = TUTORIAL_PROMPTS[button.dataset.example];
      els.run_content.value = example.content;
      els.run_system_prompt.value = example.systemPrompt || "";
      saveSettings();
      els.run_content.focus();
    });
  }
  els.refresh_runtime.addEventListener("click", connectAnna);
  els.refresh_catalog.addEventListener("click", refreshSessionCatalog);
  els.list_sessions.addEventListener("click", listPlatformSessions);
  els.refresh_session.addEventListener("click", () => restoreSessionById(selectedSessionId, "refresh"));
  els.session_history.addEventListener("click", readSelectedHistory);
  els.run_status.addEventListener("click", querySelectedRunStatus);
  els.read_session_frames.addEventListener("click", readSelectedRunFrames);
  els.cancel_session_run.addEventListener("click", cancelSelectedRun);
  for (const input of document.querySelectorAll('input[name="tool-mode"]')) {
    input.addEventListener("change", () => {
      saveSettings();
      render();
    });
  }
  els.manual_tools.addEventListener("input", () => {
    saveSettings();
    render();
  });
  els.select_all_tools.addEventListener("click", () => setCheckedTools(PLATFORM_TOOL_OPTIONS.map((tool) => tool.name)));
  els.clear_selected_tools.addEventListener("click", () => setCheckedTools([]));
  els.create_session.addEventListener("click", createSession);
  els.attach_manual.addEventListener("click", attachManualSession);
  els.save_selected.addEventListener("click", saveSelectedSession);
  els.clear_saved.addEventListener("click", () => writeSavedSessionIds([]));
  els.delete_selected.addEventListener("click", deleteSelectedSession);
  els.delete_all.addEventListener("click", deleteAllSessions);
  els.stop_session_wait.addEventListener("click", () => stopWaiting("session"));
  els.run_selected.addEventListener("click", () => runSessionById(selectedSessionId, "selected"));
  els.run_manual.addEventListener("click", () => runSessionById(getManualSessionId(), "manual"));
  els.manual_session_id.addEventListener("input", render);
  els.session_model.addEventListener("change", () => {
    const modelId = els.session_model.value;
    if (selectedSessionId) updateSession(selectedSessionId, { model_id: modelId });
    saveSettings();
    render();
  });
  els.create_system_prompt.addEventListener("change", saveSettings);
  els.run_system_prompt.addEventListener("change", saveSettings);
  els.run_content.addEventListener("change", saveSettings);
  els.copy_session_report.addEventListener("click", () => {
    const records = selectedSessionRecords();
    if (records.length > 0) void copyText(JSON.stringify(buildSessionReport(records), null, 2), "Session summary");
  });
  els.run_llm.addEventListener("click", runLlm);
  els.stop_llm_wait.addEventListener("click", () => stopWaiting("llm"));
  els.copy_llm_result.addEventListener("click", () => copyText(buildLlmSummary(lastLlmResult), "LLM summary"));
  for (const input of [els.llm_system_prompt, els.llm_user_prompt, els.llm_timeout_seconds]) {
    input.addEventListener("change", saveSettings);
  }
  els.record_category_filter.addEventListener("change", renderRecords);
  els.record_status_filter.addEventListener("change", renderRecords);
  els.refresh_records.addEventListener("click", loadRecords);
  els.copy_all_records.addEventListener("click", async () => {
    await loadRecords();
    await copyText(JSON.stringify(callRecords, null, 2), "All call records");
  });
  els.clear_records.addEventListener("click", () => {
    if (clearingRecords || liveOperations.size > 0) return;
    els.record_action_status.hidden = true;
    els.clear_records_confirmation.hidden = false;
    els.cancel_clear_records.focus();
  });
  els.cancel_clear_records.addEventListener("click", () => {
    if (clearingRecords) return;
    els.clear_records_confirmation.hidden = true;
    els.record_action_status.hidden = true;
    els.clear_records.focus();
  });
  els.confirm_clear_records.addEventListener("click", clearRecordsConfirmed);
  els.copy_record.addEventListener("click", () => {
    const record = callRecords.find((item) => item.record_id === selectedRecordId);
    if (record) void copyText(JSON.stringify(record, null, 2), "Current call record");
  });
  els.delete_record.addEventListener("click", async () => {
    if (!selectedRecordId) return;
    await deleteCallRecord(selectedRecordId);
    selectedRecordId = "";
    await loadRecords();
    addLog("ok", "IndexedDB", "Selected call record deleted");
  });
}

function restoreSavedSessions() {
  savedSessionIds = readSavedSessionIds();
  for (const id of savedSessionIds) {
    upsertSession({ app_session_uuid: id, source: "localStorage", state: "unverified" });
  }
  if (savedSessionIds.length > 0) {
    selectedSessionId = savedSessionIds[0];
    els.manual_session_id.value = savedSessionIds[0];
    addLog("ok", "storage", "Saved session IDs loaded from localStorage", savedSessionIds);
  } else {
    addLog("ok", "storage", "No session IDs saved in localStorage");
  }
}

async function initialize() {
  renderToolCheckboxes(DEFAULT_SELECTED_TOOLS);
  bindEvents();
  restoreSettings();
  restoreSavedSessions();
  renderLlmResult(null);
  renderResult(els.record_json, null);
  try {
    const interrupted = await markUnfinishedRecordsInterrupted();
    if (interrupted > 0) addLog("warn", "IndexedDB", "Unfinished calls from the previous page load marked as interrupted", { count: interrupted });
  } catch (error) {
    addLog("error", "IndexedDB", "Could not initialize call record storage", error);
  }
  await loadRecords();
  render();
  await connectAnna();
}

void initialize();
