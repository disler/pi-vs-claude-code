# IDC Pi Network

This repo includes an additive IDC Pi Network harness built on the existing `coms-net` extension and hub. It does not replace or reimplement the transport.

## Portable usage from any IDC repo

Install or source the helpers once, then run commands from the target repo you want the agents to work in:

```bash
cd /path/to/any/idc-enabled-repo
idc-open-all
idc-open think plan ripple
idc-open-all-cmux
idc-open-cmux think plan ripple
idc-run think
```

`idc-open-all` and `idc-open <roles...>` are Terminal-window mode. They automatically check whether a `coms-net` server is already healthy for the derived project. If not, they open a dedicated macOS Terminal window running the hub and then open each selected role in its own Terminal window.

`idc-open-all-cmux` and `idc-open-cmux <roles...>` are cmux mode. They create one cmux workspace named `IDC: <repo-name>` with split panes: one pane for the `coms-net` server and one pane per selected IDC role. Each role is still a separate interactive Pi process/session with its own context window. `coms-net` remains the only communication layer; cmux only provides pane/workspace topology.

`idc-run <role>` runs exactly one role in the current terminal. It does not open a new window.

`idc-coms-server` runs the hub in the current terminal.

## Launch modes at a glance

| Mode | Commands | Behavior |
| --- | --- | --- |
| Terminal window mode | `idc-open-all`, `idc-open think plan ripple` | Opens/reuses a Terminal.app window for the server and one Terminal.app window per role. |
| Current terminal mode | `idc-run think`, `idc-coms-server` | Runs exactly one role or the server in the current shell. |
| cmux mode | `idc-open-all-cmux`, `idc-open-cmux think plan ripple` | Creates one cmux workspace with split panes for the server and selected roles. |

All modes launch separate Pi processes/sessions. cmux mode changes process placement only; it does not merge contexts or replace `coms-net`.

## Installation options

### Recommended: install durable commands once

```bash
cd /Users/jeremy/dev/proj/pi-vs-claude-code
just install-idc
```

This installs symlinks into `~/.local/bin` and, when needed, adds a managed PATH block to your shell startup file (`~/.zshrc`, `~/.bashrc`, or `~/.profile`). After that, open a new terminal and use the simple commands directly from any IDC repo:

```bash
idc-open-all
idc-open think plan ripple
idc-open-all-cmux
idc-open-cmux think plan ripple
idc-run think
idc-coms-server
```

The installer is idempotent: re-running `just install-idc` updates the symlinks without duplicating shell startup entries. It refuses to overwrite an existing non-symlink command unless you intentionally pass `--force`.

Installer options:

```bash
scripts/install-idc-pi --dry-run
scripts/install-idc-pi --prefix ~/.local/bin
scripts/install-idc-pi --no-shell-rc
scripts/install-idc-pi --force        # replace an existing non-symlink command
```

### Temporary shell helpers

For one-off sessions only, you can still source the helper functions:

```bash
source /Users/jeremy/dev/proj/pi-vs-claude-code/scripts/pi-idc-aliases.sh
```

This is not required after `just install-idc`.

## Launcher details

Preferred launcher path:

```bash
scripts/idc-pi
```

Supported commands:

```bash
idc-pi server
idc-pi open-all
idc-pi open think plan ripple
idc-pi open-all-cmux
idc-pi open-cmux think plan ripple
idc-pi run think
idc-pi cmux-doctor
idc-pi doctor
idc-pi help
```

Accepted roles:

- `think`
- `plan`
- `sequence`
- `ripple`
- `build-impl`
- `build-review`
- `build-finish`

Definitions:

- **Harness repo:** defaults to `/Users/jeremy/dev/proj/pi-vs-claude-code`; override with `PI_IDC_HARNESS_REPO`.
- **Target repo:** the operator's current working directory when an `idc-*` command is run.
- **Session dir:** defaults to `TARGET_REPO/.pi/agent-sessions`; override with `PI_IDC_SESSION_DIR`.

Every role launch runs Pi from the target repo and references harness assets by absolute path:

