# pi-cliproxyapi-provider

Pi provider extension that discovers models from [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) and registers them for use with the `openai-codex-responses` API.

## What it does

1. Registers a provider that always appears in `/login` (subscription path) and via `/cliproxyapi` / `/cpa`.
2. Interactive setup collects `baseUrl` + `apiKey`.
3. Fetches `{root}/v1/models?client_version=pi`.
4. Maps the Codex client catalog into pi models.
5. Registers inference against `{root}/backend-api/` using a **patched** Codex Responses protocol (`cliproxyapi-codex-responses`).

## Install

```bash
pi install /absolute/path/to/pi-cliproxyapi-provider

# or temporarily for one run
pi -e /absolute/path/to/pi-cliproxyapi-provider
```

## Login-style setup (recommended)

This plugin needs both **baseUrl** and **apiKey**. pi's built-in `/login` only supports multi-field prompts on the OAuth/subscription path, so CLIProxyAPI appears under **Use a subscription** (not API key).

### Preferred: dedicated command

```text
/cliproxyapi
```

or short alias:

```text
/cpa
```

### Or use /login shortcuts (skip the menu)

```text
/login CLIProxyAPI
```

or:

```text
/login cliproxyapi
```

### Menu path

```text
/login
```

Then choose:

1. **Use a subscription**  
   (required for multi-field baseUrl + API key prompts)
2. **CLIProxyAPI**
3. Enter:
   - base URL — preferred form is host:port, e.g. `http://127.0.0.1:8317`
   - API key

On success (any of the paths above):

- models are registered immediately in the current session
- credentials are stored in `~/.pi/agent/auth.json`
- `baseUrl` / `apiKey` are also written to `~/.pi/agent/cliproxyapi.json`

Re-run `/cliproxyapi`, `/cpa`, or `/login CLIProxyAPI` anytime to reconfigure.

## Non-interactive configuration

You can still configure without `/login`.

### Config file

`~/.pi/agent/cliproxyapi.json`:

```json
{
  "baseUrl": "http://127.0.0.1:8317",
  "apiKey": "12345"
}
```

Optional fields:

| Field | Default | Description |
|-------|---------|-------------|
| `baseUrl` | `http://127.0.0.1:8317` | CLIProxyAPI address |
| `apiKey` | _(required unless set via /login or env)_ | Bearer token / CPA API key |
| `providerId` | `cliproxyapi` | Provider id shown in `/model` |
| `providerName` | `CLIProxyAPI` | Display name in `/login` and UI |

### Environment overrides

| Variable | Overrides |
|----------|-----------|
| `CLIPROXYAPI_BASE_URL` | `baseUrl` |
| `CLIPROXYAPI_API_KEY` | `apiKey` |
| `CLIPROXYAPI_PROVIDER_ID` | `providerId` |
| `CLIPROXYAPI_PROVIDER_NAME` | `providerName` |

Resolution order for connection settings:

1. Environment variables
2. `cliproxyapi.json`
3. `/login` credentials in `auth.json`
4. Default baseUrl `http://127.0.0.1:8317`

### baseUrl normalization

Preferred form is **host:port only**:

| Input | Inference baseUrl | Models URL |
|-------|-------------------|------------|
| `http://127.0.0.1:8317` | `http://127.0.0.1:8317/backend-api/` | `http://127.0.0.1:8317/v1/models?client_version=pi` |
| `http://127.0.0.1:8317/backend-api` | `http://127.0.0.1:8317/backend-api/` | same models URL |
| `http://127.0.0.1:8317/v1` | `http://127.0.0.1:8317/backend-api/` | same models URL |
| `127.0.0.1:8317` | `http://127.0.0.1:8317/backend-api/` | same models URL |

pi then calls `{inference}/codex/responses` via this package's patched Codex Responses stream implementation.

## Model mapping

From CPA Codex catalog entry → pi model:

| CPA field | Pi field |
|-----------|----------|
| `slug` | `id` |
| `display_name` | `name` |
| `context_window` | `contextWindow` |
| `input_modalities` | `input` (`text` / `image`) |
| `supported_reasoning_levels[].effort` | `thinkingLevelMap` + `reasoning` |
| `visibility: "hide"` | skipped |

Unsupported pi thinking levels are set to `null` so they are hidden in the UI. Cost is reported as zero (proxy pricing is unknown).

## Migration from static models.json

If you previously maintained a static provider such as `cpa-responses` in `~/.pi/agent/models.json`:

1. Install this package and run `/cliproxyapi` or `/login CLIProxyAPI` (or set `cliproxyapi.json`).
2. Point `defaultProvider` / `enabledModels` at `cliproxyapi/<model-id>` (or set `providerId` to `cpa-responses` for a drop-in id).
3. Remove the hand-maintained models array once the dynamic list looks correct.

## Failure behavior

- Before setup / without credentials: provider still appears in `/login` and `/cliproxyapi` is available, but no models are listed yet.
- If CPA is unreachable during startup: a warning is logged, provider stays available for reconfiguration via `/cliproxyapi` or `/login`.
- If setup validation fails (bad baseUrl/key/network): setup fails and nothing is persisted.
