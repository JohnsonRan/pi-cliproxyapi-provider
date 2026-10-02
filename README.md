# pi-cliproxyapi-provider

Pi provider extension that discovers models from [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) and registers them for use in pi. It supports catalog-driven OpenAI Fast mode and also ships a small TUI helper that shows elapsed runtime and a TPS summary after each agent turn.

## Differences from upstream

Compared with [router-for-me/pi-cliproxyapi-provider](https://github.com/router-for-me/pi-cliproxyapi-provider), this fork:

- uses Pi's native API-key login and stores credentials only in `auth.json`;
- standardizes every discovered model on CLIProxyAPI's Codex client endpoint without inferring a wire protocol from the model name or backend origin;
- uses Pi's public stock `openai-codex-responses` stream without resolving or rewriting Pi build files, adapting plain CPA authentication at the request boundary;
- follows Pi's `transport` setting; under Pi's default `auto`, uses persistent WebSocket, or SSE for models the CPA catalog marks `prefer_websockets: false`;
- drops empty user/assistant messages (for example extension fold markers) before the request, because CPA forwards them to backends such as Claude or Gemini that reject empty content;
- resets the reused Codex WebSocket after compaction so server-side context follows Pi's compacted messages;
- keeps the model catalog in Pi's native model store and refresh lifecycle, and improves catalog mapping with opt-in maximum context windows, grammar/freeform tools, and output-token metadata resolved from CPA, `models.dev`, or a safe default.

Pi supports mixed-API providers, but CLIProxyAPI already translates its Codex client protocol to the configured backend. Keeping one client protocol avoids unreliable origin inference and preserves the Codex-specific WebSocket, compaction, Fast, and tool behavior used by this extension.

## What it does

1. Registers a native API-key provider that always appears in `/login`.
2. Interactive setup collects `baseUrl` + `apiKey` via `/login CLIProxyAPI` or `/login cliproxyapi`.
3. Fetches `{root}/v1/models?client_version=cpa`, including explicit native search capability metadata.
4. Maps the CLIProxyAPI catalog into pi models, including Fast service-tier capability.
5. Registers inference against `{root}/backend-api/` with Pi's standard `openai-codex-responses` API metadata.
6. Provides `/fast` to toggle OpenAI priority processing for supported models.
7. Stores the model catalog through Pi's native provider refresh lifecycle (Pi's `models-store.json`) and provides `/cliproxyapi-refresh` to force a refresh.
8. In interactive TUI sessions, shows footer elapsed time during runs and a TPS / token usage toast when the agent settles.
9. Leaves compaction triggering to Pi, including native checks between tool turns. After compaction, closes the reused Codex WebSocket for that session so CLIProxyAPI's server-side context resets with the compacted client messages. The extension does not inject synthetic context-overflow errors or block summary requests.
10. Optionally registers CPA image models listed in `imageModels` for Pi image generation.

## Install

```bash
# from npm
pi install npm:@router-for-me/pi-cliproxyapi-provider

# from a local checkout
pi install /absolute/path/to/pi-cliproxyapi-provider

# or temporarily for one run
pi -e /absolute/path/to/pi-cliproxyapi-provider
```

## Login-style setup (recommended)

This plugin uses Pi's native API-key authentication while prompting for both **baseUrl** and **apiKey**.

### Preferred: /login shortcuts

```text
/login CLIProxyAPI
```

or:

```text
/login cliproxyapi
```

These shortcuts jump straight into CLIProxyAPI's baseUrl + API key prompts.

### Menu path

```text
/login
```

Then choose **CLIProxyAPI** from API-key providers and enter:
   - base URL — preferred form is host:port, e.g. `http://127.0.0.1:8317`
   - API key

Final login validation calls `{root}/v1/models?client_version=cpa`:

- **HTTP 200** → login succeeds (an empty model list is still OK)
- **non-200 / network error** → login fails and you are prompted to re-enter base URL + API key

On success:

