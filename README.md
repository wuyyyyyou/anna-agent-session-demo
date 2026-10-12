# Anna Agent Session Demo

A frontend playground for learning how to talk to an AI agent from an Anna App. Create a session, send follow-up messages, render streaming answers, inspect web search events, cancel a run, and restore a session after a page reload.

The UI and example prompts are in English. It uses plain JavaScript and the Anna App Runtime SDK. Anna provides the model, session storage and tool execution; this project bundles no application backend or Executa.

## Run locally

You need:

- Node.js 22 or later and npm.
- [uv](https://docs.astral.sh/uv/getting-started/installation/), which the Anna CLI uses to start its local runtime.
- An Anna account with model access and available quota for the real-model experiments.

```bash
git clone https://github.com/wuyyyyyou/anna-agent-session-demo.git
cd anna-agent-session-demo
npm ci
npm run build
```

Log in to the Anna host you want to use. For staging:

```bash
npm exec -- anna-app login --host https://staging.anna.partners
npm run dev -- --llm-account https://staging.anna.partners
```

Open the dashboard URL printed by the CLI, normally `http://localhost:5180/`. The dashboard loads the app inside an iframe and provides its Host API connection. On the first launch, the CLI downloads its pinned local runtime through `uv`; no Anna platform source checkout is needed.

This repository pins `@anna-ai/cli` to **0.1.58**. In this version, `anna-app dev` uses your saved account by default; `--llm-account` selects a specific host. The older `--llm real` option shown in some documentation is not supported by this CLI version. Real-model runs use your Anna quota.

If port 5180 is in use:

```bash
npm run dev -- --llm-account https://staging.anna.partners --port 5190
```

After editing `src/`, run `npm run build` again. The CLI watches `bundle/` for changes.

### Preview with canned responses

To explore the interface without signing in or calling a real model:

```bash
npm run dev:mock
```

The fixture in `fixtures/tutorial.jsonl` emits predictable text and tool frames for the example buttons. It uses one fixed mock session ID and canned replies. It previews rendering and records; it does **not** validate model memory, tool permissions, real search, cancellation or session expiry. Use the real-model mode for those experiments.

Opening `src/index.html` directly or using a generic static server will not provide the Anna Host API connection.

## Try the tutorial

Each example button fills the prompt fields. It does not start a run or create a session. Click **Run selected session** when you are ready.

### 1. Keep context across two turns

1. Wait for **Connected to Anna**.
2. Keep **No tools** selected and click **Create session**.
3. Click **1. Set context**, then **Run selected session**:

   ```text
   I'm building a reading list app for frontend developers. Remember these details and confirm in one sentence.
   ```

4. Wait for the run to show **Succeeded**. Click **2. Follow up**, then run again in the same session:

   ```text
   Who is the app for? Suggest three features they would find useful.
   ```

The second request contains only the new question. Check that the answer uses the earlier audience and app description. Creating another session starts a separate conversation.

### 2. Override the style for one turn

Run **3. Style override**. This supplies a per-run system prompt asking for a playful tagline.

Then run **4. Default style**. This clears the override, so the session's original default prompt applies again. A per-run override does not change the saved session default.

### 3. Watch a tool call

Select **All declared tools**, then click **Create session** to start a new session with search enabled. Click **5. Search** and run it.

Expand the tool call to inspect its input and output. The agent executes the tool on the platform; the frontend displays `tool_start` and `tool_end`. Search can return no results. A finished tool call does not guarantee that it found a source.

This app declares only `web_search`. Tool access is constrained by:

```text
Platform registry ∩ app manifest ∩ session allowed_tools ∩ run allowed_tools
```

Omitting `allowed_tools` adds no further restriction; `[]` disables tools at that layer. To experiment with other platform tools, add their names to both `manifest.json` and `src/session-config.js` and rebuild. Web search also requires the platform's Web authorization.

The local CLI's catalog and grants can be permissive. The demo explicitly sends its tool whitelist even in **All declared tools** mode, and rejects manual names outside `src/session-config.js`, so a local search session is limited to `web_search` too. Published-app permissions still come from the manifest and Host checks. Inspect actual `granted_tools` and tool events rather than assuming that a catalog entry grants access.

### 4. Cancel a run

Click **6. Long answer**, start the run and click **Cancel current run** while it is still active.

The cancellation acknowledgement only confirms that the signal was accepted. The app keeps reading the stream and preserves partial text until the actual task result arrives. If cancellation arrives too late, the run may still succeed.

**Move to background** keeps the request and recording active while the page stays open. It does not cancel the run. The app prevents another run in the same session while that run remains active.

### 5. Restore after a reload

After a completed run, reload the dashboard. Under **Saved session IDs**, click **Restore** for the conversation you want to continue. Then send a follow-up question.

The app saves UUIDs automatically when sessions are created or restored. `attach(uuid)` rebuilds a client-side handle; `refresh()` verifies the existing session and updates its deadline. Neither operation creates a new conversation. An expired or revoked session requires a new one.

Restoring model context does not automatically redraw old chat bubbles. This demo retains local call records in IndexedDB; `history()` provides a separate, best-effort platform history read and may return an empty array.

### 6. Recover missing output

If a stream is silent or interrupted, use **Check run status** before sending the request again. A completed run has already executed. **Read archived frames** retrieves its output without running the model again.

Each archive read fetches up to 500 frames and remembers the last sequence number. Click again to continue. Recovery requires SDK **0.18.0+** and a Host that implements the recovery methods. Archives are short-lived; rate limits and expiry are reported in the records.

## Find the code

| File | What to read it for |
|---|---|
| [`manifest.json`](manifest.json) | Session, LLM and upload declarations |
| [`src/tutorial-prompts.js`](src/tutorial-prompts.js) | The six example prompts |
| [`src/read-turn.js`](src/read-turn.js) | A small stream-reading helper for tutorial snippets |
| [`src/session-config.js`](src/session-config.js) | Creation options, tool restrictions and per-run inputs |
| [`src/session-run.js`](src/session-run.js) | Ordered SDK stream consumption, raw frame capture and task-result classification |
| [`src/app.js`](src/app.js) | UI wiring, create/attach, cancellation, history, status queries and recovery |
| [`src/record-store.js`](src/record-store.js) | Local call-record persistence |

For a business UI, start with the SDK's high-level session object:

```js
import { AnnaAppRuntime } from "/static/anna-apps/_sdk/latest/index.js";
import { readTurn } from "./read-turn.js";

const anna = await AnnaAppRuntime.connect();
const session = await anna.agent.session({
  submode: "auto",
  systemPrompt: "Keep your answers concise and practical.",
  quotaCaps: { allowed_tools: [] },
});

const first = await readTurn(session.run({
  content: "I'm building a reading list app for frontend developers. Remember these details and confirm in one sentence.",
}), {
  onText: (_chunk, fullText) => console.log(fullText),
});

if (first.status === "succeeded") {
  const second = await readTurn(session.run({
    content: "Who is the app for? Suggest three features they would find useful.",
  }));
  console.log(second.status, second.text);
}
```

These imports run inside an Anna App iframe. Copy `read-turn.js` together with its `session-run.js` and `record-utils.js` dependencies when reusing the helper in another app. `readTurn` normalizes task results to `succeeded`, `failed`, `cancelled` or `unknown`; the Host's successful `task_complete.status` is `completed`. An ended stream alone is not proof of task success.

The diagnostics UI uses raw `session.create()` followed by `attach()` so it can retain the full creation response. It then runs through the SDK's ordered iterator; it does not implement its own stream reassembly.

## Inspect records

Open **Call records**, select a call and use **Copy current**, or use **Copy all** for its surrounding create, cancel and restore operations.

- `stream_frames`: raw Runtime envelopes in the order the app received them.
- `sdk_frames`: payloads delivered in order by the SDK, including recovered payloads.
- `output_text`: text received so far, including partial answers from failed or cancelled runs.
- `metrics` and `events`: frame timing, counts and operation events.

SDK-recovered payloads are never presented as raw realtime envelopes. **Copy session summary** omits full frame data. Records can include prompts, tool inputs and outputs, and attachment URLs; inspect what you copy before sharing a record.

Records use IndexedDB `anna-agent-session-demo`; saved IDs and settings use `anna-agent-session-demo.*` localStorage keys. They are separate from the original diagnostics app. Reloading can lose a small unsaved tail of frames; unfinished local records are marked `interrupted` on the next load. Deleting local records and deleting platform sessions are separate operations.

## Check the project

```bash
npm test
npm run build
npm run validate
```

The tests cover request construction, stream ordering, errors and partial answers, cancellation result handling, diagnostic metadata, the tutorial helper and image inputs. Strict validation checks the manifest and declared Host API usage.

## Troubleshooting

| Symptom | What to check |
|---|---|
| SDK unavailable / Disconnected | Open the dashboard printed by `npm run dev`, rather than a standalone HTML file. |
| `uv` not found | Install uv, then restart the CLI. |
| No developer account or expired credentials | Run `npm exec -- anna-app login --host …` for the host selected by `--llm-account`. |
| `unknown option '--llm'` | Use this repository's commands. CLI 0.1.58 defaults to your saved real account. |
| Permission denied | Check `ui.host_api` declarations and the account's platform authorization. |
| `APP_SESSION_EXPIRED` / `APP_SESSION_REVOKED` | Start a new conversation after confirming that the old session is unavailable. |
| No answer arriving | Query run status and recover archived frames before retrying. |

## Official documentation

- [App-side LLM & Agent API](https://staging.anna.partners/developers/apps/llm-and-agent.md)
- [Agent Host API reference](https://staging.anna.partners/developers/reference/host-api-agent.md)
- [App UI SDK](https://staging.anna.partners/developers/apps/app-ui-sdk.md)
- [Local development and login](https://staging.anna.partners/developers/apps/local-dev-llm.md)
- [Developer documentation index](https://staging.anna.partners/llms.txt)

Extracted from the `session-diagnostics-app` example in Anna Apps and adapted as a standalone tutorial companion. Distributed under the original [MIT license](LICENSE).