- `extensions/coms-net.ts`
- `extensions/minimal.ts`
- `extensions/theme-cycler.ts`
- `extensions/idc-role-harness.ts`
- `.pi/agents/idc/<role prompt>.md`

Every role uses `--session-id idc-<role>` and includes the coms-net tools:

- `coms_net_list`
- `coms_net_send`
- `coms_net_get`
- `coms_net_await`

## cmux mode

Use cmux mode when you want the whole IDC network in one cmux sidebar workspace instead of many macOS Terminal windows:

```bash
cd /path/to/idc-enabled-repo
idc-open-all-cmux
idc-open-cmux think plan ripple
```

The launcher builds a deterministic JSON layout and calls:

```bash
cmux new-workspace --name "IDC: <repo-name>" --cwd "$TARGET_REPO" --layout '<json>'
```

For all roles, the intended grid is:

```text
coms-server | think      | plan         | sequence
ripple      | build-impl | build-review | build-finish
```

For selected roles, it creates a balanced layout from the server pane plus the requested roles. Pane commands use internal launcher entries (`idc-pi internal-run-server` and `idc-pi internal-run-role <role>`) so Terminal-window mode and cmux mode share the same role command construction, session ids, model defaults, tools, coms project derivation, and hard guardrails.

cmux mode does **not** use Claude Teams or TeamCreate. It launches plain Pi processes in cmux terminal panes. The roles still discover and message each other through `coms-net`.

### cmux access-mode caveat

On this machine, `cmux capabilities` has reported `access_mode: cmuxOnly`. When that mode is active, workspace automation is reliable from inside a cmux terminal. If you run `idc-open-all-cmux` from an external Terminal process and cmux refuses automation, the launcher fails clearly instead of falling back to Terminal-window mode:

```text
cmux automation is not available from this process.
Open a cmux terminal in the target repo and rerun:
  idc-open-all-cmux
```

Diagnose with:

```bash
idc-pi cmux-doctor
cmux capabilities
```

Dry-run layout generation without mutating cmux:

```bash
idc-pi open-all-cmux --dry-run
idc-pi open-cmux think plan ripple --dry-run
```

Optional cmux settings:

```bash
PI_IDC_CMUX_WORKSPACE_PREFIX=IDC
PI_IDC_CMUX_LAYOUT=grid   # grid | linear
```

## Communication project derivation

The launcher derives the coms-net project in this order:

1. `PI_IDC_COMS_PROJECT`, when set.
2. `WORKFLOW-config.yaml` → `project.name`, as `idc-<project.name>`.
3. The target repo basename, as `idc-<basename>`.

Use `PI_IDC_COMS_PROJECT` when several repos intentionally share one hub or when you need a stable name independent of repo/config values.

## Model defaults

Override any default with environment variables:

```bash
PI_IDC_THINK_MODEL=claude-opus-4-7
PI_IDC_PLAN_MODEL=claude-opus-4-7
PI_IDC_SEQUENCE_MODEL=deepseek/deepseek-v4-pro
PI_IDC_RIPPLE_MODEL=deepseek/deepseek-v4-pro
PI_IDC_BUILD_IMPL_MODEL=claude-opus-4-7
PI_IDC_BUILD_REVIEW_PROVIDER=openai
PI_IDC_BUILD_REVIEW_MODEL=gpt-5.5
PI_IDC_BUILD_FINISH_MODEL=claude-opus-4-7
```

Thinking levels are also overridable, e.g. `PI_IDC_PLAN_THINKING=xhigh`.

## Hard role/path guardrails

All role launches include `extensions/idc-role-harness.ts` with:

```bash
--idc-role <role>
--idc-guard-mode ${PI_IDC_GUARD_MODE:-block}
```

Guard modes:

- `block` — default. Out-of-role writes and mutating bash are blocked before execution.
- `warn` — notify with the same guard message but allow execution.
- `off` — no guardrail enforcement.

On session start, the extension sets a compact IDC status and terminal title and notifies the role's write roots.

### Role write boundaries