- Pi stores the API key and base URL in `~/.pi/agent/auth.json`, then refreshes this provider's catalog (0 models is allowed)
- after Pi persists the native credential, duplicate `baseUrl` / `apiKey` fields are removed from `~/.pi/agent/cliproxyapi.json`

Re-run `/login CLIProxyAPI` or `/login cliproxyapi` anytime to reconfigure. `/logout` removes the native credential; non-secret settings in `cliproxyapi.json` remain.

## Non-interactive configuration

You can still configure without `/login`.

### Config file

`~/.pi/agent/cliproxyapi.json`:

```json
{
  "baseUrl": "http://127.0.0.1:8317",
  "apiKey": "12345",
  "fast": false,
  "webSearch": false,
  "pause": false,
  "useMaxContextWindow": false
}
```

Optional fields:

| Field | Default | Description |
| ------- | --------- | ------------- |
| `baseUrl` | `http://127.0.0.1:8317` | CLIProxyAPI address |
| `apiKey` | _(required unless set via /login or env)_ | Bearer token / CPA API key |
| `providerId` | `cliproxyapi` | Provider id shown in `/model` |
| `providerName` | `CLIProxyAPI` | Display name in `/login` and UI |
| `fast` | `false` | Persisted Fast mode preference; only applies to catalog-supported models |
| `webSearch` | `false` | Enable the `cliproxyapi_search` tool for models with explicit native search support |
| `pause` | `false` | Persisted request-pause preference; provider requests wait until it is cleared |
| `useMaxContextWindow` | `false` | Use catalog `max_context_window` instead of standard `context_window` when available |
| `imageModels` | `[]` | CPA image model ids (e.g. `["gpt-image-2"]`) registered as Pi image models; see [Image generation](#image-generation) |

### Environment overrides

| Variable | Overrides |
| ---------- | ----------- |
| `CLIPROXYAPI_BASE_URL` | `baseUrl` |
| `CLIPROXYAPI_API_KEY` | `apiKey` |
| `CLIPROXYAPI_PROVIDER_ID` | `providerId` |
| `CLIPROXYAPI_PROVIDER_NAME` | `providerName` |
| `CLIPROXYAPI_FAST` | `fast` (`true` / `false`, also accepts `1`, `0`, `yes`, `no`, `on`, `off`) |
| `CLIPROXYAPI_WEB_SEARCH` | `webSearch` (same boolean forms as `CLIPROXYAPI_FAST`) |
| `CLIPROXYAPI_PARENT_SESSION_ID` | Explicit immediate parent session ID supplied by a child launcher; not a root ID or file path |
| `CLIPROXYAPI_USE_MAX_CONTEXT_WINDOW` | `useMaxContextWindow` (same boolean forms as `CLIPROXYAPI_FAST`) |

Resolution order for connection settings:

1. Environment variables
2. `/login` credentials in `auth.json`
3. `cliproxyapi.json`
4. Default baseUrl `http://127.0.0.1:8317`

The Fast preference resolves separately as `CLIPROXYAPI_FAST` → `cliproxyapi.json` → `false`. Maximum context is opt-in via `CLIPROXYAPI_USE_MAX_CONTEXT_WINDOW` → `cliproxyapi.json` → `false`.

### Transport

CLIProxyAPI requests follow Pi's own `transport` setting (`~/.pi/agent/settings.json`, see Pi's settings docs). With Pi's default `auto`, the catalog decides per model: persistent `websocket`, or `sse` for models CPA marks `prefer_websockets: false` (CPA does this for non-Codex backends). Setting Pi's `transport` to `websocket`, `websocket-cached`, or `sse` applies that transport to every CLIProxyAPI model. One-off native summary requests (`cacheRetention: "none"`) always use SSE.

`CLIPROXYAPI_TRANSPORT` and the `transport` field in `cliproxyapi.json` are no longer read; a startup warning points to Pi's setting if either is still present.

