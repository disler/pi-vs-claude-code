#!/usr/bin/env bash
set -euo pipefail

# INCIDENT GUARD (2026-06-13): never pipe a pi agent's interactive TUI to a log
# file (e.g. `tmux pipe-pane` to ~/.openclaw/logs/pi-team-*/<agent>.log, or
# `pi ... | tee file`). The TUI re-renders continuously, so a non-TTY sink
# captures every frame and grows without bound — this filled the root disk to
# 100% and ENOSPC-crashed the whole team (self-improvement-lead.log alone hit
# 68GB in ~2.5h). The mineable record already exists as structured JSONL under
# ~/.pi/agent/sessions/ (pi --session-dir); use that for observability. If you
# must capture human-readable per-agent logs, strip ANSI and size-cap them; the
# improver monitor (dark-factory-improver-monitor / 30-min cron) caps
# any log over 500MB as a backstop and pages Telegram on disk/log/team-down.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODEL_PRESET_DIR="${OPENCLAW_PI_MODEL_PRESET_DIR:-$ROOT/.pi/openclaw-teams/model-presets}"
OPENCLAW_PI_MODEL_PRESET="${OPENCLAW_PI_MODEL_PRESET:-codex-default}"
PI_VISIBLE="${OPENCLAW_PI_VISIBLE:-$HOME/.openclaw/workspace/bin/pi-visible}"
LAUNCH_MODE="${OPENCLAW_PI_LAUNCH_MODE:-background}"
WEBWRIGHT_ROOT="${OPENCLAW_WEBWRIGHT_ROOT:-$HOME/.openclaw/workspace/tools/webwright}"
WEBWRIGHT_SKILL="${OPENCLAW_WEBWRIGHT_SKILL:-$WEBWRIGHT_ROOT/skills/webwright}"
TEAM_SKILLS_DIR="${OPENCLAW_PI_TEAM_SKILLS_DIR:-$ROOT/.pi/openclaw-teams/skills}"
CLAUDE_BRIDGE_EXTENSION="${OPENCLAW_CLAUDE_BRIDGE_EXTENSION:-extensions/claude-code-bridge.ts}"
GEMINI_BRIDGE_EXTENSION="${OPENCLAW_GEMINI_BRIDGE_EXTENSION:-extensions/gemini-cli-bridge.ts}"
CLAUDE_OAUTH_KEYCHAIN_SERVICE="${OPENCLAW_CLAUDE_OAUTH_KEYCHAIN_SERVICE:-openclaw-claude-code-oauth-token}"
DYNAMIC_WORKFLOWS_ENABLED="${OPENCLAW_PI_DYNAMIC_WORKFLOWS_ENABLED:-1}"
DYNAMIC_WORKFLOWS_EXTENSION="${OPENCLAW_PI_DYNAMIC_WORKFLOWS_EXTENSION:-/opt/homebrew/lib/node_modules/pi-dynamic-workflows/extensions/workflow.ts}"
AUTH_TOKEN="${PI_COMS_NET_AUTH_TOKEN:-devtoken}"
TEAM_NAMESPACE="${OPENCLAW_PI_TEAM_NAMESPACE:-}"
SAFE_TEAM_NAMESPACE="${TEAM_NAMESPACE//[^a-zA-Z0-9_.-]/-}"
USER_OPENCLAW_PI_MODEL_MEMORY_WORKER_SET="${OPENCLAW_PI_MODEL_MEMORY_WORKER+x}"
USER_OPENCLAW_PI_MODEL_SELF_IMPROVEMENT_WORKER_SET="${OPENCLAW_PI_MODEL_SELF_IMPROVEMENT_WORKER+x}"

list_model_presets() {
  local file
  local name
  local found=0

  if [[ -d "$MODEL_PRESET_DIR" ]]; then
    for file in "$MODEL_PRESET_DIR"/*.env; do
      [[ -e "$file" ]] || continue
      name="${file##*/}"
      printf '%s\n' "${name%.env}"
      found=1
    done
  fi

  if [[ "$found" == "0" ]]; then
    printf '%s\n' "(none)"
  fi
}

