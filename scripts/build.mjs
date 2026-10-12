import { copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = resolve(root, "src");
const out = resolve(root, "bundle");

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

for (const file of [
  "index.html",
  "app.js",
  "anna-llm.js",
  "session-config.js",
  "tutorial-prompts.js",
  "session-run.js",
  "read-turn.js",
  "image-attachments.js",
  "record-store.js",
  "record-utils.js",
  "style.css",
  "icon.svg",
]) {
  await copyFile(resolve(src, file), resolve(out, file));
}

console.log(`Built static bundle: ${out}`);