Pi's stock Codex transport behavior applies: `websocket`, `websocket-cached`, and `auto` may fall back to SSE when WebSocket setup fails before response streaming starts. A failure after events begin is surfaced instead of replaying the request over SSE. Use `sse` to disable WebSocket. Pi currently has no strict WebSocket-only option.

After any WebSocket failure, stock Pi keeps that session on SSE until the session ends. On Pi builds that export `getOpenAICodexWebSocketDebugStatsLazy` and `resetOpenAICodexWebSocketDebugStatsLazy` from `@earendil-works/pi-ai`, this extension lifts that: the first failure is retried on a fresh WebSocket at the next request (the failed socket was discarded, which covers a silently dead cached connection), and further consecutive failures stay on SSE for 5 minutes before WebSocket is tried again. A successful WebSocket request resets the sequence. Pi builds without these exports keep the stock behavior.

### baseUrl normalization

Preferred form is **host:port only**:

| Input | Inference baseUrl | Models URL |
| ------- | ------------------- | ------------ |
| `http://127.0.0.1:8317` | `http://127.0.0.1:8317/backend-api/` | `http://127.0.0.1:8317/v1/models?client_version=cpa` |
| `http://127.0.0.1:8317/backend-api` | `http://127.0.0.1:8317/backend-api/` | same models URL |
| `http://127.0.0.1:8317/v1` | `http://127.0.0.1:8317/backend-api/` | same models URL |
| `127.0.0.1:8317` | `http://127.0.0.1:8317/backend-api/` | same models URL |

pi then sends inference traffic to `{inference}/codex/responses`. This fixed CLIProxyAPI client protocol is used for every discovered model. Pi can dispatch different models through different API implementations, but this extension intentionally leaves backend protocol translation to CLIProxyAPI instead of guessing from model IDs or origin metadata.

### Codex authentication adapter

Model discovery and login validation continue to send the real CPA key as `Authorization: Bearer <key>` to `/v1/models`. Only inference is adapted for Pi's stock Codex parser:

```http
Authorization: Bearer <synthetic-jwt>
X-Api-Key: <real-cpa-key>
chatgpt-account-id: cpa_<sha256-key-fingerprint>
```

The synthetic JWT contains no raw API key. It supplies the account claim required by Pi and gives each CPA key a stable, isolated WebSocket cache identity. CLIProxyAPI authenticates the request through `X-Api-Key`. Any reverse proxy or gateway in front of CLIProxyAPI must preserve that header; stripping it makes inference authentication fail.

## Fast mode

OpenAI Fast mode requests the priority service tier. It can reduce latency for supported models, but consumes more OpenAI/Codex credits or incurs priority-processing pricing.

Fast is **off by default**. Toggle the global preference with:

```text
/fast
```

Each invocation switches Fast between on and off and writes the result to `~/.pi/agent/cliproxyapi.json`. On the next startup, a persisted `true` value immediately enables Fast for catalog-supported models. Fast remains ineffective for unsupported models, so their requests are left unchanged. If `CLIPROXYAPI_FAST` is set, that environment variable still takes precedence on startup.

When Fast is effective, Pi's footer status line shows a yellow lowercase `fast` (set through the public `ctx.ui.setStatus` API; Pi's built-in footer is not modified). When Fast is off or the selected model is unsupported, no label is shown. Supported models do not produce a separate status notification. Running `/fast` with an unsupported model still updates the global preference; enabling it warns that the current model cannot use Fast.

Fast capability is catalog-driven: the plugin considers a CLIProxyAPI model Fast-capable when its `service_tiers` field is a non-empty array. The `additional_speed_tiers` field is ignored. For supported models, Fast passes Pi's native `serviceTier: "priority"` option to the stock Codex stream, which sends `service_tier: "priority"`; unsupported models are left unchanged. Fast is independent from pi's reasoning/thinking level.

Models keep their standard catalog prices. Pi's Codex stream applies its built-in priority-tier multiplier to each request's usage cost (2×, or 2.5× for `gpt-5.5`), based on the tier the response reports. Toggling `/fast` therefore takes effect on the next request without refreshing the catalog or switching the active model. The multiplier matches OpenAI Codex pricing; it is not tailored to non-OpenAI backends behind CPA.