load_model_preset() {
  local preset="$OPENCLAW_PI_MODEL_PRESET"
  local preset_file="$MODEL_PRESET_DIR/$preset.env"
  local line
  local key
  local value

  if [[ ! "$preset" =~ ^[A-Za-z0-9_.-]+$ ]]; then
    echo "Invalid OPENCLAW_PI_MODEL_PRESET '$preset'." >&2
    exit 2
  fi

  if [[ ! -f "$preset_file" ]]; then
    echo "Unknown OPENCLAW_PI_MODEL_PRESET '$preset'." >&2
    echo "Available presets:" >&2
    list_model_presets >&2
    exit 2
  fi

  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*$ ]] && continue
    [[ "$line" =~ ^[[:space:]]*# ]] && continue

    if [[ "$line" != *=* ]]; then
      echo "Invalid preset line in $preset_file: $line" >&2
      exit 2
    fi

    key="${line%%=*}"
    value="${line#*=}"

    if [[ ! "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
      echo "Invalid preset variable in $preset_file: $key" >&2
      exit 2
    fi

    if [[ -z "${!key+x}" ]]; then
      export "$key=$value"
    fi
  done < "$preset_file"
}

load_model_preset
export OPENCLAW_PI_MODEL_PRESET

CLAUDE_BRIDGE_ENABLED="${OPENCLAW_CLAUDE_BRIDGE_ENABLED:-1}"
GEMINI_BRIDGE_ENABLED="${OPENCLAW_GEMINI_BRIDGE_ENABLED:-0}"

case "$LAUNCH_MODE" in
  background|visible)
    ;;
  *)
    echo "Invalid OPENCLAW_PI_LAUNCH_MODE '$LAUNCH_MODE'." >&2
    echo "Expected: background or visible" >&2
    exit 2
    ;;
esac

: "${OPENCLAW_CLAUDE_BRIDGE_MODEL:=claude-opus-4-8}"
: "${OPENCLAW_CLAUDE_BRIDGE_EFFORT:=max}"
export OPENCLAW_CLAUDE_BRIDGE_MODEL OPENCLAW_CLAUDE_BRIDGE_EFFORT

if [[ -n "$SAFE_TEAM_NAMESPACE" ]]; then
  DEFAULT_PROJECT="$SAFE_TEAM_NAMESPACE"
  DEFAULT_SESSION_PREFIX="pi-team-$SAFE_TEAM_NAMESPACE"
  DEFAULT_HUB_SESSION="pi-coms-net-hub-$SAFE_TEAM_NAMESPACE"
  TEAM_NAMESPACE_HASH="$(printf '%s' "$SAFE_TEAM_NAMESPACE" | cksum | awk '{print $1}')"
  DEFAULT_PORT="$((53000 + (TEAM_NAMESPACE_HASH % 1000)))"
else
  DEFAULT_PROJECT="openclaw"
  DEFAULT_SESSION_PREFIX="pi-team"
  DEFAULT_HUB_SESSION="pi-coms-net-hub"
  DEFAULT_PORT="52965"
fi

PROJECT="${PI_COMS_NET_PROJECT:-$DEFAULT_PROJECT}"
SESSION_PREFIX="${OPENCLAW_PI_TEAM_SESSION_PREFIX:-$DEFAULT_SESSION_PREFIX}"
SESSION_PREFIX="${SESSION_PREFIX//[^a-zA-Z0-9_.-]/-}"
PORT="${PI_COMS_NET_PORT:-$DEFAULT_PORT}"
SERVER_URL="${PI_COMS_NET_SERVER_URL:-http://127.0.0.1:$PORT}"
HUB_SESSION="${OPENCLAW_PI_HUB_SESSION:-$DEFAULT_HUB_SESSION}"

export PATH="$HOME/.openclaw/workspace/bin:$PATH"

load_claude_oauth_token() {
  if [[ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" || "$CLAUDE_BRIDGE_ENABLED" == "0" ]]; then
    return
  fi

  if ! command -v security >/dev/null 2>&1; then
    return
  fi

  local token
  token="$(security find-generic-password -a "$USER" -s "$CLAUDE_OAUTH_KEYCHAIN_SERVICE" -w 2>/dev/null || true)"
  if [[ -n "$token" ]]; then
    export CLAUDE_CODE_OAUTH_TOKEN="$token"
  fi
}

load_claude_oauth_token

provider_for_model() {
  local model="$1"
  if [[ "$model" == */* ]]; then
    printf '%s\n' "${model%%/*}"
  else
    printf '%s\n' "$model"
  fi
}

ensure_pi_provider_for_model() {
  local name="$1"
  local model="$2"
  local provider
  local pi_auth="$HOME/.pi/agent/auth.json"

  provider="$(provider_for_model "$model")"
  if [[ -f "$pi_auth" ]] && grep -q "\"$provider\"" "$pi_auth"; then
    return
  fi

  echo "Pi auth provider '$provider' is required for $name shell model: $model" >&2
  echo "This is a Pi shell/provider check only. Claude Code subscription auth is used only through claude_code_run." >&2
  echo "Run: pi auth login $provider" >&2
  exit 1
}

opus_required_role() {
  case "$1" in
    pi-orchestrator|\
    planning-lead|product-planner|architecture-planner|\
    implementation-lead|research-lead|verification-lead|browser-qa-lead|security-lead|\
    self-improvement-lead|memory-librarian|docs-release-lead|problem-solving-lead|\
    security-reviewer|dependency-auditor|tenant-isolation-reviewer|data-sovereignty-reviewer|\
    authz-reviewer|data-exposure-reviewer|injection-reviewer|research-risk-compliance)
      return 0
      ;;
  esac

  return 1
}

ensure_claude_bridge_for_opus_role() {
  local name="$1"

  opus_required_role "$name" || return 0

  if [[ "$OPENCLAW_PI_MODEL_PRESET" == "gemini-default" ]]; then
    return 0
  fi

  if [[ "$CLAUDE_BRIDGE_ENABLED" == "0" ]]; then
    echo "$name requires Claude Code Opus 4.8 max via claude_code_run, but OPENCLAW_CLAUDE_BRIDGE_ENABLED=0." >&2
    echo "Stop and escalate instead of falling back to a Pi model." >&2
    exit 1
  fi

  if [[ ! -f "$ROOT/$CLAUDE_BRIDGE_EXTENSION" ]]; then
    echo "$name requires Claude Code Opus 4.8 max via claude_code_run, but the bridge extension is missing: $ROOT/$CLAUDE_BRIDGE_EXTENSION" >&2
    echo "Stop and escalate instead of falling back to a Pi model." >&2
    exit 1
  fi

  if ! command -v "${OPENCLAW_CLAUDE_BIN:-claude}" >/dev/null 2>&1; then
    echo "$name requires Claude Code Opus 4.8 max via claude_code_run, but the Claude Code CLI was not found." >&2
    echo "Stop and escalate instead of falling back to a Pi model." >&2
    exit 1
  fi
}

thinking_for_model() {
  local model="$1"
  if [[ "$model" == *":xhigh" ]]; then
    echo "xhigh"
  elif [[ "$model" == *":high" ]]; then
    echo "high"
  elif [[ "$model" == *":medium" ]]; then
    echo "medium"
  elif [[ "$model" == *":low" ]]; then
    echo "low"
  else
    echo "high"
  fi
}

DEFAULT_CONTROLLER_MODEL="${OPENCLAW_PI_MODEL_ALL:-openai-codex/gpt-5.3-codex-spark:xhigh}"
DEFAULT_WORKER_MODEL="${OPENCLAW_PI_MODEL_ALL:-$DEFAULT_CONTROLLER_MODEL}"
MODEL_CONTROLLER="${OPENCLAW_PI_MODEL_CONTROLLER:-$DEFAULT_CONTROLLER_MODEL}"
MODEL_ORCH="${OPENCLAW_PI_MODEL_ORCH:-$MODEL_CONTROLLER}"
MODEL_LEAD="${OPENCLAW_PI_MODEL_LEAD_CONTROLLER:-${OPENCLAW_PI_MODEL_LEAD:-$MODEL_CONTROLLER}}"
MODEL_PLANNING="${OPENCLAW_PI_MODEL_PLANNING:-$MODEL_CONTROLLER}"
MODEL_SECURITY="${OPENCLAW_PI_MODEL_SECURITY:-$MODEL_CONTROLLER}"
MODEL_RESEARCH_LEAD="${OPENCLAW_PI_MODEL_RESEARCH_LEAD:-${OPENCLAW_PI_MODEL_RESEARCH:-$MODEL_CONTROLLER}}"
MODEL_RESEARCH_WORKER="${OPENCLAW_PI_MODEL_RESEARCH_WORKER:-${OPENCLAW_PI_MODEL_RESEARCH:-${OPENCLAW_PI_MODEL_WORKER:-$DEFAULT_WORKER_MODEL}}}"
MODEL_PROBLEM_LEAD="${OPENCLAW_PI_MODEL_PROBLEM_LEAD:-${OPENCLAW_PI_MODEL_PROBLEM:-$MODEL_CONTROLLER}}"
MODEL_PROBLEM_WORKER="${OPENCLAW_PI_MODEL_PROBLEM_WORKER:-${OPENCLAW_PI_MODEL_PROBLEM:-${OPENCLAW_PI_MODEL_WORKER:-$DEFAULT_WORKER_MODEL}}}"
MODEL_SELF_IMPROVEMENT_LEAD="${OPENCLAW_PI_MODEL_SELF_IMPROVEMENT_LEAD:-${OPENCLAW_PI_MODEL_SELF_IMPROVEMENT:-$MODEL_CONTROLLER}}"
MODEL_ARCHITECT="${OPENCLAW_PI_MODEL_ARCHITECT:-$MODEL_PLANNING}"
MODEL_DOCS_RELEASE_LEAD="${OPENCLAW_PI_MODEL_DOCS_RELEASE_LEAD:-$MODEL_CONTROLLER}"
MODEL_WORKER="${OPENCLAW_PI_MODEL_WORKER:-$DEFAULT_WORKER_MODEL}"
MODEL_MEMORY_WORKER="${OPENCLAW_PI_MODEL_MEMORY_WORKER:-$MODEL_WORKER}"
if [[ -n "$USER_OPENCLAW_PI_MODEL_SELF_IMPROVEMENT_WORKER_SET" ]]; then
  MODEL_SELF_IMPROVEMENT_WORKER="$OPENCLAW_PI_MODEL_SELF_IMPROVEMENT_WORKER"
elif [[ -n "$USER_OPENCLAW_PI_MODEL_MEMORY_WORKER_SET" ]]; then
  MODEL_SELF_IMPROVEMENT_WORKER="$OPENCLAW_PI_MODEL_MEMORY_WORKER"
else
  MODEL_SELF_IMPROVEMENT_WORKER="${OPENCLAW_PI_MODEL_SELF_IMPROVEMENT_WORKER:-${OPENCLAW_PI_MODEL_SELF_IMPROVEMENT:-$MODEL_MEMORY_WORKER}}"
fi

normalize_gemini_cli_model() {
  local model="$1"
  printf '%s\n' "$model"
}

if [[ "$OPENCLAW_PI_MODEL_PRESET" == "gemini-default" ]]; then
  MODEL_CONTROLLER="$(normalize_gemini_cli_model "$MODEL_CONTROLLER")"
  MODEL_ORCH="$(normalize_gemini_cli_model "$MODEL_ORCH")"
  MODEL_LEAD="$(normalize_gemini_cli_model "$MODEL_LEAD")"
  MODEL_PLANNING="$(normalize_gemini_cli_model "$MODEL_PLANNING")"
  MODEL_SECURITY="$(normalize_gemini_cli_model "$MODEL_SECURITY")"
  MODEL_RESEARCH_LEAD="$(normalize_gemini_cli_model "$MODEL_RESEARCH_LEAD")"
  MODEL_RESEARCH_WORKER="$(normalize_gemini_cli_model "$MODEL_RESEARCH_WORKER")"
  MODEL_PROBLEM_LEAD="$(normalize_gemini_cli_model "$MODEL_PROBLEM_LEAD")"
  MODEL_PROBLEM_WORKER="$(normalize_gemini_cli_model "$MODEL_PROBLEM_WORKER")"
  MODEL_SELF_IMPROVEMENT_LEAD="$(normalize_gemini_cli_model "$MODEL_SELF_IMPROVEMENT_LEAD")"
  MODEL_ARCHITECT="$(normalize_gemini_cli_model "$MODEL_ARCHITECT")"
  MODEL_DOCS_RELEASE_LEAD="$(normalize_gemini_cli_model "$MODEL_DOCS_RELEASE_LEAD")"
  MODEL_WORKER="$(normalize_gemini_cli_model "$MODEL_WORKER")"
  MODEL_MEMORY_WORKER="$(normalize_gemini_cli_model "$MODEL_MEMORY_WORKER")"
  MODEL_SELF_IMPROVEMENT_WORKER="$(normalize_gemini_cli_model "$MODEL_SELF_IMPROVEMENT_WORKER")"

fi

usage() {
  cat <<'USAGE'
Usage: scripts/openclaw-team.sh <core|research|problem|full|status|stop>

core    Launch orchestrator and team leads.
research
        Launch core plus dedicated research-council workers.
problem Launch core plus dedicated hard-problem solver workers.
full    Launch orchestrator, team leads, and workers.
status  Show hub and agent tmux sessions.
stop    Stop OpenClaw team tmux sessions, leaving unrelated Pi sessions alone.

Parallel project streams:
  OPENCLAW_PI_TEAM_NAMESPACE=stage-main scripts/openclaw-team.sh full

Model preset selection:
  OPENCLAW_PI_MODEL_PRESET=gemini-default scripts/openclaw-team.sh status
  OPENCLAW_PI_MODEL_PRESET=codex-default scripts/openclaw-team.sh status
  OPENCLAW_PI_MODEL_PRESET=claude-default scripts/openclaw-team.sh full

Launch mode:
  Default is detached tmux/background sessions with no Terminal windows.
  Use OPENCLAW_PI_LAUNCH_MODE=visible only when Samuel explicitly wants
  macOS Terminal windows opened for the team.

The namespace changes the default project id, hub session, port, and tmux
session prefix so multiple teams can run without fixed-name collisions.
USAGE
}

ensure_hub() {
  if curl -fsS "$SERVER_URL/health" >/dev/null 2>&1; then
    return
  fi

  if tmux has-session -t "$HUB_SESSION" 2>/dev/null; then
    tmux kill-session -t "$HUB_SESSION"
  fi

  tmux new-session -d -s "$HUB_SESSION" -c "$ROOT" \
    "PI_COMS_NET_AUTH_TOKEN='$AUTH_TOKEN' PI_COMS_NET_PROJECT='$PROJECT' PI_COMS_NET_PORT='$PORT' bun scripts/coms-net-server.ts"

  for _ in {1..30}; do
    if curl -fsS "$SERVER_URL/health" >/dev/null 2>&1; then
      return
    fi
    sleep 0.5
  done

  echo "Hub did not become healthy at $SERVER_URL" >&2
  exit 1
}

skills_for() {
  case "$1" in
    planning-lead|product-planner|architecture-planner)
      printf '%s\n' quillio-house library-docs plan discover ;;
    implementation-lead|backend-implementer)
      printf '%s\n' quillio-house library-docs quillio-integration quillio-integration-backend api-service type-definitions quality-checks ;;
    frontend-implementer)
      printf '%s\n' quillio-house library-docs quillio-integration-frontend api-service composable-query vue-component api-integration type-definitions quality-checks ;;
    verification-lead|test-engineer)
      printf '%s\n' quillio-house library-docs discover quillio-integration-tests code-review quality-checks ;;
    security-lead|security-reviewer|dependency-auditor|tenant-isolation-reviewer|data-sovereignty-reviewer|authz-reviewer|data-exposure-reviewer|injection-reviewer)
      printf '%s\n' quillio-house library-docs security-scan ;;
    problem-solving-lead)
      printf '%s\n' quillio-house library-docs discover plan ;;
    problem-root-cause-solver)
      printf '%s\n' quillio-house library-docs discover quality-checks ;;
    problem-implementation-solver)
      printf '%s\n' quillio-house library-docs plan quality-checks ;;
    problem-test-repro-solver)
      printf '%s\n' quillio-house library-docs quillio-integration-tests quality-checks ;;
    problem-risk-skeptic)
      printf '%s\n' quillio-house library-docs code-review security-scan ;;
    problem-synthesis-judge)
      printf '%s\n' quillio-house library-docs plan code-review ;;
    *)
      printf '%s\n' quillio-house library-docs ;;
  esac
}

launch_agent() {
  local name="$1"
  local purpose="$2"
  local color="$3"
  local prompt="$4"
  local model="$5"
  local session="$SESSION_PREFIX-$name"
  local skill_args=()
  local extension_args=()

  ensure_pi_provider_for_model "$name" "$model"
  ensure_claude_bridge_for_opus_role "$name"

  if [[ "$CLAUDE_BRIDGE_ENABLED" != "0" && -f "$ROOT/$CLAUDE_BRIDGE_EXTENSION" ]]; then
    extension_args+=(-e "$CLAUDE_BRIDGE_EXTENSION")
  fi

  if [[ "$GEMINI_BRIDGE_ENABLED" != "0" && -f "$ROOT/$GEMINI_BRIDGE_EXTENSION" ]]; then
    extension_args+=(-e "$GEMINI_BRIDGE_EXTENSION")
  fi

  case "$name" in
    pi-orchestrator|planning-lead|implementation-lead|research-lead|verification-lead|browser-qa-lead|security-lead|self-improvement-lead|architecture-planner|test-engineer|browser-tester|visual-qa|security-reviewer|dependency-auditor|research-source-cartographer|research-customer-revenue|research-technical-prober|research-risk-compliance|research-skeptic-red-team|research-synthesis-editor|problem-solving-lead|problem-root-cause-solver|problem-implementation-solver|problem-test-repro-solver|problem-risk-skeptic|problem-synthesis-judge)
      if [[ "$DYNAMIC_WORKFLOWS_ENABLED" != "0" ]]; then
        if [[ -f "$DYNAMIC_WORKFLOWS_EXTENSION" ]]; then
          extension_args+=(-e "$DYNAMIC_WORKFLOWS_EXTENSION")
        else
          echo "Warning: Pi dynamic workflows extension not found at $DYNAMIC_WORKFLOWS_EXTENSION; launching $name without it." >&2
        fi
      fi
      ;;
  esac

  case "$name" in
    verification-lead|browser-qa-lead|test-engineer|browser-tester|visual-qa)
      if [[ -f "$WEBWRIGHT_SKILL/SKILL.md" ]]; then
        skill_args+=(--skill "$WEBWRIGHT_SKILL")
      else
        echo "Warning: Webwright skill not found at $WEBWRIGHT_SKILL; launching $name without it." >&2
      fi
      ;;
  esac

  while IFS= read -r _sk; do
    [[ -z "$_sk" ]] && continue
    if [[ -f "$TEAM_SKILLS_DIR/$_sk/SKILL.md" ]]; then
      skill_args+=(--skill "$TEAM_SKILLS_DIR/$_sk")
    else
      echo "Warning: skill $_sk not found under $TEAM_SKILLS_DIR; launching $name without it." >&2
    fi
  done < <(skills_for "$name")

  if tmux has-session -t "$session" 2>/dev/null; then
    echo "Already running: $session"
    return
  fi

  local pi_args=(
    -e extensions/coms-net.ts \
    -e extensions/minimal.ts \
    -e extensions/theme-cycler.ts \
    ${extension_args[@]+"${extension_args[@]}"} \
    --model "$model" \
    --thinking "$(thinking_for_model "$model")" \
    ${skill_args[@]+"${skill_args[@]}"} \
    --append-system-prompt "$prompt" \
    --cname "$name" \
    --purpose "$purpose" \
    --project "$PROJECT" \
    --color "$color" \
    --server-url "$SERVER_URL" \
    --auth-token "$AUTH_TOKEN"
  )

  if [[ "$LAUNCH_MODE" == "visible" ]]; then
    "$PI_VISIBLE" --open --name "$session" --workdir "$ROOT" -- "${pi_args[@]}"
    return
  fi

  local quoted_pi_args
  quoted_pi_args="$(printf '%q ' "${pi_args[@]}")"
  tmux new-session -d -s "$session" -c "$ROOT" "pi $quoted_pi_args"
  echo "Started Pi agent in background."
  echo "tmux session: $session"
  echo "workdir: $ROOT"
  echo "attach: tmux attach -t $session"
}

launch_core() {
  ensure_hub
  launch_agent "pi-orchestrator" "Pi-side orchestrator managed by OpenClaw" "#36F9F6" ".pi/openclaw-teams/prompts/pi-orchestrator.md" "$MODEL_ORCH"
  launch_agent "planning-lead" "Plans work and coordinates planning workers" "#FEDE5D" ".pi/openclaw-teams/prompts/planning-lead.md" "$MODEL_PLANNING"
  launch_agent "implementation-lead" "Coordinates implementation workers and fix loops" "#FF7EDB" ".pi/openclaw-teams/prompts/implementation-lead.md" "$MODEL_LEAD"
  launch_agent "research-lead" "Coordinates source fan-out and research dossiers" "#8BD5FF" ".pi/openclaw-teams/prompts/research-lead.md" "$MODEL_RESEARCH_LEAD"
  launch_agent "verification-lead" "Verifies acceptance criteria and tests" "#72F1B8" ".pi/openclaw-teams/prompts/verification-lead.md" "$MODEL_LEAD"
  launch_agent "browser-qa-lead" "Validates UI in browser and screenshots" "#4D9DE0" ".pi/openclaw-teams/prompts/browser-qa-lead.md" "$MODEL_LEAD"
  launch_agent "security-lead" "Coordinates security review and risk checks" "#FF8B39" ".pi/openclaw-teams/prompts/security-lead.md" "$MODEL_SECURITY"
  launch_agent "self-improvement-lead" "Captures lessons and updates team memory" "#C792EA" ".pi/openclaw-teams/prompts/self-improvement-lead.md" "$MODEL_SELF_IMPROVEMENT_LEAD"
}

launch_workers() {
  launch_research_workers
  launch_problem_workers
  launch_agent "product-planner" "Worker for user intent and acceptance criteria" "#FEDE5D" ".pi/openclaw-teams/prompts/product-planner.md" "$MODEL_PLANNING"
  launch_agent "architecture-planner" "Worker for technical planning and repo shape" "#D6DEEB" ".pi/openclaw-teams/prompts/architecture-planner.md" "$MODEL_ARCHITECT"
  launch_agent "frontend-implementer" "Worker for frontend implementation" "#36F9F6" ".pi/openclaw-teams/prompts/frontend-implementer.md" "$MODEL_WORKER"
  launch_agent "backend-implementer" "Worker for backend and API implementation" "#FF7EDB" ".pi/openclaw-teams/prompts/backend-implementer.md" "$MODEL_WORKER"
  launch_agent "test-engineer" "Worker for automated tests and regression checks" "#72F1B8" ".pi/openclaw-teams/prompts/test-engineer.md" "$MODEL_WORKER"
  launch_agent "browser-tester" "Worker for Playwright and browser testing" "#4D9DE0" ".pi/openclaw-teams/prompts/browser-tester.md" "$MODEL_WORKER"
  launch_agent "visual-qa" "Worker for visual and responsive QA" "#82AAFF" ".pi/openclaw-teams/prompts/visual-qa.md" "$MODEL_WORKER"
  launch_agent "security-reviewer" "Worker for code security review" "#FF8B39" ".pi/openclaw-teams/prompts/security-reviewer.md" "$MODEL_SECURITY"
  launch_agent "dependency-auditor" "Worker for dependency, secret, and supply-chain checks" "#FFCB6B" ".pi/openclaw-teams/prompts/dependency-auditor.md" "$MODEL_SECURITY"
  launch_agent "tenant-isolation-reviewer" "Worker for multi-tenant / cross-firm isolation" "#FF5370" ".pi/openclaw-teams/prompts/tenant-isolation-reviewer.md" "$MODEL_SECURITY"
  launch_agent "data-sovereignty-reviewer" "Worker for data residency / sovereignty (ap-southeast-2)" "#FF8B39" ".pi/openclaw-teams/prompts/data-sovereignty-reviewer.md" "$MODEL_SECURITY"
  launch_agent "authz-reviewer" "Worker for auth, authorization, and access control" "#F78C6C" ".pi/openclaw-teams/prompts/authz-reviewer.md" "$MODEL_SECURITY"
  launch_agent "data-exposure-reviewer" "Worker for PII and privileged-content leakage" "#C3E88D" ".pi/openclaw-teams/prompts/data-exposure-reviewer.md" "$MODEL_SECURITY"
  launch_agent "injection-reviewer" "Worker for injection, SSRF, and prompt-injection" "#82AAFF" ".pi/openclaw-teams/prompts/injection-reviewer.md" "$MODEL_SECURITY"
  launch_agent "docs-release-lead" "Docs and release handoff specialist" "#FFAA8B" ".pi/openclaw-teams/prompts/docs-release-lead.md" "$MODEL_DOCS_RELEASE_LEAD"
  launch_agent "memory-librarian" "Worker for role and project memory hygiene" "#C792EA" ".pi/openclaw-teams/prompts/memory-librarian.md" "$MODEL_SELF_IMPROVEMENT_WORKER"
}

launch_research_workers() {
  launch_agent "research-source-cartographer" "Research worker for source maps and source quality" "#8BD5FF" ".pi/openclaw-teams/prompts/research-source-cartographer.md" "$MODEL_RESEARCH_WORKER"
  launch_agent "research-customer-revenue" "Research worker for revenue, client value, and user journey" "#72F1B8" ".pi/openclaw-teams/prompts/research-customer-revenue.md" "$MODEL_RESEARCH_WORKER"
  launch_agent "research-technical-prober" "Research worker for APIs, repos, and cloneable patterns" "#D6DEEB" ".pi/openclaw-teams/prompts/research-technical-prober.md" "$MODEL_RESEARCH_WORKER"
  launch_agent "research-risk-compliance" "Research worker for compliance, privacy, and security blockers" "#FF8B39" ".pi/openclaw-teams/prompts/research-risk-compliance.md" "$MODEL_SECURITY"
  launch_agent "research-skeptic-red-team" "Research worker that challenges weak evidence and overbuild" "#FFCB6B" ".pi/openclaw-teams/prompts/research-skeptic-red-team.md" "$MODEL_RESEARCH_WORKER"
  launch_agent "research-synthesis-editor" "Research worker for decision-grade synthesis" "#C792EA" ".pi/openclaw-teams/prompts/research-synthesis-editor.md" "$MODEL_RESEARCH_WORKER"
}

launch_problem_workers() {
  launch_agent "problem-solving-lead" "Lead for hard implementation and debugging problems" "#F78C6C" ".pi/openclaw-teams/prompts/problem-solving-lead.md" "$MODEL_PROBLEM_LEAD"
  launch_agent "problem-root-cause-solver" "Problem solver for true root cause and failure path" "#FFCB6B" ".pi/openclaw-teams/prompts/problem-root-cause-solver.md" "$MODEL_PROBLEM_WORKER"
  launch_agent "problem-implementation-solver" "Problem solver for smallest maintainable fix" "#FF7EDB" ".pi/openclaw-teams/prompts/problem-implementation-solver.md" "$MODEL_PROBLEM_WORKER"
  launch_agent "problem-test-repro-solver" "Problem solver for reproduction and proof" "#72F1B8" ".pi/openclaw-teams/prompts/problem-test-repro-solver.md" "$MODEL_PROBLEM_WORKER"
  launch_agent "problem-risk-skeptic" "Problem solver for risk and assumption challenge" "#FF5370" ".pi/openclaw-teams/prompts/problem-risk-skeptic.md" "$MODEL_PROBLEM_WORKER"
  launch_agent "problem-synthesis-judge" "Problem solver for final approach decision" "#C792EA" ".pi/openclaw-teams/prompts/problem-synthesis-judge.md" "$MODEL_PROBLEM_WORKER"
}

session_belongs_to_team() {
  local session="$1"

  if [[ "$session" == "$HUB_SESSION" ]]; then
    return 0
  fi

  if [[ -n "$SAFE_TEAM_NAMESPACE" ]]; then
    [[ "$session" == "$SESSION_PREFIX-"* ]]
    return
  fi

  case "$session" in
    pi-team-pi-orchestrator|\
    pi-team-planning-lead|\
    pi-team-implementation-lead|\
    pi-team-research-lead|\
    pi-team-research-source-cartographer|\
    pi-team-research-customer-revenue|\
    pi-team-research-technical-prober|\
    pi-team-research-risk-compliance|\
    pi-team-research-skeptic-red-team|\
    pi-team-research-synthesis-editor|\
    pi-team-problem-solving-lead|\
    pi-team-problem-root-cause-solver|\
    pi-team-problem-implementation-solver|\
    pi-team-problem-test-repro-solver|\
    pi-team-problem-risk-skeptic|\
    pi-team-problem-synthesis-judge|\
    pi-team-verification-lead|\
    pi-team-browser-qa-lead|\
    pi-team-security-lead|\
    pi-team-self-improvement-lead|\
    pi-team-product-planner|\
    pi-team-architecture-planner|\
    pi-team-frontend-implementer|\
    pi-team-backend-implementer|\
    pi-team-test-engineer|\
    pi-team-browser-tester|\
    pi-team-visual-qa|\
    pi-team-security-reviewer|\
    pi-team-dependency-auditor|\
    pi-team-tenant-isolation-reviewer|\
    pi-team-data-sovereignty-reviewer|\
    pi-team-authz-reviewer|\
    pi-team-data-exposure-reviewer|\
    pi-team-injection-reviewer|\
    pi-team-docs-release-lead|\
    pi-team-memory-librarian)
      return 0
      ;;
  esac

  return 1
}

status() {
  echo "Project: $PROJECT"
  echo "Namespace: ${TEAM_NAMESPACE:-default}"
  echo "Session prefix: $SESSION_PREFIX"
  echo "Hub session: $HUB_SESSION"
  echo "Hub: $SERVER_URL"
  echo "Model preset: $OPENCLAW_PI_MODEL_PRESET"
  echo "Launch mode: $LAUNCH_MODE"
  echo "Pi controller shell model: $MODEL_CONTROLLER"
  echo "Orchestrator Pi model: $MODEL_ORCH"
  echo "Lead Pi model: $MODEL_LEAD"
  echo "Planning Pi model: $MODEL_PLANNING"
  echo "Architecture Pi model: $MODEL_ARCHITECT"
  echo "Security Pi model: $MODEL_SECURITY"
  echo "Research lead Pi model: $MODEL_RESEARCH_LEAD"
  echo "Research worker Pi model: $MODEL_RESEARCH_WORKER"
  echo "Problem lead Pi model: $MODEL_PROBLEM_LEAD"
  echo "Problem worker Pi model: $MODEL_PROBLEM_WORKER"
  echo "Self-improvement lead Pi model: $MODEL_SELF_IMPROVEMENT_LEAD"
  echo "Self-improvement worker Pi model: $MODEL_SELF_IMPROVEMENT_WORKER"
  echo "Memory librarian Pi model: $MODEL_SELF_IMPROVEMENT_WORKER"
  echo "Ordinary worker Pi model: $MODEL_WORKER"
  echo "Memory worker Pi model: $MODEL_MEMORY_WORKER"
  echo "Claude Code bridge enabled: $CLAUDE_BRIDGE_ENABLED"
  echo "Claude Code bridge model: $OPENCLAW_CLAUDE_BRIDGE_MODEL"
  echo "Claude Code bridge effort: $OPENCLAW_CLAUDE_BRIDGE_EFFORT"
  echo "Gemini CLI bridge enabled: $GEMINI_BRIDGE_ENABLED"
  echo "Gemini CLI bridge model: ${OPENCLAW_GEMINI_BRIDGE_MODEL:-gemini-cli-default}"
  curl -fsS "$SERVER_URL/health" 2>/dev/null || true
  echo
  tmux ls 2>/dev/null | while IFS= read -r line; do
    local session="${line%%:*}"
    session_belongs_to_team "$session" || continue
    echo "$line"
  done || true
}

stop_team() {
  while IFS=: read -r session _; do
    session_belongs_to_team "$session" || continue
    tmux kill-session -t "$session" 2>/dev/null || true
    echo "Stopped $session"
  done < <(tmux ls 2>/dev/null || true)
}

cmd="${1:-}"
case "$cmd" in
  core)
    launch_core
    ;;
  research)
    launch_core
    launch_research_workers
    ;;
  problem)
    launch_core
    launch_problem_workers
    ;;
  full)
    launch_core
    launch_workers
    ;;
  status)
    status
    ;;
  stop)
    stop_team
    ;;
  *)
    usage
    exit 2
    ;;
esac
