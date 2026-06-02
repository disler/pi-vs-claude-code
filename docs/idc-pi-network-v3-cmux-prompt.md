# IDC Pi Network V3 Build Prompt — cmux Workspace Launcher

Copy/paste this prompt into a fresh coding-agent session after V2 is complete.

```text
Build V3 of the IDC Pi Network harness: cmux workspace support.

Target repo for this build:
/Users/jeremy/dev/proj/pi-vs-claude-code

Prerequisite:
V2 should already exist and provide a portable launcher, most likely:

  scripts/idc-pi

with commands:

  idc-pi server
  idc-pi open-all
  idc-pi open <roles...>
  idc-pi run <role>
  idc-pi doctor

V2 should also include:

  extensions/idc-role-harness.ts

and hard guardrails wired into role launches.

Goal:
Add cmux support so an operator can run from any IDC-enabled target repo:

  cd /path/to/idc-enabled-repo
  idc-open-all-cmux

This should create one cmux workspace with split panes for the coms server and every IDC Pi role, each role running as its own interactive Pi session and communicating with the others over coms-net.

Also support selected roles:

  idc-open-cmux think plan ripple

Definitions:
- Harness repo: /Users/jeremy/dev/proj/pi-vs-claude-code
- Target repo: current working directory when command is invoked
- IDC-enabled repo: repo with WORKFLOW.md, WORKFLOW-config.yaml, docs/workflow/tracker-config.yaml
- cmux workspace: one cmux sidebar workspace containing multiple split panes/surfaces
- cmux pane/surface: terminal split running one command

Important constraints:
- Package manager: bun
- Task runner in harness repo: just
- Existing transport remains coms-net; do not reimplement transport.
- V3 must build on V2 launcher logic, not duplicate all launch command construction.
- Keep Terminal-window mode working.
- Keep everything additive and low risk.

Research first:
1. Read V2 files:
   - scripts/idc-pi
   - scripts/idc-open-all
   - scripts/idc-open
   - scripts/idc-run
   - docs/idc-pi-network.md
   - extensions/idc-role-harness.ts
2. Read cmux official/local docs and capabilities:
   - cmux --help
   - cmux new-workspace --help
   - cmux new-split --help
   - cmux send --help
   - cmux capabilities
   - cmux docs api
   - cmux docs settings
   - Raw docs if network is available:
     - https://raw.githubusercontent.com/manaflow-ai/cmux/main/docs/cli-contract.md
     - https://raw.githubusercontent.com/manaflow-ai/cmux/main/skills/cmux/SKILL.md
3. Determine whether the local cmux access mode allows automation from the current process:
   - cmux capabilities
   - note access_mode, e.g. cmuxOnly

Known cmux facts from prior research:
- cmux CLI exists at /Applications/cmux.app/Contents/Resources/bin/cmux on this machine.
- cmux supports:
  - new-workspace --name --cwd --command --layout
  - new-split <left|right|up|down>
  - new-pane --type terminal --direction
  - send --surface <id> <text>
  - read-screen
  - tree
  - tmux compatibility commands
- cmux new-workspace --layout accepts inline JSON where layout surfaces can define terminal commands.
- Current observed cmux access_mode was cmuxOnly, so commands are most reliable when invoked from inside cmux or when the user's cmux automation settings permit external control.

Required deliverables:

1. Extend portable launcher with cmux commands

Update scripts/idc-pi to support:

  idc-pi open-all-cmux
  idc-pi open-cmux <roles...>
  idc-pi cmux-doctor

Add convenience wrappers:

  scripts/idc-open-all-cmux
  scripts/idc-open-cmux

Update scripts/pi-idc-aliases.sh to expose:

  idc-open-all-cmux
  idc-open-cmux

Command behavior:

- idc-pi open-all-cmux:
  - target repo = current directory
  - derive same coms project as V2
  - create one cmux workspace named IDC: <repo-name> (the target repo basename)
  - include a coms-server pane
  - include panes for all roles:
    - think
    - plan
    - sequence
    - ripple
    - build-impl
    - build-review
    - build-finish
  - each pane runs in target repo cwd
  - each pane runs through V2 launcher internals, e.g. scripts/idc-pi internal-run-role <role> or equivalent
  - do not open macOS Terminal windows

- idc-pi open-cmux <roles...>:
  - same as open-all-cmux but only selected roles plus coms-server pane
  - reject unknown roles with a clear usage message

- idc-pi cmux-doctor:
  - prints cmux path/version
  - prints cmux capabilities access_mode
  - prints whether CMUX_WORKSPACE_ID and CMUX_SURFACE_ID are set
  - prints whether current environment appears to be inside cmux
  - prints whether a cmux workspace can likely be created
  - does not mutate anything

2. Internal launcher commands

If V2 does not already expose internal stable commands, add them:

  idc-pi internal-run-server
  idc-pi internal-run-role <role>

These are for generated cmux layout commands and should:
- run in current terminal/pane
- not open windows
- use target repo cwd
- preserve all V2 guardrails, sessions, model defaults, coms project, and tools

Document these as internal/unsupported for direct humans unless useful.

3. cmux workspace layout

Prefer using:

  cmux new-workspace --name "IDC: <repo-name>" --cwd "$TARGET_REPO" --layout "$LAYOUT_JSON"

Generate a deterministic split layout.

For all roles, target shape should be readable and stable. Approximate layout is acceptable if cmux's layout schema requires adjustment after research. Desired conceptual layout:

  top-left: coms-server
  top-middle/center: think
  top-right: plan
  middle/right: sequence
  bottom-left: ripple
  bottom-middle: build-impl
  bottom-right: build-review
  final/right or bottom: build-finish

A 2x4 grid is preferred for all roles:

  coms-server | think      | plan         | sequence
  ripple      | build-impl | build-review | build-finish

For selected roles, generate a simple balanced layout:
- 1 role + server: 2 panes side-by-side
- 2-3 roles + server: 2x2-ish
- 4+ roles + server: balanced grid/tree

If cmux --layout is insufficient or unreliable, implement fallback by:
1. cmux new-workspace --name ... --cwd ... --command "idc-pi internal-run-server"
2. create splits with cmux new-split / cmux new-pane
3. send commands to each new surface with cmux send

The implementation may choose layout JSON first, imperative fallback second. Document which path is used.

4. cmux access-mode handling

Because cmux may be configured as cmuxOnly:
- If running inside cmux, proceed normally.
- If running outside cmux and cmux automation refuses socket access, print a clear message:

  cmux automation is not available from this process.
  Open a cmux terminal in the target repo and rerun:
    idc-open-all-cmux

- Optionally, open the target repo in cmux with:

  cmux "$TARGET_REPO"

  but do not assume this gives the original external shell socket permission to create panes.

Do not silently fall back to Terminal.app windows for idc-open-all-cmux. If cmux cannot be automated, fail clearly.

5. Workspace/session naming

- Workspace name: IDC: <repo-name> (target repo basename)
- Optional workspace description: target repo path + coms project
- Role pane/tab titles if cmux supports renaming surfaces/tabs after creation:
  - coms
  - think
  - plan
  - sequence
  - ripple
  - build-impl
  - build-review
  - build-finish

If title setting is not reliable, prefix each pane command with an echo banner before launching Pi:

  printf '\033]0;IDC think\007'
  echo 'IDC think — <target repo>'
  exec pi ...

6. Docs

Update docs/idc-pi-network.md with a cmux section:

- Terminal window mode:
  - idc-open-all
  - idc-open think plan ripple
- Current terminal mode:
  - idc-run think
- cmux mode:
  - idc-open-all-cmux
  - idc-open-cmux think plan ripple
- Explain that cmux mode creates one cmux workspace with split panes.
- Explain that each pane is still a separate Pi process/session with its own context window.
- Explain that coms-net remains the communication layer.
- Explain cmux access-mode caveat and how to diagnose:
  - idc-pi cmux-doctor
  - cmux capabilities
- Explain that cmux mode does not use Claude Teams TeamCreate; it uses Pi processes in cmux panes communicating through coms-net.

Optionally create:

  docs/idc-pi-network-cmux.md

if the cmux section becomes too long.

7. Env/config

Update .env.sample with optional cmux settings if useful:

  PI_IDC_CMUX_WORKSPACE_PREFIX=IDC
  PI_IDC_CMUX_LAYOUT=grid

Do not require these env vars for normal use.

8. just recipes

If V2 kept just recipes, add additive recipes:

  idc-open-all-cmux
  idc-open-cmux *roles
  idc-cmux-doctor

These should delegate to scripts/idc-pi.

Do not break existing Terminal-window recipes.

Required verification:

Run syntax/static checks:

  bash -n scripts/idc-pi
  bash -n scripts/idc-open-all-cmux
  bash -n scripts/idc-open-cmux
  bash -n scripts/pi-idc-aliases.sh
  just --list
  just --dry-run idc-open-all-cmux
  just --dry-run idc-open-cmux think plan ripple

Run cmux checks that do not disrupt the user's environment:

  scripts/idc-pi cmux-doctor
  cmux --help | head
  cmux new-workspace --help | head
  cmux capabilities | head

Dry-run generated layout:

  scripts/idc-pi open-all-cmux --dry-run
  scripts/idc-pi open-cmux think plan ripple --dry-run

If safe and user approves, optionally run a live smoke test that creates a workspace with harmless commands instead of Pi:

  scripts/idc-pi open-cmux-smoke -- echo-only

Do not launch seven real Pi sessions during verification unless explicitly approved.

Acceptance criteria:
- idc-open-all-cmux exists and delegates to scripts/idc-pi open-all-cmux.
- idc-open-cmux <roles...> exists and delegates to scripts/idc-pi open-cmux.
- cmux mode creates or dry-runs one workspace with a coms server pane plus role panes.
- Commands run from target repo cwd.
- Commands preserve V2 guardrails and coms project/session/model behavior.
- cmux access-mode limitations are detected and reported clearly.
- Terminal-window mode still works.
- Docs explain how cmux mode differs from Terminal-window mode and from Claude Teams.

Report back with:
- files changed
- cmux docs/capability findings
- verification output
- exact usage examples
- limitations / any manual cmux setting needed
```