## Native web search (CLIProxyAPI v7.3.1+)

Native search is **off by default**. It is a separate tool, not a rewrite of Pi's chat streaming runtime:

```text
/cliproxyapi-refresh
/cliproxyapi-search on
/cliproxyapi-search status
/cliproxyapi-search off
```

Enabling registers `cliproxyapi_search`. It takes `query` and an optional exact CPA `model` ID, defaulting to the current model. A different search model can be selected without changing the chat model. Only visible models explicitly advertising `cpa_capabilities.web_search: true` are eligible; missing, false, or malformed capability claims never enable search. There is no provider-name inference or silent fallback to an ungrounded model answer.

The tool sends **only the query**, not conversation history, to `{root}/v1/responses` with the native `web_search` tool and `stream: false`. This keeps search results and citation URLs intact without modifying Pi's SSE/WebSocket parser. The result includes answer text, deduplicated HTTP(S) source URLs, and nested token usage. Results that report no completed search fail rather than masquerading as web results; incomplete answers are marked. Text is limited to 50KB/2000 lines, source details to 100 URLs, response bodies to 2 MiB, and each HTTP request to two minutes. Abort and `/pause` are honored. Normal chat transport is unchanged.

This is an **additional model request** and may incur native search fees. Token costs use the model catalog rates (with the same priority multiplier when Fast applies); separate per-search charges are not included. Catalog-supported `/fast` applies to the search request too. The tool reuses Pi's resolved model credentials and headers; it does not store another API key.

`CLIPROXYAPI_WEB_SEARCH` overrides `webSearch` at startup. The command changes the current session and persisted preference; an environment override still wins on the next startup. Turning the tool off prevents new calls, but does not cancel an HTTP request already in progress.

## Image generation

CPA serves image models through `{root}/v1/images/generations` and `{root}/v1/images/edits`, but its Codex catalog hides them without saying they are image models. List the ones you want in `cliproxyapi.json`:

```json
{ "imageModels": ["gpt-image-2"] }
```

They are registered as Pi image models under this provider and use the same credential. Like Pi's other image models, they do not appear in `/model`; codemode scripts reach them with `models.getAvailableOfType("image")` and `models.generateImages()`, and extensions with `ctx.modelRegistry.generateImages()`. A request with only text calls `generations`; a request with input images calls `edits` with them as `data:` URLs. Images come back as base64 (`response_format: "b64_json"`). Image costs are reported as zero. Changes to `imageModels` apply after `/reload`.

## Session hierarchy

Inference preserves Pi's existing session/cache ID and adds `X-Codex-Parent-Thread-Id` when a real parent is known:

- For saved session ancestry (`/fork`, `/clone`, or `newSession({ parentSession })`), read only the referenced parent file's header ID. Missing/malformed parent files are ignored; filenames and conversation text are never used to guess IDs.
- Child launchers can explicitly supply `CLIPROXYAPI_PARENT_SESSION_ID` with the **immediate** parent ID. It is bound on startup only when no saved parent resolves, then stored as a non-context custom session entry containing only the two IDs. Reload/resume restores it only for that exact session; it is not inherited into a new/resumed unrelated session.
- SDK stream callers can pass `metadata: { parent_session_id: "..." }` together with their own `sessionId`. Explicit caller headers, including null suppression, take precedence.

`PI_SUBAGENT_PARENT_SESSION` is deliberately ignored: pi-subagents uses it for the root permission-routing session, not necessarily the direct parent. Fresh children without a saved parent or explicit launcher/request metadata remain unlinked. No pi-subagents internals are imported.

Native compaction (`cacheRetention: "none"`) and calls using another session ID are not assigned the active chat's parent. Session shutdown clears captured ancestry. Native search requests use the current session ID and known parent for usage attribution.

## Pausing provider requests

