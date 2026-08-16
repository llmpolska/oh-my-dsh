# oh-my-dsh

Tiered model routing for DeepSeek Harness, with a **vision tier** that reads images
and an **image-generation model**, all configurable from an **"oh my dsh" tab in the
DSH Desktop settings**. Works in the Web/Desktop surface **and** in the terminal (TUI).

- **think tier** (default: your session default model, e.g. `opencode-go/deepseek-v4-pro (max)`)
  plans, debugs, and reviews.
- **build tier** (default: same provider, `high` effort) does day-to-day implementation.
- **auto mode**: plan mode runs on think, execution runs on build (opusplan-style).
- **vision tier**: messages containing images are routed automatically to an
  image-capable model (default: the first vision model your provider offers, e.g.
  `minimax-m3` on opencode-go). The session returns to its tier on the next text message.
- **image generation**: `omd_image` tool and `/omd image <prompt>` generate images with a
  configured image-capable model. Works with the classic `images/generations` endpoint,
  and with chat models that emit images (e.g. a luna-style GPT) via chat completions with
  image output modalities.
- **high-impact guard**: while the build tier executes, `rm -rf`, `sudo`, force pushes,
  credential/secret file edits, etc. are denied until the session escalates to think.
- **failure auto-escalation**: repeated step errors temporarily escalate to think.
- **advisor / review**: `omd_advisor` and `omd_review` consult the think tier on demand.
- **subagent tiering**: `omd_worker` dispatches task packets to a chosen tier.

## Install

```sh
# pack the plugin (from this directory) and install it into a profile:
pnpm pack
dsh plugin --profile desktop add ./oh-my-dsh-<version>.tgz   # the Desktop app profile
dsh plugin --profile tui add ./oh-my-dsh-<version>.tgz       # terminal (TUI) profile
```

Then **restart DSH Desktop**. On boot the plugin:

1. registers the `oh-my-dsh` settings namespace and the `/omd` configuration endpoint,
2. installs the `oh-my-dsh` agent preset into `$DSH_HOME/.agent-presets` and adopts it
   as the default preset (only when the default is still `standard`),
3. installs the vision-admission wrapper on the api-proxy (image prompts pre-admit
   to the vision model before the image-capability gate),
4. adopts first-boot defaults: think/build take your session default model, vision takes
   the first image-capable model of that provider. All of it stays editable in the tab.

New sessions get the preset (existing sessions keep theirs — create a new session to get
`/omd` and the `omd_*` tools).

In the TUI there is no preset roster: the same plugin activates the agent plane
process-wide, so `/omd` and the tools work out of the box.

## The settings tab

Open DSH Desktop → ⚙ Settings → **oh my dsh**:

- **Routing**: mode (auto/strong/cheap/off), subagent policy, escalation tuning, guard toggle.
- **Think tier**: provider + model + reasoning effort.
- **Build tier**: provider + model + reasoning effort.
- **Vision tier**: picker limited to image-capable models, automatic-routing toggle.
- **Image generation**: provider label, base URL, image model (e.g. a luna-style GPT id),
  API key env var (or an inline key), size, output directory, and the
  "chat completions with image modalities" fallback toggle.

## Slash command

```
/omd status
/omd strong | cheap | auto | off          # per-session tier (think/build aliases work too)
/omd plan                                  # auto + plan mode + think header
/omd models                                # list registered providers and models
/omd set <think|build|vision> <provider> <model> [off|high|max]
/omd subagent <inherit|cheap|strong>
/omd vision [on|off]                       # automatic vision routing
/omd advisor <question>                    # one think-tier consultation
/omd review <focus>                        # think-tier review
/omd image <prompt>                        # generate an image (saved under ./oh-my-dsh-images)
```

## Tools

`omd_status`, `omd_route`, `omd_configure`, `omd_advisor`, `omd_review`, `omd_worker`, `omd_image`.

## Tests

```sh
node --test "tests/**/*.test.mjs"   # 22 unit tests for the guard and tier decisions
node --check lib/index.js && node --check lib/agent.js && node --check lib/client.js
```

## Uninstall

```sh
dsh plugin --profile desktop remove oh-my-dsh
dsh plugin --profile tui remove oh-my-dsh
# optionally: delete $DSH_HOME/.agent-presets/oh-my-dsh and the `oh-my-dsh` section
# in $DSH_HOME/settings.yaml, then set the agent-presets default back to standard.
```

## License

MIT
