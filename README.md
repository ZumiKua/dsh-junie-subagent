# @zumikua/dsh-junie-subagent

English | [中文](README.zh.md)

Delegates one task to the JetBrains Junie CLI over the Agent Client Protocol and
returns Junie's final answer as a subagent result.

## Requirements

- DSH `>= 0.2.1-rc.2`;
- the JetBrains Junie CLI installed and signed in — the provider resolves
  `junie.exe` from `~/.local/share/junie/current` and fails loudly when it
  cannot start it.

## Install

Open the **Plugins** page in the DSH Web UI and install `@zumikua/dsh-junie-subagent`
from the catalog; the plugin manager installs the package and selects its bundle
in one step. The bundle patch inserts one provider and one `dsh-tool-subagent`
instance named `junie`.

Restart DSH once after installing: the browser half (`client.js`) enters the
page's module table at startup. Then open **Settings → Junie** and pick a model
and thinking depth.

## How one run works

```
spawn <junie.exe> --acp=true --skip-update-check
  → initialize
  → session/new { cwd, mcpServers: [] }
  → session/set_config_option (model / effort / brave_mode, when configured)
  → session/prompt { prompt: [{ type: "text", text }] }
  ← session/update … agent_message_chunk text …
  ← result { stopReason }
  → dispose (session/cancel, stdin EOF, terminate, wait for exit)
```

Each run owns its own process and session: the subagent seam has no
continuation surface for out-of-process children, so a run accepts no follow-up
message.

## Confinement

The child is spawned through `ctx.subprocess` **without** a sandbox policy. It
therefore runs as the signed-in user with that user's full file access — which
is what lets Junie persist sessions under `~/.junie`. Confinement is Junie's own
permission model: `brave_mode`, the action allowlist, and
`session/request_permission`, which this provider answers from `permission`.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `providerName` | `junie` | Name on `ctx.subagents` |
| `command` | managed install | `junie.exe` path; resolved from `~/.local/share/junie/current` when omitted |
| `args` | `["--acp=true"]` | Extra arguments; `--acp=true` and `--skip-update-check` are always ensured |
| `model` | `mix.normal` | Fallback model when the settings page has stored none |
| `effort` | `high` | Fallback effort when the settings page has stored none |
| `braveMode` | `brave-auto` | `brave-auto` / `on` / `off` |
| `permission` | `reject` | Auto-answer `session/request_permission` with reject (default) or the first allow option |
| `timeoutMs` | `900000` | Whole-run bound |
| `graceMs` | `3000` | Subprocess teardown grace |

## Choosing a model

The bundle registers exactly one provider (`junie`) and one model-facing tool
(`junie`). The model and the thinking depth are chosen on the settings page and
stored by the Host; the `model` / `effort` keys above are only the fallback used
before anything is stored.

Per-call model selection through the shared `provider` / `model` /
`reasoning_effort` tool fields is **not** available: `dsh-tool-subagent`
validates those against the Host's LLM catalog (`llm.resolveCallConfig`), and
Junie model ids are not LLM routes — which is also why the official Codex,
Claude Code, and ACP providers advertise no `agentOptions` capability.

## Settings page and storage

1. The page is the **Junie** section in the settings panel; it picks the model,
   the thinking depth, and Junie's brave mode (`auto` / `on` / `off`).
2. Values are read and written through a same-origin route the Host registers —
   `GET/PUT /junie-subagent/config` — and stored in `~/.dsh/junie-settings.json`.
3. The model list comes from the `configOptions` of Junie's own ACP
   `session/new` (rendered by group, cached for ten minutes, costs no credits).
4. Thinking depths are model-specific. Saving validates the pair against a
   throwaway Junie session; an unsupported combination answers `400` with the
   values that model accepts, and the option list in the page is left untouched.
5. A change applies from the next delegation. The provider never prompts: it
   rejects every permission request, so `brave-auto` allows safe work and rejects
   the rest, `off` rejects everything that would need approval, and `on` runs everything.