Pause provider requests with:

```text
/pause
```

Use `/continue` to clear the pause:

```text
/continue
```

Both commands persist the `pause` boolean in `~/.pi/agent/cliproxyapi.json`. Before every CLIProxyAPI request (other providers are not held), the extension rereads this setting. While paused and a CLIProxyAPI model is selected, the footer status line shows an orange `paused`. When it is `true`, the request waits asynchronously and checks again every 200 ms until `/continue` sets it to `false`. A pause issued during an active run lets that run finish before Elapsed stops; a run that starts while paused excludes its waiting time from Elapsed.

## Model catalog

The catalog follows Pi's native provider lifecycle. Pi persists what the provider publishes in its own model store (`~/.pi/agent/models-store.json`, entry `cliproxyapi`); the extension keeps no separate cache file. Each stored model carries a `cpa` field with its catalog capabilities (Fast, native search, SSE preference), so they are restored offline too. Credentials are never stored there.

| Property | Value |
|----------|-------|
| Storage | Pi's model store, entry for the provider id |
| Startup fetch timeout | 5 seconds |
| Refresh timeout | 60 seconds |
| Scope | models are restored only when their inference URL matches the configured `baseUrl` |

### Startup behavior

1. While the extension loads, it fetches `{root}/v1/models?client_version=cpa` once, bounded to 5 seconds. Pi resolves `--model` right after startup and never goes online first in print or JSON mode, so this is what makes `pi -p --model cliproxyapi/...` and subagent sessions work on a fresh install.
2. Pi's offline startup refresh publishes and persists that result. If the fetch failed, Pi's stored catalog for the configured `baseUrl` is restored instead.
3. Interactive and RPC modes then run Pi's network refresh. Shortly after startup it reuses the startup fetch rather than requesting the catalog again.

A non-empty catalog replaces the stored list, so a removed model disappears immediately. An empty catalog does not erase a populated one; invalid JSON or a body with no model list fails the refresh and leaves the stored list active.

### Refresh commands

- `/cliproxyapi-refresh` forces an immediate refresh through Pi's model registry (`refresh({ providers: [id], force: true })`). Use it after adding or removing models on the proxy.
- `/login CLIProxyAPI` / `/login cliproxyapi` validates the credentials, then Pi refreshes this provider's catalog.

Older versions kept their own cache in `~/.pi/agent/cliproxyapi-models.json`. It is no longer read and can be deleted.

## Model mapping

From CPA catalog entry → pi model:

| CPA field | Pi field |
| ----------- | ---------- |
| `slug` | `id` |
| `display_name` | `name` |
| `context_window` | `contextWindow` |
| `max_tokens` / `max_completion_tokens` | `maxTokens` (preferred) |
| matching models.dev `limit.output` | `maxTokens` fallback |
| `input_modalities` | `input` (`text` / `image`) |
| `supported_reasoning_levels[].effort` | `thinkingLevelMap` + `reasoning` |
| `apply_patch_tool_type: "freeform"` | enables Pi OpenAI grammar/freeform tools |
| `visibility: "hide"` | skipped |
| `cpa_capabilities.web_search: true` | native search eligibility (separate from Pi deferred tool search) |

Since CLIProxyAPI v8.0.9, the catalog sets `apply_patch_tool_type` to `null` unless the proxy sets `client.codex.enable-apply-patch: true`; without it, Pi uses plain function tools.

Unsupported pi thinking levels are set to `null` so they are hidden in the UI. Output limits resolve in this order: CPA `max_tokens`, CPA `max_completion_tokens`, matching models.dev `limit.output`, then `16384`. CPA exposes this as model-catalog metadata on supported versions; it is a client budgeting value, not a guarantee that every backend enforces the same limit. When available, prices are matched against canonical model entries in `models.dev`; `cost.tiers[].tier.size` becomes pi's `inputTokensAbove`, including thresholds such as `272000`. The legacy `context_over_200k` field is used only when no explicit tiers are present. Ambiguous reseller data is not selected arbitrarily, and prices fall back to zero.