- **Think:** `docs/considerations/**` and Think scratch roots only.
- **Plan:** canonical planning docs and planning workflow artifacts only; no source/tests or tracker status/order.
- **Sequence:** `TRACKER.md`, selected tracker/planning workflow artifacts, and sequence scratch roots.
- **Ripple:** `docs/workflow/ripple/**`, ripple audits/handoffs, and ripple scratch roots.
- **Build Implementer / Build Finisher:** source/tests/implementation files plus Build-owned workflow artifacts, excluding canonical/governance/tracker surfaces.
- **Build Reviewer:** read-only; no file writes and no mutating bash.

Ripple canonical/planning synchronization is blocked unless explicitly enabled:

```bash
PI_IDC_RIPPLE_ALLOW_CANONICAL=1 idc-run ripple
```

That override allows Ripple to touch gated canonical/planning surfaces such as `docs/prd/**`, `docs/specs/**`, `docs/plans/**`, `CLAUDE.md`, `AGENTS.md`, and nested `CLAUDE.md` files. It does not remove the need for IDC gate approval.

### Bash guardrails and limitations

The guard inspects `bash` tool calls for obvious mutations:

- `rm`, `mv`, `cp`, `mkdir`, `touch`
- `>` and `>>` redirection
- `tee`
- `sed -i`
- `perl -pi`
- `python`, `node`, and `bun` one-liners that appear to write files
- `git commit`, `git merge`, `git reset`, `gh pr merge`

For roles with write authority, mutating bash is allowed only when the target path can be extracted and is inside that role's allowed roots. For `build-review`, mutating bash is blocked outright. Read-only commands such as `git diff`, `git status`, `rg`, `grep`, `find`, `ls`, and tests without known output paths are allowed.

Limitations:

- This is heuristic shell inspection, not a full shell parser.
- Complex quoting, command substitution, variables, globs, and generated paths may be treated as unsafe.
- Commands with obvious mutation but no safely extractable path fail closed in `block` mode.
- Symlink escape prevention is best-effort path normalization, not OS sandboxing.
- Build Finisher gate semantics such as "do not bypass unresolved Blocker/Major findings" remain prompt/skill-level requirements; path guardrails cannot prove review state.

## Workflow

1. Begin in **Think**. Capture brainstorming in `docs/considerations/`.
2. Hand off **Think → Plan** with a consideration file path, not a pasted transcript.
3. **Plan** converts approved considerations into canonical planning artifacts.
4. **Sequence** admits polished Plan outputs into tracker/wave order.
5. **Build Implementer** implements admitted Sequence work only.
6. **Build Reviewer** performs read-only adversarial review and sends findings to Build Finisher.
7. **Build Finisher** applies accepted fixes, verifies, merges/cleans up, and reports final handoff.
8. Consult **Ripple** anytime canonical drift or gate language is unclear.

## Message packet shape

Use disk artifact paths instead of large pasted bodies.

```yaml
type: consult | handoff | review | ripple-check | tracker-check
from: <role>
to: <role>
artifact_paths:
  - <path>
question: <focused question>
authority_boundary: <sender boundary>
expected_response: <needed answer>
```

Protocol reminders:

- Use `coms_net_list` to discover peers.
- Use `coms_net_send` only to initiate a consultation or handoff.
- Use `coms_net_await` only for `msg_id` values returned by your own `coms_net_send`.
- Never use `coms_net_send` to reply to inbound messages; normal assistant output is auto-returned.

## Harness-repo compatibility

The existing `just` recipes remain available in this harness repo and delegate to `scripts/idc-pi` for consistent behavior:

```bash
just idc-coms-server
just idc-open-all
just idc-open-all-cmux
just idc-open-cmux think plan ripple
just idc-cmux-doctor
just pi-think
just pi-plan
just pi-sequence
just pi-ripple
just pi-build-impl
just pi-build-review
just pi-build-finish
```

Use `scripts/idc-pi doctor` to print target repo, harness repo, derived project, found/missing files, cmux availability, server status, and exact role launch previews. Use `scripts/idc-pi cmux-doctor` for cmux path/version, access mode, caller environment, and likely workspace-creation status.
