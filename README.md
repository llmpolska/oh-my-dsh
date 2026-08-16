# oh-my-dsh

Tiered model routing for DeepSeek Harness: think/build tiers, an omp-style vision
delegation layer (the vision model **only describes** images — the working model does
the work), and image generation through an ordinary chat model — all configured from
an **"oh my dsh" tab in the settings**.

Works on **every DSH surface**: DSH Desktop, the standalone web profile (`dsh web`),
and the terminal (`dsh --profile tui`).

## What you get

- **think tier** (planning, architecture, hard debugging, reviews) and **build tier**
  (day-to-day implementation) — `auto` mode runs plan mode on think and execution on build.
- **vision tier** (omp-style delegation): when a message contains an image, the vision
  model describes it **in the background** and the working tier (think/build) answers
  from that description — so *"build a frontend like this image"* is built by your
  coding model, not by the vision model. The image stays in the chat; image parts are
  substituted with the description in text-only model requests, so later turns never
  fail with unsupported content. The session model never switches for an image.
- **image generation**: the `omd_image` tool and `/omd image <prompt>` generate images
  with a configured model (e.g. `gpt-5.6-luna` on opencode-go, or `gpt-image-2` via
  Codex), saved under `./oh-my-dsh-images/`.
- **high-impact guard**: while the build tier executes, `rm -rf`, `sudo`, force pushes,
  credential/secret file edits, etc. are denied until the session escalates to think.
- **failure auto-escalation**: repeated step errors temporarily escalate to the think tier.
- **advisor / review**: `omd_advisor` and `omd_review` consult the think tier on demand.
- **subagent tiering**: `omd_worker` dispatches bounded task packets to a chosen tier.
- **system prompt section**: every session on the oh-my-dsh preset gets a prompt section
  describing the tiers, the `/omd` command mapping, and the routing rules.

## Installation (easy)

Requirements: DeepSeek Harness Desktop (or the `dsh` CLI) with pnpm available, and a
profile to install into.

### 1. Build the package (from this checkout)

```sh
cd oh-my-dsh
pnpm pack          # produces oh-my-dsh-0.1.0.tgz
```

### 2. Install into a profile

Install the tarball into **every surface you use** (each profile is independent):

```sh
# DSH Desktop app (the profile the desktop app boots — the settings tab lives here)
dsh plugin --profile desktop add ./oh-my-dsh-0.1.0.tgz

# Standalone web app (dsh web / --profile web)
dsh plugin --profile web add ./oh-my-dsh-0.1.0.tgz

# Terminal (TUI)
dsh plugin --profile tui add ./oh-my-dsh-0.1.0.tgz
```

### 3. Restart

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

### Which surface does what

| Surface | Settings tab | `/omd` + `omd_*` tools | Vision describe | Image generation |
|---|---|---|---|---|
| DSH Desktop | ✅ | ✅ | ✅ | ✅ |
| `dsh web` (web profile) | ✅ | ✅ | ✅ | ✅ |
| TUI / headless | — (no settings UI) | ✅ (agent plane activates process-wide) | — (no image prompts) | ✅ |

The plugin is one codebase: the client half (settings tab) is web-platform, the host
half (endpoint, vision wrapper) mounts where a web server exists, and the agent plane
(roles, tools, guard, scrub) activates through the preset on web surfaces or
process-wide in the TUI, where no preset roster exists.

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

## Slash commands

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

## Tools

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

## License

MIT
