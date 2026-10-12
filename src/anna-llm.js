import { imageFileMetadata, validateImageSelection } from "./image-attachments.js";

export function readLlmImage(file, createReader = () => new FileReader()) {
  const metadata = imageFileMetadata(file);
  return new Promise((resolve, reject) => {
    const reader = createReader();
    reader.onload = () => {
      const data = String(reader.result || "").split(",")[1];
      if (!data) return reject(new Error(`${file.name}: could not read image data.`));
      resolve({ type: "image", data, mimeType: metadata.mime_type });
    };
    reader.onerror = () => reject(new Error(`${file.name}: could not read the image. Select it again.`));
    reader.onabort = () => reject(new Error(`${file.name}: image read cancelled.`));
    reader.readAsDataURL(file);
  });
}

export function buildLlmInput(systemPrompt, userPrompt, images = []) {
  validateImageSelection(images.map((image) => image.file));
  const messages = [];
  if (systemPrompt) {
    messages.push({ role: "system", content: { type: "text", text: systemPrompt } });
  }
  messages.push({ role: "user", content: { type: "text", text: userPrompt } });
  for (const image of images) {
    if (image.status !== "ready" || !image.content?.data) {
      throw new Error("Wait for images to finish reading, or remove images that failed to load.");
    }
    // The documented MCP shape accepts one content block per message.
    messages.push({ role: "user", content: { ...image.content } });
  }
  return { messages };
}

export function summarizeLlmInput(input) {
  return {
    ...input,
    messages: input.messages.map((message) => message.content?.type === "image"
      ? { ...message, content: { type: "image", mimeType: message.content.mimeType, data: "[image base64 omitted]" } }
      : message),
  };
}

export function selectLlmInvocationPath(runtime) {
  if (typeof runtime?.call === "function") return "runtime.call";
  if (typeof runtime?.llm?.complete === "function") return "runtime.llm.complete";
  return "unavailable";
}

export async function invokeAnnaLlm(runtime, input, timeoutMs) {
  const invocationPath = selectLlmInvocationPath(runtime);
  if (invocationPath === "runtime.call") {
    return {
      invocationPath,
      timeoutAppliedByRuntime: true,
      result: await runtime.call("llm", "complete", input, { timeoutMs }),
    };
  }
  if (invocationPath === "runtime.llm.complete") {
    return {
      invocationPath,
      timeoutAppliedByRuntime: false,
      result: await runtime.llm.complete(input),
    };
  }
  throw new Error("Anna Runtime does not support llm.complete");
}
