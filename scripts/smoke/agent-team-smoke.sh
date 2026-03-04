#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEAM_DIR="${1:-$ROOT_DIR/.pi/teams/smoke-team}"

echo "== Agent Team Smoke Helper =="
echo "repo:    $ROOT_DIR"
echo "teamDir: $TEAM_DIR"
echo

if ! command -v pi >/dev/null 2>&1; then
  echo "[WARN] 'pi' not found in PATH. Install/configure pi before running smoke."
else
  echo "[OK] pi found: $(command -v pi)"
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "[WARN] 'bun' not found in PATH. Project expects bun tooling."
else
  echo "[OK] bun found: $(command -v bun)"
fi

echo
cat <<'EOF'
Manual-assisted flow (safe / non-destructive):

1) Start lead session with extension loaded.
2) In lead, run create_team and set teamDir to the path shown above.
3) Spawn a normal teammate (planMode:false), run claim/update/complete.
4) Spawn a plan-mode teammate (planMode:true), verify pre-approval block.
5) Teammate submit_plan, then lead approve_plan false/true and re-test gating.

See full checklist:
  docs/smoke/agent-team-smoke-checklist.md
EOF

echo
assert_path() {
  local label="$1"
  local p="$2"
  if [[ -e "$p" ]]; then
    echo "[OK] $label exists: $p"
  else
    echo "[INFO] $label missing (expected until step performed): $p"
  fi
}

assert_nonempty_glob() {
  local label="$1"
  local glob_pat="$2"
  shopt -s nullglob
  local matches=( $glob_pat )
  shopt -u nullglob
  if (( ${#matches[@]} > 0 )); then
    echo "[OK] $label present (${#matches[@]} files)"
  else
    echo "[INFO] $label not present yet (expected until corresponding actions)"
  fi
}

echo "== Filesystem assertions (best-effort) =="
assert_path "team dir" "$TEAM_DIR"
assert_path "tasks dir" "$TEAM_DIR/tasks"
assert_path "mailbox dir" "$TEAM_DIR/mailbox"
assert_path "members dir" "$TEAM_DIR/members"
assert_path "team config" "$TEAM_DIR/config.json"
assert_nonempty_glob "task files" "$TEAM_DIR/tasks/*.json"
assert_nonempty_glob "mailbox message files" "$TEAM_DIR/mailbox/*.json"
assert_nonempty_glob "heartbeat files" "$TEAM_DIR/members/*.heartbeat.json"

echo
cat <<EOF
Next:
  bash scripts/smoke/agent-team-smoke.sh [optional-team-dir]
  # then execute manual steps from docs/smoke/agent-team-smoke-checklist.md
EOF
