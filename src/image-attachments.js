export const MAX_SESSION_IMAGES = 6;

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MIME_BY_EXTENSION = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };

export function imageFileMetadata(file) {
  const type = file.type || MIME_BY_EXTENSION[file.name.split(".").pop().toLowerCase()];
  if (!IMAGE_TYPES.has(type)) throw new Error(`${file.name}: only PNG, JPEG, WebP and GIF images are supported.`);
  if (!Number.isFinite(file.size) || file.size <= 0) throw new Error(`${file.name}: image is empty or has an invalid size.`);
  return { filename: file.name, mime_type: type, size_bytes: file.size };
}

export function validateImageSelection(files) {
  if (files.length > MAX_SESSION_IMAGES) throw new Error(`Choose at most ${MAX_SESSION_IMAGES} images. Remove some images first.`);
  files.forEach(imageFileMetadata);
}

function httpsUrl(value, label) {
  try {
    if (new URL(value).protocol === "https:") return value;
  } catch { /* Report the invalid Host response below. */ }
  throw new Error(`${label} did not return a valid HTTPS URL.`);
}

function expiryTime(confirmed, negotiated, receivedAt) {
  const expiresAt = confirmed.expires_at ?? negotiated.expires_at;
  if (expiresAt != null) {
    const parsed = typeof expiresAt === "number"
      ? (expiresAt < 1e12 ? expiresAt * 1000 : expiresAt)
      : Date.parse(expiresAt);
    if (!Number.isFinite(parsed)) throw new Error("Upload returned an invalid expiry time. Re-upload the image.");
    return parsed;
  }
  if (typeof confirmed.expires_in === "number" && Number.isFinite(confirmed.expires_in)) {
    return receivedAt + confirmed.expires_in * 1000;
  }
  return null;
}

export async function uploadSessionImage(runtime, file, {
  fetchImpl = globalThis.fetch,
  now = Date.now,
  onPhase = () => {},
} = {}) {
  const metadata = imageFileMetadata(file);
  if (typeof runtime?.upload?.negotiate !== "function" || typeof runtime?.upload?.confirm !== "function") {
    throw new Error("This Anna Runtime does not support image uploads. Update it and reconnect.");
  }
  onPhase("negotiate", "started");
  const negotiated = await runtime.upload.negotiate({ ...metadata, purpose: "image_input" });
  const putUrl = httpsUrl(negotiated?.put_url, "Upload negotiation");
  if (typeof negotiated.r2_key !== "string" || !negotiated.r2_key) throw new Error("Upload negotiation did not return an object key.");
  onPhase("negotiate", "succeeded");
  onPhase("put", "started");
  const response = await fetchImpl(putUrl, {
    method: "PUT", headers: negotiated.headers ?? {}, body: file, signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`Image upload failed: HTTP ${response.status}.`);
  onPhase("put", "succeeded");
  onPhase("confirm", "started");
  const confirmed = await runtime.upload.confirm({ r2_key: negotiated.r2_key });
  const url = httpsUrl(confirmed?.download_url, "Upload confirmation");
  const upload = {
    ...metadata,
    url,
    r2_key: confirmed.r2_key || negotiated.r2_key,
    expires_at_ms: expiryTime(confirmed, negotiated, now()),
  };
  onPhase("confirm", "succeeded");
  return upload;
}

export function buildSessionImageAttachments(images, detail = "high", now = Date.now()) {
  if (images.length > MAX_SESSION_IMAGES) throw new Error(`Each run allows at most ${MAX_SESSION_IMAGES} images.`);
  if (!["auto", "low", "high"].includes(detail)) throw new Error("Invalid image detail setting.");
  return images.map((image) => {
    const { upload } = image;
    if (image.status !== "uploaded" || !upload) throw new Error("Upload all images successfully, or remove failed images.");
    if (upload.expires_at_ms != null && upload.expires_at_ms <= now + 120_000) {
      throw new Error(`${upload.filename}: image URL has expired or expires within two minutes. Re-upload it.`);
    }
    return { type: upload.mime_type, url: httpsUrl(upload.url, "Image attachments"), filename: upload.filename, detail };
  });
}
