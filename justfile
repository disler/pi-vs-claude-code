set dotenv-load := true

default:
    @just --list

# prime

# Launch Claude Code and run /prime
primecc:
    claude --dangerously-skip-permissions --model "opus[1m]" "/prime"

# Launch Pi and run /prime
primepi:
    pi "/prime"

# g1

# 1. default pi
pi:
    pi

# 2. Pure focus pi: strip footer and status line entirely
ext-pure-focus:
    pi -e extensions/pure-focus.ts

# 3. Minimal pi: model name + 10-block context meter
ext-minimal:
    pi -e extensions/minimal.ts -e extensions/theme-cycler.ts

# 4. Cross-agent pi: load commands from .claude/, .gemini/, .codex/ dirs
ext-cross-agent:
    pi -e extensions/cross-agent.ts -e extensions/minimal.ts

# 5. Purpose gate pi: declare intent before working, persistent widget, focus the system prompt on the ONE PURPOSE for this agent
ext-purpose-gate:
    pi -e extensions/purpose-gate.ts -e extensions/minimal.ts

# 6. Customized footer pi: Tool counter, model, branch, cwd, cost, etc.
ext-tool-counter:
    pi -e extensions/tool-counter.ts

# 7. Tool counter widget: tool call counts in a below-editor widget
ext-tool-counter-widget:
    pi -e extensions/tool-counter-widget.ts -e extensions/minimal.ts

# 8. Subagent widget: /sub <task> with live streaming progress
ext-subagent-widget:
    pi -e extensions/subagent-widget.ts -e extensions/pure-focus.ts -e extensions/theme-cycler.ts

# 9. TillDone: task-driven discipline — define tasks before working
ext-tilldone:
    pi -e extensions/tilldone.ts -e extensions/theme-cycler.ts

#g2

# 10. Agent team: dispatcher orchestrator with team select and grid dashboard
ext-agent-team:
    pi -e extensions/agent-team.ts -e extensions/theme-cycler.ts

# 11. System select: /system to pick an agent persona as system prompt
ext-system-select:
    pi -e extensions/system-select.ts -e extensions/minimal.ts -e extensions/theme-cycler.ts

# 12. Launch with Damage-Control safety auditing
ext-damage-control:
    pi -e extensions/damage-control.ts -e extensions/minimal.ts -e extensions/theme-cycler.ts

# 12b. Damage-Control (continue): same rules, but blocked turns keep running with actionable feedback
ext-damage-control-continue:
    pi -e extensions/damage-control-continue.ts -e extensions/minimal.ts -e extensions/theme-cycler.ts

# 13. Agent chain: sequential pipeline orchestrator
ext-agent-chain:
    pi -e extensions/agent-chain.ts -e extensions/theme-cycler.ts

#g3

# 14. Pi Pi: meta-agent that builds Pi agents with parallel expert research
ext-pi-pi:
    pi -e extensions/pi-pi.ts -e extensions/theme-cycler.ts

# 15. Session Replay: scrollable timeline overlay of session history (legit)
ext-session-replay:
    pi -e extensions/session-replay.ts -e extensions/minimal.ts

# 16. Theme cycler: Ctrl+X forward, Ctrl+Q backward, /theme picker
ext-theme-cycler:
    pi -e extensions/theme-cycler.ts -e extensions/minimal.ts

# utils