The raw `models.dev` response is cached for 24 hours at `~/.pi/agent/tmp/models-dev-cache.json`. A fresh cache avoids the network request; an expired cache is refreshed with a three-second timeout, and stale data is retained if refresh fails. If neither the network nor a previous cache is available, pricing safely falls back to zero. A small explicit alias table covers known CLIProxyAPI variants such as `gemini-pro-agent` → `gemini-3.1-pro-preview`; unknown variants are not guessed.

## Migration from versions using the custom API id

Versions through 1.4.13 stored new assistant messages with the custom `cliproxyapi-codex-responses` API id. New messages use Pi's standard `openai-codex-responses` id. Existing sessions do not need to be rewritten: Pi replays their older messages as foreign API metadata and normalizes tool-call ids before sending them through the stock Codex stream, including parallel tool calls.

## Migration from static models.json

If you previously maintained a static provider such as `cpa-responses` in `~/.pi/agent/models.json`:

1. Install this package and run `/login CLIProxyAPI` or `/login cliproxyapi` (or set `cliproxyapi.json`).
2. Point `defaultProvider` / `enabledModels` at `cliproxyapi/<model-id>` (or set `providerId` to `cpa-responses` for a drop-in id).
3. Remove the hand-maintained models array once the dynamic list looks correct.

## Elapsed time and TPS (TUI)

The package also registers `extensions/tps.ts`, which only activates for the primary interactive TUI session (`ctx.hasUI && ctx.mode === "tui"`):

- While the agent is running, the footer shows `Elapsed …` (updates every second).
- When the agent settles, the footer keeps the final elapsed time plus TPS (e.g. `Elapsed 12s · TPS 45.3 tok/s`) and a notification reports TPS plus token usage (`out` / `in` / cache r/w / total).
- TPS divides output tokens by the time assistant responses spent streaming (from each response's first event to its end). Tool runs and gaps between turns count toward Elapsed but not TPS.
- Subagent and print-mode sessions do not own the timer, clear the parent footer, or emit TPS toasts.

Disable just this helper via `pi config` if you only want the CLIProxyAPI provider.

## Failure behavior

- CLIProxyAPI `closed network connection` responses are normalized as transient network errors so pi's agent-level retry policy reconnects and restarts the interrupted assistant turn. Completed conversation and tool results remain available; token streaming does not resume from the exact interruption point.
- Before setup / without credentials: provider still appears in `/login`; no models are listed yet.
- After successful `/login`: native API-key credentials are stored only in `auth.json`, and Pi refreshes the catalog.
- The built-in `/logout` command removes the matching `auth.json` credential; environment variables and non-secret `cliproxyapi.json` settings are unchanged.
- If a models request returns **HTTP 401** or CPA is unreachable during startup, a warning is logged and Pi's stored catalog for the configured `baseUrl` remains in use. Without a stored catalog, no models are listed until a refresh succeeds; reconfigure via `/login CLIProxyAPI` or fix config/env.
- Login final step validates credentials by requesting models:
  - HTTP 200 (including empty catalog) → credentials are persisted
  - non-200 / network / invalid baseUrl → nothing is persisted; re-enter baseUrl + API key
- If CPA returns HTTP 200 with zero usable models: login still succeeds; re-run `/login CLIProxyAPI` later after models become available.
- If the selected model does not provide a non-empty `service_tiers` array: the request is left unchanged; `/fast` still updates the global preference and warns when enabling it.
- If a gateway strips `X-Api-Key`: model discovery may still work, but inference fails because the `Authorization` header intentionally contains only the synthetic parser JWT.
- After `/compact`, threshold compaction, or overflow recovery, the provider closes the reused Codex WebSocket for the current session. CLIProxyAPI binds server-side context to the connection, so a reused socket would keep reporting a near-full `cacheRead` and retrigger compaction even though the client context is now small. SSE is unaffected because it bills from the request body.
