# IDC Pi Network V2 Build Prompt — Portable Launcher + Hard Guardrails

Copy/paste this prompt into a fresh coding-agent session.

```text
Build V2 of the IDC Pi Network harness.

Target repo for this build:
/Users/jeremy/dev/proj/pi-vs-claude-code

Goal:
Turn the current repo-local IDC Pi Network V1 prototype into a portable launcher usable from any IDC-enabled repo, and add hard role/path guardrails.

The desired operator UX is:

  cd /path/to/any/idc-enabled-repo
  idc-open-all

This should automatically ensure the coms-net hub is running and then open the IDC Pi roles in separate Terminal windows/sessions, all pointed at the current target repo and all communicating via coms-net.

Also support:

  idc-open think plan ripple
  idc-run think
  idc-coms-server

Definitions:
- Harness repo: /Users/jeremy/dev/proj/pi-vs-claude-code
- Target repo: the operator's current working directory when they run an idc-* command
- IDC-enabled repo: a repo with WORKFLOW.md plus WORKFLOW-config.yaml and docs/workflow/tracker-config.yaml, following the IDC portability convention in WORKFLOW.md §16.

Important constraints:
- Package manager: bun
- Task runner in this harness repo: just
- Extensions run via: pi -e extensions/<name>.ts
- Existing transport: extensions/coms-net.ts and scripts/coms-net-server.ts
- Do not reimplement coms-net transport.
- Keep V1 repo-local recipes working unless replacing them with compatible wrappers is clearly safer.
- Keep implementation additive and low risk.
- Follow CLAUDE.md in this repo.

Existing V1 files to read first:
- /Users/jeremy/dev/proj/pi-vs-claude-code/CLAUDE.md
- /Users/jeremy/dev/proj/pi-vs-claude-code/justfile
- /Users/jeremy/dev/proj/pi-vs-claude-code/.env.sample
- /Users/jeremy/dev/proj/pi-vs-claude-code/docs/idc-pi-network.md
- /Users/jeremy/dev/proj/pi-vs-claude-code/.pi/agents/idc/*.md
- /Users/jeremy/dev/proj/pi-vs-claude-code/scripts/pi-idc-aliases.sh
- /Users/jeremy/dev/proj/pi-vs-claude-code/extensions/coms-net.ts only enough to preserve flags/tools/project behavior
- /Users/jeremy/dev/proj/knowledge-engine/WORKFLOW.md §16 Configuration And Portability
- /Users/jeremy/dev/proj/knowledge-engine/WORKFLOW-config.yaml as an example target repo sidecar

Pi docs to read as needed:
- /Users/jeremy/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md
- /Users/jeremy/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/docs/sessions.md
- /Users/jeremy/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/docs/models.md
- /Users/jeremy/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/docs/skills.md

If running under pi-pi:
- Call query_experts exactly once before implementation with parallel queries to:
  - ext-expert
  - agent-expert
  - config-expert
  - prompt-expert
  - optionally tui-expert

Required deliverables:

1. Portable launcher script

Create a portable executable script, preferred path:

  scripts/idc-pi

It should be safe to symlink into ~/.local/bin/idc-pi.

It must support commands:

  idc-pi server
  idc-pi open-all
  idc-pi open <roles...>
  idc-pi run <role>
  idc-pi doctor
  idc-pi help

Accepted role names:

  think
  plan
  sequence
  ripple
  build-impl
  build-review
  build-finish

Behavior:
- Treat the current working directory as TARGET_REPO.
- Resolve HARNESS_REPO to /Users/jeremy/dev/proj/pi-vs-claude-code by default.
- Allow override with PI_IDC_HARNESS_REPO.
- Launch Pi from TARGET_REPO, not from HARNESS_REPO.
- Reference harness assets by absolute paths:
  - $HARNESS_REPO/extensions/coms-net.ts
  - $HARNESS_REPO/extensions/minimal.ts
  - $HARNESS_REPO/extensions/theme-cycler.ts
  - $HARNESS_REPO/extensions/idc-role-harness.ts
  - $HARNESS_REPO/.pi/agents/idc/<role prompt>.md
- Store sessions in TARGET_REPO/.pi/agent-sessions by default, override with PI_IDC_SESSION_DIR.
- Use --session-id idc-<role> for every role.
- Include existing coms-net tools for every role:
  - coms_net_list
  - coms_net_send
  - coms_net_get
  - coms_net_await
- Derive coms project by precedence:
  1. PI_IDC_COMS_PROJECT if set
  2. WORKFLOW-config.yaml project.name as idc-<project.name>
  3. basename of TARGET_REPO as idc-<basename>
- idc-pi open-all and idc-pi open <roles...> must ensure the coms server is running first.
- If server is not running, open a dedicated macOS Terminal window running idc-pi server for that target repo/project.
- Then open each selected role in its own separate macOS Terminal window.
- idc-pi run <role> runs one role in the current terminal; it should not open a new window.
- idc-pi server runs the coms-net hub in the current terminal for the derived project.
- idc-pi doctor prints target repo, harness repo, derived project, relevant files found/missing, cmux availability if detected, and the exact role launch command preview.

2. Convenience command shims

Create small executable wrapper scripts or aliases under scripts/ so users can symlink/source them:

  scripts/idc-coms-server
  scripts/idc-open-all
  scripts/idc-open
  scripts/idc-run

Each should delegate to scripts/idc-pi with the corresponding command.

Update scripts/pi-idc-aliases.sh to use the portable launcher, not cd into the harness repo for execution. It may still set PI_IDC_HARNESS_REPO.

3. Hard guardrail extension

Create:

  extensions/idc-role-harness.ts

Use Pi extension APIs from extensions.md.

Register flags:

  --idc-role <role>
  --idc-guard-mode <off|warn|block>

Defaults:
- idc-guard-mode comes from PI_IDC_GUARD_MODE or block.
- If --idc-role is absent, extension should no-op except maybe warn once.

On session_start:
- set status like: IDC: think guard:block
- set terminal title like: pi idc:think
- notify allowed write roots in a compact way.

Tool interception:
- Use tool_call event and isToolCallEventType() for type-safe narrowing.
- Intercept write and edit and block/warn based on normalized target path.
- Normalize relative paths against ctx.cwd.
- Allow /tmp scratch roots as listed below.
- In block mode, return { block: true, reason: <clear message> }.
- In warn mode, notify but allow.
- In off mode, do nothing.
- Clear error messages must include:
  - role
  - attempted path
  - guard mode
  - allowed roots / blocked surfaces summary

Bash interception:
- For all roles, inspect bash commands for obvious file mutations or merge/commit operations outside role authority.
- At minimum detect:
  - rm, mv, cp, mkdir, touch
  - redirection > and >>
  - tee
  - sed -i
  - perl -pi
  - python/node/bun one-liners that write files
  - git commit, git merge, git reset, gh pr merge
- For build-review, block all mutating bash. Allow read-only commands such as git diff/status, rg, grep, find, ls, test commands that do not write known output paths.
- Do not attempt perfect shell parsing; document limitations. Fail closed for build-review and for commands with obvious mutation but no safely extractable path.

Role path policies:

think allowed writes:
- docs/considerations/**
- /tmp/pi-idc/think/**
- /tmp/ke-idc-think/**

plan allowed writes:
- docs/prd/**
- docs/specs/**
- docs/plans/**
- docs/workflow/pillar-conflicts/**
- docs/workflow/pillar-matrices/**
- docs/workflow/phase-planning/**
- docs/workflow/audits/**
- docs/workflow/handoffs/**
- /tmp/pi-idc/plan/**
- /tmp/ke-idc-plan/**

sequence allowed writes:
- TRACKER.md
- TRACKER-archive.md only when active IDC docs explicitly allow historical/fallback edits
- docs/workflow/pillar-matrices/**
- docs/workflow/audits/**
- docs/workflow/code-reviews/**
- docs/workflow/handoffs/waves/**
- /tmp/pi-idc/sequence/**
- /tmp/ke-idc-sequence/**

ripple allowed writes:
- docs/workflow/ripple/**
- docs/workflow/audits/**
- docs/workflow/handoffs/ripples/**
- /tmp/pi-idc/ripple/**
- /tmp/ke-idc-ripple/**
- Gated canonical/planning docs only when PI_IDC_RIPPLE_ALLOW_CANONICAL=1:
  - docs/prd/**
  - docs/specs/**
  - docs/plans/**
  - CLAUDE.md
  - AGENTS.md
  - **/CLAUDE.md

build-impl allowed writes:
- source/tests/implementation files except blocked canonical/governance surfaces
- docs/workflow/operator-todos/**
- docs/workflow/code-reviews/**
- docs/workflow/handoffs/builds/**
- /tmp/pi-idc/build-impl/**
- /tmp/ke-idc-build/**

build-impl blocked surfaces:
- docs/prd/**
- docs/specs/**
- docs/plans/**
- docs/workflow/ripple/**
- docs/workflow/pillar-matrices/**
- docs/workflow/pillar-conflicts/**
- TRACKER.md
- TRACKER-archive.md
- .pi/agents/**
- WORKFLOW.md
- WORKFLOW-config.yaml
- CLAUDE.md
- AGENTS.md
- **/CLAUDE.md

build-review:
- no file writes at all
- no mutating bash

build-finish allowed writes:
- same source/tests/implementation allowance as build-impl
- docs/workflow/operator-todos/**
- docs/workflow/code-reviews/**
- docs/workflow/handoffs/builds/**
- /tmp/pi-idc/build-finish/**
- /tmp/ke-idc-build/**

build-finish blocked surfaces:
- same as build-impl blocked surfaces
- must not bypass Blocker/Major gates; this is prompt-level plus guard messaging, not perfectly enforceable in paths.

4. Wire portable launcher to guardrail extension

All role launches must include:

  -e $HARNESS_REPO/extensions/idc-role-harness.ts
  --idc-role <role>
  --idc-guard-mode ${PI_IDC_GUARD_MODE:-block}

Use V1 role prompts and IDC skills:
- think: idc-workflow + codex-idc-think
- plan: idc-workflow + codex-idc-plan
- sequence: idc-workflow + codex-idc-sequence
- ripple: idc-workflow + codex-idc-ripple
- build roles: idc-workflow + codex-idc-build

Model defaults:
- Think/Plan/Build implementation/Build finish: claude-opus-4-7 unless overridden
- Build review: provider openai, model gpt-5.5 unless overridden
- Sequence/Ripple: deepseek/deepseek-v4-pro unless overridden
- Preserve all PI_IDC_* env overrides already introduced in V1.

5. Docs

Update:

  docs/idc-pi-network.md

Add:
- Portable usage from any IDC repo:
  - cd target repo
  - idc-open-all
  - idc-open think plan ripple
  - idc-run think
- Explain that idc-open-all auto-starts/reuses coms server.
- Explain project derivation and PI_IDC_COMS_PROJECT override.
- Explain hard guardrails and guard modes.
- Explain Ripple canonical override PI_IDC_RIPPLE_ALLOW_CANONICAL.
- Explain build-review read-only behavior.
- Explain limitations of bash guardrails.
- Explain installation/symlink options:
  - source scripts/pi-idc-aliases.sh
  - symlink scripts/idc-pi and wrappers into ~/.local/bin

Update .env.sample:
- PI_IDC_HARNESS_REPO=/Users/jeremy/dev/proj/pi-vs-claude-code
- PI_IDC_GUARD_MODE=block
- PI_IDC_RIPPLE_ALLOW_CANONICAL=
- Keep existing V1 PI_IDC_* model/session settings.

6. Optional just recipes

Keep existing V1 just recipes working in the harness repo, but it is acceptable to make them delegate to scripts/idc-pi so that behavior is consistent.

Required verification:

Run:

  just --list
  bash -n scripts/idc-pi
  bash -n scripts/idc-coms-server
  bash -n scripts/idc-open-all
  bash -n scripts/idc-open
  bash -n scripts/idc-run
  bash -n scripts/pi-idc-aliases.sh
  scripts/idc-pi doctor
  scripts/idc-pi open-all --dry-run
  scripts/idc-pi open think plan ripple --dry-run
  scripts/idc-pi run think --dry-run

Also verify TypeScript syntax for the extension with the best available local command, for example:

  bun --check extensions/idc-role-harness.ts

If bun --check is unavailable or unsuitable, use the repo's established TypeScript parse/typecheck method and document the exact command used.

Acceptance criteria:
- From any target repo, launcher commands are built around target repo cwd, not harness repo cwd.
- Harness assets are referenced by absolute path.
- idc-open-all auto-starts or reuses a coms server.
- idc-open <roles...> auto-starts or reuses a coms server and opens selected roles in separate Terminal windows.
- idc-run <role> runs exactly one role in the current terminal.
- Every role uses --session-id idc-<role> and target repo session dir.
- Every role includes coms-net tools.
- idc-role-harness blocks out-of-bound write/edit in block mode with clear messages.
- build-review cannot write files and blocks mutating bash.
- Docs explain portable usage and limitations.
- Existing non-IDC recipes/extensions are not broken.

Report back with:
- files changed
- verification command outputs
- exact install/use instructions
- limitations and known edge cases
```