# Start pi with one or more stacked extensions in tmux: just open minimal tool-counter
open +exts:
    #!/usr/bin/env bash
    set -euo pipefail
    args=""
    suffix=""
    for ext in {{exts}}; do
        args="$args -e extensions/$ext.ts"
        safe_ext="${ext//[^A-Za-z0-9_.-]/_}"
        suffix="$suffix-$safe_ext"
    done
    session="pi-ext${suffix:-manual}-$(date +%Y%m%d-%H%M%S)"
    tmux new-session -d -s "$session" -c '{{justfile_directory()}}' "pi$args"
    echo "Started tmux session: $session"
    echo "Attach with: tmux attach -t $session"

    if [[ "${OPENCLAW_ALLOW_TERMINAL_WINDOWS:-0}" == "1" || "${OPENCLAW_PI_LAUNCH_MODE:-}" == "visible" ]]; then
        attach_cmd="tmux attach-session -t $session"
        escaped="${attach_cmd//\\/\\\\}"
        escaped="${escaped//\"/\\\"}"
        mkdir -p "$HOME/.openclaw/logs"
        printf '%s\tpid=%s\tsession=%s\tjust=open\targs=%s\n' \
            "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$$" "$session" "$args" \
            >> "$HOME/.openclaw/logs/terminal-launches.log"
        osascript -e "tell application \"Terminal\" to do script \"$escaped\""
    fi

# Start every extension in its own tmux session
all:
    just open pi
    just open pure-focus 
    just open minimal theme-cycler
    just open cross-agent minimal
    just open purpose-gate minimal
    just open tool-counter
    just open tool-counter-widget minimal
    just open subagent-widget pure-focus theme-cycler
    just open tilldone theme-cycler
    just open agent-team theme-cycler
    just open system-select minimal theme-cycler
    just open damage-control minimal theme-cycler
    just open agent-chain theme-cycler
    just open pi-pi theme-cycler

# ------------------------ coms + coms-net (HTTP/SSE hub) ------------------------

# Coms: peer-to-peer, same machine messaging between Pi agents
# Agent name flag is --cname (pi owns --name). Pass both so pi's session and the
# coms agent share a name, e.g.: just local-coms --name dev --cname dev --color "#72F1B8"
local-coms *args:
    pi -e extensions/coms.ts -e extensions/minimal.ts -e extensions/theme-cycler.ts {{args}}

# Start a local coms-net server (binds 127.0.0.1, OS-claimed port)
# Auto-kills any stale process holding the pinned port first.
coms-net-server:
    -lsof -ti :${PI_COMS_NET_PORT:-52965} | xargs -r kill -TERM 2>/dev/null
    bun scripts/coms-net-server.ts

# Start a LAN-visible coms-net server (binds 0.0.0.0, requires PI_COMS_NET_AUTH_TOKEN)
# Auto-kills any stale process holding the pinned port first.
coms-net-server-lan:
    -lsof -ti :${PI_COMS_NET_PORT:-52965} | xargs -r kill -TERM 2>/dev/null
    PI_COMS_NET_HOST=0.0.0.0 bun scripts/coms-net-server.ts

# Pi with networked coms client (auto-discovers local server.json)
# Agent name flag is --cname (pi owns --name). Pass both so pi's session and the
# coms-net agent share a name, e.g.: just coms --name dev --cname dev --server-url http://… --auth-token …
coms *args:
    pi -e extensions/coms-net.ts -e extensions/minimal.ts -e extensions/theme-cycler.ts {{args}}

# coms-net with gpt-5.5 (extra args still pass through, e.g. --name dev --cname dev)
coms1 *args:
    pi -e extensions/coms-net.ts -e extensions/minimal.ts -e extensions/theme-cycler.ts --provider openai --model gpt-5.5 {{args}}

# coms-net with claude-opus-4-7
coms2 *args:
    pi -e extensions/coms-net.ts -e extensions/minimal.ts -e extensions/theme-cycler.ts --model claude-opus-4-7 {{args}}

# coms-net with deepseek/deepseek-v4-pro
coms3 *args:
    pi -e extensions/coms-net.ts -e extensions/minimal.ts -e extensions/theme-cycler.ts --model deepseek/deepseek-v4-pro {{args}}

# coms-net with z-ai/glm-5.1
coms4 *args:
    pi -e extensions/coms-net.ts -e extensions/minimal.ts -e extensions/theme-cycler.ts --model z-ai/glm-5.1 {{args}}
