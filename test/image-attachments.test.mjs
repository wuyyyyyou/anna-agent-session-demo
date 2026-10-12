import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSessionImageAttachments, imageFileMetadata, uploadSessionImage, validateImageSelection,
} from "../src/image-attachments.js";
import { buildSessionRunInput } from "../src/session-config.js";

const NOW = Date.parse("2026-09-09T00:00:00Z");
const file = new File([new Uint8Array([137, 80, 78, 71])], "screenshot.png", { type: "image/png" });

function host({ negotiate = {}, confirm = {}, putStatus = 200 } = {}) {
  const calls = [];
  return {
    calls,
    runtime: {
      upload: {
        async negotiate(input) {
          calls.push(["negotiate", input]);
          return { put_url: "https://upload.example/image", r2_key: "image-key", headers: { "Content-Type": "image/png" }, ...negotiate };
        },
        async confirm(input) {
          calls.push(["confirm", input]);
          return { download_url: "https://images.example/image.png", expires_in: 600, ...confirm };
        },
      },
    },
    async fetchImpl(url, input) {
      calls.push(["put", url, input]);
      return { ok: putStatus >= 200 && putStatus < 300, status: putStatus };
    },
    now: () => NOW,
  };
}

test("validates image count, format and size and falls back to the file extension", () => {
  assert.doesNotThrow(() => validateImageSelection(Array(6).fill(file)));
  assert.throws(() => validateImageSelection(Array(7).fill(file)), /at most.*6/);
  assert.throws(() => imageFileMetadata(new File([], "empty.png", { type: "image/png" })), /empty/);
  assert.throws(() => imageFileMetadata(new File(["text"], "doc.txt", { type: "text/plain" })), /supported/);
  assert.equal(imageFileMetadata(new File(["jpeg"], "PHOTO.JPG")).mime_type, "image/jpeg");
});

test("sends image bytes only in PUT and preserves upload phase order", async () => {
  const stub = host();
  const phases = [];
  const upload = await uploadSessionImage(stub.runtime, file, { ...stub, onPhase: (...phase) => phases.push(phase) });
  assert.deepEqual(stub.calls.map(([name]) => name), ["negotiate", "put", "confirm"]);
  assert.deepEqual(stub.calls[0][1], { filename: "screenshot.png", mime_type: "image/png", size_bytes: 4, purpose: "image_input" });
  assert.equal(stub.calls[1][2].body, file);
  assert.equal(stub.calls[1][2].method, "PUT");
  assert.deepEqual(stub.calls[1][2].headers, { "Content-Type": "image/png" });
  assert.deepEqual(stub.calls[2][1], { r2_key: "image-key" });
  assert.equal(upload.expires_at_ms, NOW + 600_000);
  assert.deepEqual(phases, [
    ["negotiate", "started"], ["negotiate", "succeeded"],
    ["put", "started"], ["put", "succeeded"],
    ["confirm", "started"], ["confirm", "succeeded"],
  ]);
});

test("does not confirm failed uploads or hide network errors", async () => {
  const stub = host({ putStatus: 403 });
  await assert.rejects(uploadSessionImage(stub.runtime, file, stub), /HTTP 403/);
  assert.deepEqual(stub.calls.map(([name]) => name), ["negotiate", "put"]);
  const offline = host();
  await assert.rejects(uploadSessionImage(offline.runtime, file, {
    ...offline, fetchImpl: async () => { throw new Error("network disconnected"); },
  }), /network disconnected/);
  assert.equal(offline.calls.length, 1);
});

test("reports unsupported uploads and invalid negotiate or confirm responses", async () => {
  await assert.rejects(uploadSessionImage({}, file), /does not support image uploads/);
  for (const options of [
    { negotiate: { put_url: "http://upload.example/image" } },
    { negotiate: { r2_key: "" } },
    { confirm: { download_url: undefined } },
  ]) {
    const stub = host(options);
    await assert.rejects(uploadSessionImage(stub.runtime, file, stub), /did not return/);
  }
  const stub = host();
  stub.runtime.upload.confirm = async () => { throw new Error("confirmation failed"); };
  await assert.rejects(uploadSessionImage(stub.runtime, file, stub), /confirmation failed/);
});

test("prefers absolute expiry and does not invent missing expiry metadata", async () => {
  const expiresAt = "2026-09-09T00:30:00Z";
  const absolute = host({ confirm: { expires_at: expiresAt, expires_in: 5 } });
  assert.equal((await uploadSessionImage(absolute.runtime, file, absolute)).expires_at_ms, Date.parse(expiresAt));
  const negotiated = host({ negotiate: { expires_at: expiresAt } });
  assert.equal((await uploadSessionImage(negotiated.runtime, file, negotiated)).expires_at_ms, Date.parse(expiresAt));
  const unknown = host({ confirm: { expires_in: undefined } });
  const upload = await uploadSessionImage(unknown.runtime, file, unknown);
  assert.equal(upload.expires_at_ms, null);
  assert.equal(buildSessionImageAttachments([{ status: "uploaded", upload }], "auto", NOW).length, 1);
  const invalid = host({ confirm: { expires_at: "invalid" } });
  await assert.rejects(uploadSessionImage(invalid.runtime, file, invalid), /invalid expiry time/);
});

test("rejects incomplete or expiring image selections rather than dropping images", async () => {
  const stub = host();
  const upload = await uploadSessionImage(stub.runtime, file, stub);
  const ready = { status: "uploaded", upload };
  for (const status of ["pending", "uploading", "failed"]) {
    assert.throws(() => buildSessionImageAttachments([ready, { status }], "high", NOW), /all images/);
  }
  for (const offset of [-1, 0, 120_000]) {
    assert.throws(() => buildSessionImageAttachments([
      { status: "uploaded", upload: { ...upload, expires_at_ms: NOW + offset } },
    ], "high", NOW), /Re-upload/);
  }
  assert.equal(buildSessionImageAttachments([ready], "high", NOW).length, 1);
});

test("preserves attachment order and isolates requests from later edits", async () => {
  const stub = host();
  const upload = await uploadSessionImage(stub.runtime, file, stub);
  const images = [
    { status: "uploaded", upload },
    { status: "uploaded", upload: { ...upload, filename: "second.png", url: "https://images.example/second.png" } },
  ];
  for (const id of ["selected-id", "manual-id", "saved-id"]) {
    const attachments = buildSessionImageAttachments(images, "low", NOW);
    const request = buildSessionRunInput({ appSessionUuid: id, userPrompt: "Compare these images", systemPrompt: "Describe the differences briefly", modelId: "vision-model", attachments });
    assert.deepEqual(request, {
      app_session_uuid: id, content: "Compare these images", systemPrompt: "Describe the differences briefly",
      modelPreferences: { hints: [{ name: "vision-model" }] },
      attachments: [
        { type: "image/png", url: upload.url, filename: "screenshot.png", detail: "low" },
        { type: "image/png", url: "https://images.example/second.png", filename: "second.png", detail: "low" },
      ],
    });
    attachments[0].url = "changed";
    assert.equal(request.attachments[0].url, upload.url);
  }
});

test("uses the original text request after clearing images", () => {
  const attachments = buildSessionImageAttachments([]);
  assert.deepEqual(buildSessionRunInput({ appSessionUuid: "session", userPrompt: "Hello", attachments }), {
    app_session_uuid: "session", content: "Hello",
  });
});
