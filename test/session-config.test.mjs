import assert from "node:assert/strict";
import test from "node:test";

import {
  TOOL_MODES,
  buildModelPreferences,
  buildSessionCreateInput,
  buildSessionRunInput,
  parseManualTools,
  unknownToolNames,
} from "../src/session-config.js";

test("parseManualTools accepts whitespace and Chinese or ASCII punctuation", () => {
  assert.deepEqual(parseManualTools("fs_read_file, fs_write_file\nweb_search；fs_read_file"), [
    "fs_read_file",
    "fs_write_file",
    "web_search",
  ]);
});

test("buildSessionCreateInput uses manifest tools or narrows to selected tools", () => {
  assert.deepEqual(buildSessionCreateInput({ mode: TOOL_MODES.ALL }), {
    submode: "auto",
  });
  assert.deepEqual(buildSessionCreateInput({
    mode: TOOL_MODES.SELECTED,
    selectedTools: ["fs_read_file", "fs_read_file"],
  }), {
    submode: "auto",
    quotaCaps: {
      allowed_tools: ["fs_read_file"],
    },
  });
});

test("buildSessionCreateInput adds a non-empty session system prompt", () => {
  assert.deepEqual(buildSessionCreateInput({
    mode: TOOL_MODES.ALL,
    systemPrompt: "  Keep your answers concise and practical.  ",
  }), {
    submode: "auto",
    systemPrompt: "Keep your answers concise and practical.",
  });
});

for (const input of [
  { mode: TOOL_MODES.NONE, selectedTools: ["fs_read_file"], manualTools: "web_search" },
  { mode: TOOL_MODES.SELECTED, selectedTools: [], manualTools: "web_search" },
  { mode: TOOL_MODES.MANUAL, manualTools: "  ", selectedTools: ["fs_read_file"] },
]) {
  test(`buildSessionCreateInput explicitly excludes all tools in ${input.mode} mode`, () => {
    assert.deepEqual(buildSessionCreateInput({ ...input, systemPrompt: "  Answer directly.  " }), {
      submode: "auto",
      quotaCaps: { allowed_tools: [] },
      systemPrompt: "Answer directly.",
    });
  });
}

test("buildModelPreferences uses the documented hint array", () => {
  assert.equal(buildModelPreferences(""), undefined);
  assert.deepEqual(buildModelPreferences("google/gemini-3.5-flash"), {
    hints: [{ name: "google/gemini-3.5-flash" }],
  });
});

test("buildSessionRunInput sends a per-run system override and user prompt", () => {
  assert.deepEqual(buildSessionRunInput({
    appSessionUuid: "aps_demo",
    systemPrompt: "  Answer in one sentence. ",
    userPrompt: "  Hello  ",
    modelId: "google/gemini-3.5-flash",
  }), {
    app_session_uuid: "aps_demo",
    content: "Hello",
    systemPrompt: "Answer in one sentence.",
    modelPreferences: { hints: [{ name: "google/gemini-3.5-flash" }] },
  });
  assert.throws(() => buildSessionRunInput({
    appSessionUuid: "aps_demo",
    userPrompt: "  ",
  }), /User prompt cannot be empty/);
  assert.deepEqual(buildSessionRunInput({
    appSessionUuid: "aps_demo",
    systemPrompt: "  ",
    userPrompt: "Hello",
  }), {
    app_session_uuid: "aps_demo",
    content: "Hello",
  });
});

test("unknownToolNames compares manual names with the runtime catalog", () => {
  const catalog = { platform_tools: [{ name: "fs_read_file" }, { name: "web_search" }] };
  assert.deepEqual(unknownToolNames(["fs_read_file", "made_up_tool"], catalog), ["made_up_tool"]);
});
