# oh-my-dsh

**Tiered model routing plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)** — split every session into **think** and **build** model tiers, delegate image understanding to a **vision model** (it only describes — your coding model does the work), and generate **images** from an ordinary chat model. Configured from a settings tab, no YAML editing.

[![License: MIT](https://img.shields.io/github/license/llmpolska/oh-my-dsh)](https://github.com/llmpolska/oh-my-dsh/blob/main/LICENSE)
[![Release](https://img.shields.io/github/v/release/llmpolska/oh-my-dsh)](https://github.com/llmpolska/oh-my-dsh/releases)
[![Stars](https://img.shields.io/github/stars/llmpolska/oh-my-dsh)](https://github.com/llmpolska/oh-my-dsh/stargazers)

Works on **every DSH surface**: DSH Desktop, the standalone web profile (`dsh web`),
and the terminal (`dsh --profile tui`).

## Why oh-my-dsh?

Running every step of a coding session on a frontier model is expensive and slow.
oh-my-dsh gives the agent **tiers**: a strong (think) model for planning, architecture
and hard debugging, a cheaper (build) model for day-to-day implementation, an
automatic **vision delegation** layer for images (the vision model describes, the
working model acts), and an image-generation path — all without switching sessions
manually and without YAML configuration.

## Features

- **Think / Build tiers** — plan mode runs on the strong model, execution on the
  cheap one (`auto` mode; per-session override with `/omd strong|cheap`).
- **Vision delegation (omp-style)** — paste a screenshot of a website and say
  *"build this frontend"*: the vision model describes it **in the background** and
  the working tier answers from that description. The image stays in the chat, the
  session model never switches, and later turns never fail with unsupported content.
- **Image generation** — `omd_image` tool and `/omd image <prompt>` generate images
  with a configured chat model (e.g. `gpt-5.6-luna` on opencode-go, `gpt-image-2`
  via Codex), saved under `./oh-my-dsh-images/`.
- **High-impact guard** — `rm -rf`, `sudo`, force pushes and credential/secret file
  edits are denied while the build tier executes until the session escalates to think.
- **Failure auto-escalation** — repeated model-step errors temporarily escalate to
  the think tier.
- **Advisor / Reviewer** — `omd_advisor` and `omd_review` consult the think tier on
  demand, before risky decisions and high-risk merges.
- **Subagent tiering** — `omd_worker` dispatches bounded task packets to a chosen tier.
- **System prompt section** — every session gets a prompt section describing the
  tiers, the `/omd` command mapping and the routing rules.
- **Settings tab** — providers, models, reasoning efforts, guard and escalation
  tuning from the "oh my dsh" tab in DSH Desktop settings.

## Installation (easy)

Requirements: DeepSeek Harness Desktop (or the `dsh` CLI) and an internet connection —
the `dsh plugin` command manages pnpm itself, nothing else to install.

### Quickstart — install straight from the GitHub repo (no local download)

Install into **every surface you use** (each profile is independent):

```sh
# DSH Desktop app (the profile the desktop app boots — the settings tab lives here)
dsh plugin --profile desktop add github:llmpolska/oh-my-dsh#v0.1.0

# Standalone web app (dsh web / --profile web)
dsh plugin --profile web add github:llmpolska/oh-my-dsh#v0.1.0

# Terminal (TUI)
dsh plugin --profile tui add github:llmpolska/oh-my-dsh#v0.1.0
```

The `#v0.1.0` suffix pins the exact release tag. The package has **no build step**
(no `prepare` script), so pnpm installs it directly — no `allowBuilds` configuration
is needed. The command also activates the plugin as a profile layer automatically.

### Restart

**Fully restart DSH Desktop** (Cmd+Q → relaunch) or restart the `dsh` process. The
plugin's host half loads at profile boot — a window refresh is not enough.

On boot the plugin:

1. registers the `oh-my-dsh` settings namespace and the `/omd` configuration endpoint,
2. installs the `oh-my-dsh` agent preset into `$DSH_HOME/.agent-presets` and adopts it
   as the default preset (only when the default is still `standard`),
3. installs the vision-describe wrapper on the api-proxy (the image gate is passed via a
   brief vision header, the turn stays on the working tier, and a background vision
   description is queued) and the history scrub on `llm.streamWithRegistration` (image
   parts are replaced by the description for text-only models),
4. adopts first-boot defaults: think/build take your session default model, vision takes
   the first image-capable model of that provider. Everything stays editable in the tab.

> **New sessions** get the preset (existing sessions keep theirs — create a new session
> to get `/omd` and the `omd_*` tools).

### Alternative: install from a local tarball (offline / development)

```sh
cd oh-my-dsh
pnpm pack                        # produces oh-my-dsh-0.1.0.tgz
dsh plugin --profile desktop add ./oh-my-dsh-0.1.0.tgz
dsh plugin --profile web add ./oh-my-dsh-0.1.0.tgz
dsh plugin --profile tui add ./oh-my-dsh-0.1.0.tgz
```

A local path install (`dsh plugin add /path/to/oh-my-dsh`) links the checkout as-is —
after changing `lib/`, just restart the app.

## Which surface does what

| Surface | Settings tab | `/omd` + `omd_*` tools | Vision describe | Image generation |
|---|---|---|---|---|
| DSH Desktop | ✅ | ✅ | ✅ | ✅ |
| `dsh web` (web profile) | ✅ | ✅ | ✅ | ✅ |
| TUI / headless | — (no settings UI) | ✅ (agent plane activates process-wide) | — (no image prompts) | ✅ |

The plugin is one codebase: the client half (settings tab) is web-platform, the host
half (endpoint, vision wrapper) mounts where a web server exists, and the agent plane
(roles, tools, guard, scrub) activates through the preset on web surfaces or
process-wide in the TUI, where no preset roster exists.

## Usage

### Slash commands

```
/omd status
/omd strong | cheap | auto | off          # per-session tier (think/build aliases work too)
/omd plan                                  # auto + plan mode + think header
/omd models                                # list registered providers and models
/omd set <think|build|vision> <provider> <model> [off|high|max]
/omd subagent <inherit|cheap|strong>
/omd advisor <question>                    # one think-tier consultation
/omd review <focus>                        # think-tier review
/omd image <prompt>                        # generate an image (saved under ./oh-my-dsh-images)
```

The automatic vision description (visionAuto) is toggled in the settings tab; the
describing model is set with `/omd set vision <provider> <model>`.

### Tools

`omd_status`, `omd_route`, `omd_configure`, `omd_advisor`, `omd_review`, `omd_worker`,
`omd_image`.

## How the vision delegation works

1. You send an image → the message appears **immediately** in the chat, image intact.
2. The vision model describes the image **in the background** (one vision call; the
   description is cached keyed by the image's sha256).
3. The turn runs on the **working tier** (think/build): its first request waits for the
   description, then answers from it — the vision model never runs a turn.
4. Later turns: the image part in history is replaced by the description for text-only
   models, so nothing ever fails with unsupported content.

## The settings tab

Open DSH Desktop → ⚙ Settings → **oh my dsh**:

- **Routing**: mode (auto/strong/cheap/off), subagent policy, escalation tuning, guard toggle.
- **Think tier**: provider + model + reasoning effort.
- **Build tier**: provider + model + reasoning effort.
- **Vision tier**: picker limited to image-capable models, auto-describe toggle.
- **Image generation**: provider picker (registered providers — the plugin derives the
  base URL and reuses the provider's API key) + model id (e.g. `gpt-5.6-luna`), size,
  output directory, and the "image output modalities" toggle. The "custom endpoint"
  option is the manual fallback (base URL + API key env var/inline key).

## For developers

- `lib/index.js` — host half: `/omd` endpoint, vision describe wrapper, preset install.
- `lib/agent.js` — agent plane: tier routing, guard, escalation, `omd_*` tools,
  prompt section, `llm.streamWithRegistration` history scrub.
- `lib/client.js` — the "oh my dsh" settings tab (plain JS, served by the shell).
- `lib/config.js` — settings schema and shared state (incl. the vision description store).

## Tests

```sh
node --test "tests/**/*.test.mjs"   # 25 unit tests for the guard and tier decisions
node --check lib/index.js && node --check lib/agent.js && node --check lib/client.js
```

## Uninstall

```sh
dsh plugin --profile desktop remove oh-my-dsh
dsh plugin --profile web remove oh-my-dsh
dsh plugin --profile tui remove oh-my-dsh
# optionally: delete $DSH_HOME/.agent-presets/oh-my-dsh and the `oh-my-dsh` section
# in $DSH_HOME/settings.yaml, then set the agent-presets default back to standard.
```

## Keywords

deepseek-harness · dsh-plugin · dsh · llm · model-routing · tiered-routing ·
coding-agent · vision-model · image-generation · open-source · plugin

## License

MIT

---

**Built and maintained by [LLM Polska](https://llmpolska.pl)** — plugins, tools and
automations for DeepSeek Harness. [https://llmpolska.pl](https://llmpolska.pl)
