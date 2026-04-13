# Security Audit — pi-vs-claude-code

**Date:** February 23, 2026
**Scope:** All extensions, agent definitions, configuration files, and damage-control rules
**Auditor:** Claude Code (automated analysis)

---

## Table of Contents

- [Summary](#summary)
- [Critical Issues](#critical-issues)
  - [SEC-001: Command Injection via Unsanitized User Input in spawn()](#sec-001-command-injection-via-unsanitized-user-input-in-spawn)
  - [SEC-002: Full Environment Inheritance in Subprocess Spawning](#sec-002-full-environment-inheritance-in-subprocess-spawning)
  - [SEC-003: Damage-Control Bypass via Path Manipulation](#sec-003-damage-control-bypass-via-path-manipulation)
  - [SEC-004: Regex Denial of Service in Damage-Control Rules](#sec-004-regex-denial-of-service-in-damage-control-rules)
- [High Issues](#high-issues)
  - [SEC-005: .env.sample Contains Key Format Hints](#sec-005-envsample-contains-key-format-hints)
  - [SEC-006: Agent Session Files Stored in Plaintext](#sec-006-agent-session-files-stored-in-plaintext)
  - [SEC-007: No Input Length Validation on Tasks/Prompts](#sec-007-no-input-length-validation-on-tasksprompts)
  - [SEC-008: cross-agent.ts Executes Commands from Foreign Agent Directories](#sec-008-cross-agentts-executes-commands-from-foreign-agent-directories)
- [Medium Issues](#medium-issues)
  - [SEC-009: Swallowed Errors Hide Failures Silently](#sec-009-swallowed-errors-hide-failures-silently)
  - [SEC-010: system-select.ts Loads System Prompts from Global Home Directories](#sec-010-system-selectts-loads-system-prompts-from-global-home-directories)
  - [SEC-011: Race Condition in Subprocess Management](#sec-011-race-condition-in-subprocess-management)
  - [SEC-012: damage-control.ts Read-Only Heuristic for Bash is Weak](#sec-012-damage-controlts-read-only-heuristic-for-bash-is-weak)
- [Low / Informational Issues](#low--informational-issues)
  - [SEC-013: process.argv Access for Theme Resolution](#sec-013-processargv-access-for-theme-resolution)
  - [SEC-014: No CSP or Sandboxing for Subprocesses](#sec-014-no-csp-or-sandboxing-for-subprocesses)
  - [SEC-015: .pi/settings.json References Parent Directory](#sec-015-pisettingsjson-references-parent-directory)
- [What's Done Well](#whats-done-well)
- [Priority Matrix](#priority-matrix)

---

## Summary

| Severity | Count |
|----------|-------|
| 🔴 Critical | 4 |
| 🟠 High | 4 |
| 🟡 Medium | 4 |
| 🟢 Low / Informational | 3 |
| **Total** | **15** |

The codebase is a Pi coding agent extension playground with 15 TypeScript extensions, agent definitions, and a damage-control rule system. The code is primarily client-side tooling with no web server. The most significant risks center around subprocess spawning, prompt injection through agent definition files, and bypassable guardrails in the damage-control system.

---

## Critical Issues

---

### SEC-001: Command Injection via Unsanitized User Input in spawn() ✅ FIXED

**Severity:** 🔴 Critical
**Status:** Fixed — 2026-02-23
**Files:** `extensions/agent-team.ts`, `extensions/agent-chain.ts`, `extensions/pi-pi.ts`, `extensions/subagent-widget.ts`

#### Description

All four extensions pass user-provided task strings directly as CLI arguments to `spawn("pi", [...args, task])`. While `spawn` with an argument array is safer than shell execution, the `--append-system-prompt` flag passes the full agent system prompt (which can contain user-influenced content) as a single CLI argument. If any agent definition `.md` file is maliciously crafted (e.g., via a PR), the system prompt is injected verbatim into subprocesses.

```typescript
const args = [
    "--append-system-prompt", agentDef.systemPrompt,  // from .md file on disk
    task,  // user input passed as final arg
];
spawn("pi", args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } });
```

A malicious `.md` agent file could craft a system prompt containing shell metacharacters or prompt injection payloads that alter subprocess behavior.

#### Fix Plan

Create a shared `loadAndValidateAgent()` function in a new `extensions/utils/agent-loader.ts` that all extensions call instead of raw `readFileSync` + parse. This function validates the `.md` file against a strict schema:

- Agent `name` must be alphanumeric plus dashes only
- `tools` must be from an allowlist of known tool names
- The system prompt body is scanned for suspicious patterns (shell metacharacters like backticks, `$(...)`, `\x00` null bytes, excessively long lines)
- Invalid agents are rejected at load time with a warning notification rather than silently loaded

All extensions would import from this shared utility instead of each having their own `parseAgentFile()`.

#### Behavior Change

If someone adds an agent `.md` file with unusual characters in the system prompt (e.g., backtick-wrapped shell commands as examples), it would be flagged and require explicit approval or a config override to load. Legitimate agents with clean markdown would be unaffected. The four extensions with duplicate `parseAgentFile()` implementations would converge on a single shared loader.

---

### SEC-002: Full Environment Inheritance in Subprocess Spawning

**Severity:** 🔴 Critical
**Files:** `extensions/agent-team.ts`, `extensions/agent-chain.ts`, `extensions/pi-pi.ts`, `extensions/subagent-widget.ts`

#### Description

All subprocesses inherit the full parent environment via `env: { ...process.env }`, including every API key (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `FIRECRAWL_API_KEY`). If a subagent is compromised or a malicious agent definition is loaded, it has access to all credentials regardless of which provider it actually needs.

```typescript
spawn("pi", args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },  // inherits ALL env vars
});
```

#### Fix Plan

Create a `buildSubprocessEnv()` helper in `extensions/utils/env.ts` that constructs a minimal environment. It includes only:

- `PATH`, `HOME`, `TERM`, `LANG` (system essentials)
- The single API key matching the selected model provider (e.g., if model is `anthropic/*`, only pass `ANTHROPIC_API_KEY`)

Each agent definition could optionally declare additional env vars in its frontmatter:

```yaml
env: FIRECRAWL_API_KEY
```

The helper maps provider prefixes to env var names:
- `anthropic/*` → `ANTHROPIC_API_KEY`
- `openai/*` → `OPENAI_API_KEY`
- `google/*` → `GEMINI_API_KEY`
- `openrouter/*` → `OPENROUTER_API_KEY`

#### Behavior Change

Subagents using OpenAI models would no longer see `ANTHROPIC_API_KEY` and vice versa. The pi-pi experts that use firecrawl would need `env: FIRECRAWL_API_KEY` added to their frontmatter. Any extension spawning a subprocess that relies on an unexpected env var (like a custom `NODE_PATH` or proxy config) would break until that var is added to the allowlist. Most workflows would be unaffected since subprocesses only need the one API key for their model.

---

### SEC-003: Damage-Control Bypass via Path Manipulation

**Severity:** 🔴 Critical
**File:** `extensions/damage-control.ts`

#### Description

The `isPathMatch()` function has multiple bypass vectors:

```typescript
function isPathMatch(targetPath: string, pattern: string, cwd: string): boolean {
    const regex = new RegExp(`^${regexPattern}$|^${regexPattern}/|/${regexPattern}$|/${regexPattern}/`);
    return regex.test(targetPath) || regex.test(relativePath) ||
           targetPath.includes(resolvedPattern) || relativePath.includes(resolvedPattern);
}
```

**Known bypass vectors:**
- **Symlink traversal:** `ln -s ~/.ssh/id_rsa ./innocent_file` then reading `./innocent_file`
- **Path encoding:** `./path/../.env` or `path/to/../../.env` may not match depending on resolution order
- **Bash indirection:** `cat $(echo .env)` — the substring check on the command string doesn't see `.env`
- **Bash variables:** `x=.env; cat $x` bypasses `command.includes(".env")`
- **Base64 encoding:** `cat $(echo LmVudg== | base64 -d)` reads `.env`

#### Fix Plan

Overhaul `isPathMatch()` in three stages:

1. **Symlink resolution:** Resolve all input paths through `fs.realpathSync()` wrapped in a try/catch (for non-existent targets), falling back to `path.resolve()`. This catches symlink traversal.
2. **Path normalization:** Collapse `..` segments via `path.resolve()` before any comparison.
3. **Bash argument extraction:** For bash commands, move from substring matching to a two-layer approach: extract all file path arguments from the command using a basic shell argument parser (split on spaces, handle quotes), resolve each extracted path, and check those resolved paths against the rules.

#### Behavior Change

Symlinked paths would now be caught — `cat ./link-to-env` would be blocked if the symlink target is `.env`. Commands with `../` traversal like `cat foo/../../.env` would be blocked. The bash argument parser would add slight overhead to every bash tool call (microseconds, not noticeable). Edge cases like `cat $(echo .env)` would still bypass — the system needs a documented "best-effort" caveat for bash indirection. Some legitimate commands containing path-like strings matching rules could get false-positive blocks, so the `ask: true` pattern should be used more liberally for ambiguous matches.

---

### SEC-004: Regex Denial of Service in Damage-Control Rules

**Severity:** 🔴 Critical
**File:** `extensions/damage-control.ts`

#### Description

The YAML rules file contains regex patterns compiled at runtime with no validation:

```typescript
for (const rule of rules.bashToolPatterns) {
    const regex = new RegExp(rule.pattern);  // arbitrary regex from YAML
    if (regex.test(command)) { ... }
}
```

A malicious or poorly crafted pattern could cause catastrophic backtracking. The current YAML patterns are well-written, but the system accepts arbitrary regex from a config file that could be modified.

#### Fix Plan

Add a `validateRegex()` call in the `session_start` handler right after loading the YAML. Two approaches:

**Option A (preferred): Switch to `re2` package**
- The `re2` npm package guarantees linear-time matching and eliminates ReDoS entirely
- Requires rewriting patterns that use lookahead/lookbehind (e.g., `--force(?!-with-lease)` becomes two rules)

**Option B: Timeout-based validation**
- For each pattern, compile it and test against adversarial strings (long repeated characters)
- Use `vm.runInNewContext` with a 100ms timeout
- Patterns that fail validation are dropped with a warning notification

In either case, validate at load time and surface failures.

#### Behavior Change

**If using `re2`:** The rule `'--force(?!-with-lease)'` uses a negative lookahead which `re2` doesn't support. This would need to become two rules: one that matches `--force` with `ask: true`, and a separate early-return allowance for `--force-with-lease`. All other current rules would work unchanged.

**If using timeout validation:** The current rules all pass fine and nothing changes for normal usage. Only future malicious or poorly-written rules added to the YAML would be caught and dropped with a notification.

---

## High Issues

---

### SEC-005: .env.sample Contains Key Format Hints

**Severity:** 🟠 High
**File:** `.env.sample`

#### Description

The sample environment file reveals exact key prefixes and which services are in use:

```bash
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
FIRECRAWL_API_KEY=fc-...
```

This aids targeted credential theft by revealing the exact services and key formats used.

#### Fix Plan

Replace all placeholder values with generic strings:

```bash
OPENAI_API_KEY=your-openai-api-key-here
ANTHROPIC_API_KEY=your-anthropic-api-key-here
FIRECRAWL_API_KEY=your-firecrawl-api-key-here
```

Add a comment block with links to each provider's dashboard for key generation.

#### Behavior Change

None to functionality. Developers copying the sample would see clearer instructions. The only downside is losing the visual cue of key prefix format, which some developers find helpful for verifying they pasted the right key. This is a worthwhile tradeoff.

---

### SEC-006: Agent Session Files Stored in Plaintext

**Severity:** 🟠 High
**Files:** `extensions/agent-team.ts`, `extensions/agent-chain.ts`

#### Description

Session files under `.pi/agent-sessions/` contain full conversation history including potentially sensitive data (code, credentials mentioned in chat, file contents). These are unencrypted JSON files with no access control.

```typescript
const agentSessionFile = join(sessionDir, `${agentKey}.json`);
```

#### Fix Plan

Two-part approach:

**Part 1 — Session cleanup (immediate):**
In the `session_start` handlers (which already wipe session files on `/new`), add a `maxAge` check that deletes session files older than 24 hours on startup.

**Part 2 — Optional encryption (follow-up):**
Add an `encryptSessions: true` setting in `.pi/settings.json`. When enabled, use Node's `crypto.createCipheriv()` with AES-256-GCM. The key is derived from a machine-local secret (hash of hostname + user UID + a salt stored in `~/.pi/session-key`). Encrypt session JSON before writing, decrypt on read.

#### Behavior Change

**With cleanup only:** Old session files disappear after 24 hours. This is fine since these extensions already wipe sessions on every `/new`.

**With encryption:** Session files become unreadable binary blobs. The `-c` (continue) flag in subprocesses would still work because the same machine-local key decrypts them. Copying session files to another machine would not work, but they are not portable today anyway. Encryption adds a few milliseconds of overhead per subprocess launch.

---

### SEC-007: No Input Length Validation on Tasks/Prompts

**Severity:** 🟠 High
**Files:** `extensions/agent-team.ts`, `extensions/agent-chain.ts`, `extensions/pi-pi.ts`, `extensions/subagent-widget.ts`

#### Description

User input for task descriptions has no length limits. An extremely long prompt could:
- Exceed CLI argument length limits (causing silent failures)
- Cause excessive token consumption and cost
- Be used for prompt stuffing attacks

#### Fix Plan

Add a `MAX_TASK_LENGTH` constant (10,000 characters) in each extension that spawns subprocesses. Before calling `dispatchAgent()`, `runAgent()`, or `queryExpert()`, check `task.length > MAX_TASK_LENGTH` and return an error result if exceeded.

Also add a `MAX_SYSTEM_PROMPT_LENGTH` check (50,000 characters) when loading agent `.md` files, to catch absurdly large agent definitions.

Both limits would be defined as named constants at the top of each file for easy tuning.

#### Behavior Change

Tasks over 10K characters would be rejected with an error message telling the agent to break the task into smaller pieces. This is unlikely to affect normal usage — most task descriptions are a few hundred characters. The system prompt check would only trigger if someone accidentally concatenates a huge file into an agent definition.

---

### SEC-008: cross-agent.ts Executes Commands from Foreign Agent Directories

**Severity:** 🟠 High
**File:** `extensions/cross-agent.ts`

#### Description

The extension loads `.md` command templates from `.claude/`, `.gemini/`, `.codex/` directories and performs string substitution, then sends the result as a user message:

```typescript
function expandArgs(template: string, args: string): string {
    let result = template;
    result = result.replace(/\$ARGUMENTS|\$@/g, args);
    for (let i = 0; i < parts.length; i++) {
        result = result.replaceAll(`$${i + 1}`, parts[i]);
    }
    return result;
}
// ...
pi.sendUserMessage(expandArgs(cmd.content, args || ""));
```

If a malicious command template is placed in those directories (via a compromised dependency or shared repo), it could inject arbitrary prompts.

#### Fix Plan

Add a confirmation step before sending expanded command content. After `expandArgs()` produces the final string, show a `ctx.ui.confirm()` dialog: "Run command from {source}?" with a preview of the first 200 characters.

Add a per-session allowlist: once a user approves a command name from a specific source, skip the confirmation for subsequent uses in the same session. Store the allowlist in a `Set<string>` keyed by `${source}:${commandName}`.

Project-local commands from `.pi/` could optionally be trusted by default since they are part of the project's own configuration.

#### Behavior Change

First time a user runs `/some-claude-command`, they would see a confirmation dialog showing what text will be injected. Subsequent uses of the same command in the same session would go through without prompting. This adds one extra interaction per unique foreign command per session. The `remember for session` behavior mitigates friction for repeated use.

---

## Medium Issues

---

### SEC-009: Swallowed Errors Hide Failures Silently

**Severity:** 🟡 Medium
**Files:** `extensions/agent-team.ts`, `extensions/agent-chain.ts`, `extensions/pi-pi.ts`, `extensions/system-select.ts`, `extensions/cross-agent.ts`, `extensions/damage-control.ts`

#### Description

Empty catch blocks throughout the codebase silently swallow errors:

```typescript
} catch {}  // appears in at least 6 extensions
```

This includes file read failures, JSON parse errors, and spawn errors. It makes debugging harder and could mask security-relevant failures such as a corrupted agent file being silently skipped.

#### Fix Plan

Create a shared `log` utility in `extensions/utils/logger.ts`. It writes to a rotating log file at `.pi/extension-debug.log` (max 1MB, one backup file). Replace all empty `catch {}` blocks with `catch (e) { log.warn("context-description", e); }`.

The logger is a no-op if a `DEBUG_EXTENSIONS` env var is not set, so there is zero overhead in normal usage. In debug mode, errors also surface as dim notifications via `ctx.ui.notify()`.

Add `.pi/extension-debug.log` to `.gitignore`.

#### Behavior Change

In normal usage, nothing visible changes — the logger defaults to silent. When `DEBUG_EXTENSIONS=1` is set, developers would see logged warnings for things like: unreadable agent files, malformed JSON in subprocess stdout, failed theme applications, and filesystem scan errors. This makes troubleshooting extension issues much faster without adding noise to normal workflows.

---

### SEC-010: system-select.ts Loads System Prompts from Global Home Directories

**Severity:** 🟡 Medium
**File:** `extensions/system-select.ts`

#### Description

Agents loaded from global home directories are given the same trust as project-local ones:

```typescript
const dirs: [string, string][] = [
    [join(home, ".pi", "agent", "agents"), "~/.pi"],
    [join(home, ".claude", "agents"), "~/.claude"],
    [join(home, ".gemini", "agents"), "~/.gemini"],
    [join(home, ".codex", "agents"), "~/.codex"],
];
```

A malicious global agent could override the system prompt with prompt injection payloads. The `[source]` label in the select dialog is present but easy to overlook.

#### Fix Plan

Add a visual trust indicator in the select dialog. Prefix global agents with ⚠️ and local agents with ✓. Add a `trustedSources` array in `.pi/settings.json`:

```json
{
  "trustedSources": [".pi", ".claude"]
}
```

Global sources (`~/.pi`, `~/.claude`, etc.) are loaded but marked as `untrusted` unless explicitly added to the config. When an untrusted agent is selected, show a one-time `ctx.ui.confirm()` dialog: "This agent is from {source} (outside this project). Use it?"

#### Behavior Change

Project-local agents work exactly as before. Global agents still appear in the list but are visually marked and require one confirmation per session. Users who rely on global agents would add `"~/.pi"` to `trustedSources` in their settings to skip the prompt. The select dialog becomes more informative with trust indicators.

---

### SEC-011: Race Condition in Subprocess Management

**Severity:** 🟡 Medium
**Files:** `extensions/agent-team.ts`, `extensions/pi-pi.ts`, `extensions/subagent-widget.ts`

#### Description

The check-then-set pattern for tracking running agents is not atomic:

```typescript
if (state.status === "running") {
    return Promise.resolve({ output: `Already running...`, exitCode: 1, elapsed: 0 });
}
state.status = "running";  // gap between check and set
```

Two rapid dispatches to the same agent could both pass the check before either sets `"running"`. This is unlikely in single-threaded Node.js but could happen with async scheduling if two tool calls arrive in one response.

#### Fix Plan

Replace the check-then-set pattern with a `Set<string>` called `inFlight` managed synchronously:

```typescript
const inFlight = new Set<string>();

function dispatchAgent(agentName, task, ctx) {
    const key = agentName.toLowerCase();
    if (inFlight.has(key)) return Promise.resolve({ ... error ... });
    inFlight.add(key);  // synchronous — no gap
    // ...
    proc.on("close", () => { inFlight.delete(key); });
    proc.on("error", () => { inFlight.delete(key); });
}
```

This is safe because Node.js is single-threaded and `Set` operations are synchronous. Cleanup in `session_start` clears the set to prevent stale locks.

#### Behavior Change

Functionally identical to current behavior for normal usage. The difference is that even if two `dispatch_agent` tool calls arrive in the same microtask batch (theoretically possible if the LLM produces two tool calls in one response), the second one is guaranteed to be rejected. The `status` field on the agent state still gets updated as before, but the `inFlight` set is the authoritative lock.

---

### SEC-012: damage-control.ts Read-Only Heuristic for Bash is Weak

**Severity:** 🟡 Medium
**File:** `extensions/damage-control.ts`

#### Description

The heuristic for detecting modifications to read-only paths is easily bypassed through interpreter indirection:

```typescript
if (command.includes(rop) && (/[\s>|]/.test(command) || command.includes("rm") || ...))
```

Bypass examples:
- `python3 -c "open('.bashrc','w').write('pwned')"` — no `rm`, `sed`, `>`, or `|`
- `node -e "require('fs').writeFileSync('.bashrc','pwned')"` — same

#### Fix Plan

Two changes:

1. **Documentation:** Add explicit documentation (in the YAML file header and a new `DAMAGE_CONTROL.md` doc) stating: "Damage-control is a safety net for accidental destructive commands, not a security sandbox. Determined bypass through interpreter indirection (python, node, perl) is not caught."

2. **Interpreter patterns:** Add a new YAML section `interpreterWriteWarnings` with patterns like:
   - `python.*open\(.*['"]w`
   - `node.*writeFile`
   - `perl.*open.*>`

   These trigger `ask: true` confirmations rather than hard blocks, catching the most obvious interpreter-based file writes without being overly restrictive.

#### Behavior Change

Commands like `python3 -c "open('.bashrc','w')"` would now trigger a confirmation dialog instead of passing silently. Legitimate use of python/node/perl for file operations would get an extra confirmation step, which could be annoying during heavy scripting sessions. The documentation change sets correct expectations — users understand they are getting a seatbelt, not a jail.

---

## Low / Informational Issues

---

### SEC-013: process.argv Access for Theme Resolution

**Severity:** 🟢 Low
**File:** `extensions/themeMap.ts`

#### Description

Theme resolution depends on parsing `process.argv` to find the first `-e` flag:

```typescript
function primaryExtensionName(): string | null {
    const argv = process.argv;
    for (let i = 0; i < argv.length - 1; i++) {
        if (argv[i] === "-e" || argv[i] === "--extension") {
            return basename(argv[i + 1]).replace(/\.[^.]+$/, "");
        }
    }
    return null;
}
```

Not a direct vulnerability, but creates coupling to the launch command that could behave unexpectedly if the CLI interface changes.

#### Fix Plan

Replace `process.argv` parsing with an extension registration-order approach. Add a module-level `let primaryName: string | null = null`. The first extension to call `applyExtensionDefaults()` sets the value; subsequent calls see it is already set and skip theme/title application. This removes the dependency on how the CLI was invoked.

#### Behavior Change

The theme and title would always be set by whichever extension's `session_start` fires first, regardless of how pi was launched. This is already the intended behavior — the `process.argv` approach was a workaround to achieve it. If extension load order changes in a future pi version, the behavior remains consistent because it is based on execution order rather than CLI argument parsing.

---

### SEC-014: No CSP or Sandboxing for Subprocesses

**Severity:** 🟢 Low
**Files:** `extensions/agent-team.ts`, `extensions/agent-chain.ts`, `extensions/pi-pi.ts`, `extensions/subagent-widget.ts`

#### Description

All spawned `pi` subprocesses run with the same OS user privileges as the parent. There is no sandboxing, resource limits, or timeout enforcement beyond what pi itself implements. A runaway agent could consume CPU/memory indefinitely.

#### Fix Plan

Add a `timeout` option to all `spawn()` calls:

- Default: 5 minutes for normal agents, 15 minutes for chains
- Implementation: store the `proc` reference and set a `setTimeout` that calls `proc.kill("SIGTERM")` followed by a 5-second grace period and `proc.kill("SIGKILL")`
- Update the agent state to `"error"` with a `"timed out"` message
- Allow per-agent override via frontmatter: `timeout: 900` (seconds)

Add a `maxConcurrentAgents` limit (default 5) enforced via an `inFlight` set (see SEC-011).

#### Behavior Change

Long-running agents (over 5 minutes by default) would be killed. This could affect legitimate long tasks like large refactors — users would need to increase the timeout via a setting or per-agent frontmatter field. The concurrent agent limit would prevent scenarios where a looping orchestrator spawns dozens of subprocesses. The `dispatch_agent` tool would return a clear "timed out after Xs" error so the orchestrator can retry or adjust.

---

### SEC-015: .pi/settings.json References Parent Directory

**Severity:** 🟢 Low
**File:** `.pi/settings.json`

#### Description

The settings file contains a parent-relative path:

```json
{
  "prompts": ["../.claude/commands"]
}
```

This traverses outside the project root, which could unintentionally expose commands from a different project context.

#### Fix Plan

Add a path validation check in the settings loader. When resolving paths from `settings.json`:

1. Call `path.resolve(cwd, configuredPath)`
2. Verify the result starts with `cwd` or is within a known safe location (`~/.pi/`, `~/.claude/`)
3. Paths that escape the project root log a warning

Add an `allowParentPaths: true` escape hatch in settings for users who intentionally share configs across sibling projects.

#### Behavior Change

The current `"../.claude/commands"` reference would trigger a warning on startup: "Settings reference path outside project root: ../.claude/commands". If `allowParentPaths` is false (the default), the path would be skipped. Users with the current setup would need to either add `allowParentPaths: true` or restructure to use `~/.claude/commands` (absolute home-relative path) instead. This is a minor inconvenience but prevents unintentional cross-project config leakage.

---

## What's Done Well

| Area | Detail |
|------|--------|
| ✅ Credential hygiene | `.env` is in `.gitignore` — credentials will not be committed |
| ✅ Session data isolation | `.pi/agent-sessions/` is in `.gitignore` — session data stays local |
| ✅ Comprehensive rules | Damage-control covers destructive commands across AWS, GCP, Firebase, Vercel, Netlify, Cloudflare, SQL, and git |
| ✅ Graduated enforcement | `ask: true` pattern for borderline operations (git checkout, stash drop) — good UX |
| ✅ Safe subprocess API | `spawn()` with array args instead of shell execution avoids basic shell injection |
| ✅ Least-privilege agents | Agents have restricted toolsets (`read,grep,find,ls` for read-only agents) |
| ✅ Security awareness | Red-team agent exists in the project, showing security is a design consideration |
| ✅ Abort after block | `ctx.abort()` is called after damage-control violations, preventing continued execution |

---

## Priority Matrix

| ID | Severity | Issue | Effort | Fix Priority |
|----|----------|-------|--------|-------------|
| SEC-001 | 🔴 Critical | Command injection in spawn() | Medium | ✅ FIXED |
| SEC-002 | 🔴 Critical | Full env inheritance in subprocesses | Low | P0 |
| SEC-003 | 🔴 Critical | Damage-control path bypass | High | P0 |
| SEC-004 | 🔴 Critical | ReDoS in damage-control rules | Medium | P0 |
| SEC-005 | 🟠 High | .env.sample key format hints | Trivial | P1 |
| SEC-006 | 🟠 High | Plaintext session files | Medium | P1 |
| SEC-007 | 🟠 High | No input length validation | Low | P1 |
| SEC-008 | 🟠 High | Foreign command execution | Medium | P1 |
| SEC-009 | 🟡 Medium | Swallowed errors | Low | P2 |
| SEC-010 | 🟡 Medium | Global agent trust | Medium | P2 |
| SEC-011 | 🟡 Medium | Race condition in subprocess mgmt | Low | P2 |
| SEC-012 | 🟡 Medium | Weak bash read-only heuristic | Medium | P2 |
| SEC-013 | 🟢 Low | process.argv coupling | Low | P3 |
| SEC-014 | 🟢 Low | No subprocess sandboxing | Medium | P3 |
| SEC-015 | 🟢 Low | Parent directory reference | Low | P3 |

---

*End of audit.*
