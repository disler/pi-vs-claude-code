import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, lstatSync, readlinkSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import {
  evaluateBashForRole,
  evaluatePathForRole,
  normalizeToolPath,
} from "../extensions/idc-role-harness.ts";

const repo = resolve(import.meta.dir, "..");
const script = resolve(repo, "scripts/idc-pi");
const installer = resolve(repo, "scripts/install-idc-pi");

describe("idc-pi launcher", () => {
  test("dry-run run launches a role from the target repo with absolute harness assets", () => {
    const result = spawnSync(script, ["run", "think", "--dry-run"], {
      cwd: repo,
      env: {
        ...process.env,
        PI_IDC_COMS_PROJECT: "unit-project",
        PI_IDC_GUARD_MODE: "block",
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`cd ${shellQuoted(repo)}`);
    expect(result.stdout).toContain("'--session-id' 'idc-think'");
    expect(result.stdout).toContain(`${repo}/extensions/coms-net.ts`);
    expect(result.stdout).toContain(`${repo}/extensions/idc-role-harness.ts`);
    expect(result.stdout).toContain("'--idc-role' 'think'");
    expect(result.stdout).toContain("'--project' 'unit-project'");
    expect(result.stdout).toContain("coms_net_await");
  });

  test("dry-run open-all-cmux builds one cmux workspace with server and all roles", () => {
    const result = spawnSync(script, ["open-all-cmux", "--dry-run"], {
      cwd: repo,
      env: {
        ...process.env,
        PI_IDC_COMS_PROJECT: "unit-project",
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("cmux new-workspace");
    expect(result.stdout).toContain("--name 'IDC: pi-vs-claude-code'");
    expect(result.stdout).toContain(`--cwd ${shellQuoted(repo)}`);
    expect(result.stdout).toContain("internal-run-server");
    for (const role of ["think", "plan", "sequence", "ripple", "build-impl", "build-review", "build-finish"]) {
      expect(result.stdout).toContain(`internal-run-role ${shellQuoted(role)}`);
    }
    expect(result.stdout).not.toContain("osascript");
  });

  test("dry-run open-cmux includes only selected roles plus server", () => {
    const result = spawnSync(script, ["open-cmux", "think", "plan", "ripple", "--dry-run"], {
      cwd: repo,
      env: {
        ...process.env,
        PI_IDC_COMS_PROJECT: "unit-project",
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("internal-run-server");
    for (const role of ["think", "plan", "ripple"]) {
      expect(result.stdout).toContain(`internal-run-role ${shellQuoted(role)}`);
    }
    expect(result.stdout).not.toContain("internal-run-role 'sequence'");
    expect(result.stdout).not.toContain("internal-run-role 'build-impl'");
  });

  test("open-cmux rejects unknown roles", () => {
    const result = spawnSync(script, ["open-cmux", "think", "unknown", "--dry-run"], {
      cwd: repo,
      env: process.env,
      encoding: "utf8",
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("unknown role: unknown");
  });

  test("pass-through args are not re-evaluated (no command substitution / no set -u crash)", () => {
    const sentinel = join(tmpdir(), `idc-pi-pwned-${process.pid}`);
    rmSync(sentinel, { force: true });
    const payload = `$(touch ${sentinel})`;

    const result = spawnSync(script, ["run", "think", "--dry-run", payload], {
      cwd: repo,
      env: { ...process.env, PI_IDC_COMS_PROJECT: "unit-project" },
      encoding: "utf8",
    });

    // The launcher must not crash on a `$`-bearing arg, must not execute the
    // substitution, and must forward the literal payload to pi.
    expect(result.status).toBe(0);
    expect(existsSync(sentinel)).toBe(false);
    expect(result.stdout).toContain(payload);
    rmSync(sentinel, { force: true });
  });

  test("rejects a coms project name that would traverse the filesystem", () => {
    const result = spawnSync(script, ["run", "think", "--dry-run"], {
      cwd: repo,
      env: { ...process.env, PI_IDC_COMS_PROJECT: "../../etc/evil" },
      encoding: "utf8",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("coms project");
  });
});

describe("IDC installer", () => {
  test("installs durable commands and managed PATH block idempotently", () => {
    const tempHome = mkdtempSync(join(tmpdir(), "idc-pi-home-"));
    const prefix = join(tempHome, ".local", "bin");
    mkdirSync(prefix, { recursive: true });

    const env = {
      ...process.env,
      HOME: tempHome,
      SHELL: "/bin/zsh",
      PATH: "/usr/bin:/bin",
    };

    const first = spawnSync(installer, ["--prefix", prefix], { cwd: repo, env, encoding: "utf8" });
    const second = spawnSync(installer, ["--prefix", prefix], { cwd: repo, env, encoding: "utf8" });

    expect(first.status).toBe(0);
    expect(second.status).toBe(0);

    for (const command of ["idc-pi", "idc-open-all", "idc-open", "idc-run", "idc-coms-server", "idc-open-all-cmux", "idc-open-cmux"]) {
      const installed = join(prefix, command);
      expect(lstatSync(installed).isSymbolicLink()).toBe(true);
      expect(readlinkSync(installed)).toContain(`/scripts/${command}`);
    }

    const zshrc = readFileSync(join(tempHome, ".zshrc"), "utf8");
    expect(zshrc).toContain("# >>> idc-pi installer >>>");
    expect(zshrc.match(/idc-pi installer/g)?.length).toBe(2);
    expect(zshrc).toContain("export PATH=\"$HOME/.local/bin:$PATH\"");
  });

  test("adds its PATH block even when the rc already mentions a superset path", () => {
    const tempHome = mkdtempSync(join(tmpdir(), "idc-pi-home-superset-"));
    const prefix = join(tempHome, ".local", "bin");
    mkdirSync(prefix, { recursive: true });
    // Pre-seed an rc that references a *different* path sharing our prefix as a
    // substring — a bare substring check would wrongly skip injecting our block.
    writeFileSync(join(tempHome, ".zshrc"), `export PATH="${prefix}-old:$PATH"\n`);

    const env = {
      ...process.env,
      HOME: tempHome,
      SHELL: "/bin/zsh",
      PATH: "/usr/bin:/bin",
    };

    const result = spawnSync(installer, ["--prefix", prefix], { cwd: repo, env, encoding: "utf8" });
    expect(result.status).toBe(0);

    const zshrc = readFileSync(join(tempHome, ".zshrc"), "utf8");
    expect(zshrc).toContain("# >>> idc-pi installer >>>");
  });
});

describe("IDC role path guard", () => {
  test("plan can write canonical planning docs but not source files", () => {
    expect(evaluatePathForRole("plan", normalizeToolPath("docs/prd/prd.md", repo), repo).allowed).toBe(true);
    expect(evaluatePathForRole("plan", normalizeToolPath("src/index.ts", repo), repo).allowed).toBe(false);
  });

  test("build-review is read-only", () => {
    const result = evaluatePathForRole("build-review", normalizeToolPath("src/index.ts", repo), repo);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("read-only");
  });

  test("build-impl allows implementation files but blocks governance surfaces", () => {
    expect(evaluatePathForRole("build-impl", normalizeToolPath("src/index.ts", repo), repo).allowed).toBe(true);
    expect(evaluatePathForRole("build-impl", normalizeToolPath("docs/plans/plan.md", repo), repo).allowed).toBe(false);
  });

  test("ripple canonical writes require the explicit override", () => {
    const withoutOverride = evaluatePathForRole("ripple", normalizeToolPath("docs/prd/prd.md", repo), repo, {
      rippleAllowCanonical: false,
    });
    const withOverride = evaluatePathForRole("ripple", normalizeToolPath("docs/prd/prd.md", repo), repo, {
      rippleAllowCanonical: true,
    });

    expect(withoutOverride.allowed).toBe(false);
    expect(withOverride.allowed).toBe(true);
  });
});

describe("IDC bash guard", () => {
  test("allows mutating bash only when extracted paths are in-role", () => {
    expect(evaluateBashForRole("think", "mkdir -p docs/considerations/new", repo).allowed).toBe(true);
    expect(evaluateBashForRole("think", "touch src/index.ts", repo).allowed).toBe(false);
  });

  test("build-review blocks mutating bash even when the path would otherwise be implementation-owned", () => {
    const result = evaluateBashForRole("build-review", "touch src/index.ts", repo);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("build-review");
  });

  test("blocks unscoped one-liner file writers", () => {
    const result = evaluateBashForRole("build-impl", "node -e \"require('fs').writeFileSync('src/a.ts','')\"", repo);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("no safely extractable path");
  });

  test("mv evaluates the source, not only the destination", () => {
    // Relocating a blocked source into an allowed scratch dir both deletes the
    // protected file and exfiltrates it — the source must be in role authority.
    expect(evaluateBashForRole("think", "mv src/index.ts /tmp/pi-idc/think/stolen.ts", repo).allowed).toBe(false);
    // A move entirely within authority stays allowed.
    expect(evaluateBashForRole("think", "mv /tmp/pi-idc/think/a /tmp/pi-idc/think/b", repo).allowed).toBe(true);
  });

  test("git global options (-C) do not hide a finalization subcommand", () => {
    expect(evaluateBashForRole("build-impl", "git -C /other commit -m x", repo).allowed).toBe(false);
    expect(evaluateBashForRole("build-review", "git -C /other commit -m x", repo).allowed).toBe(false);
  });

  test("treats a lone & as a separator so backgrounded mutations are not hidden", () => {
    expect(evaluateBashForRole("think", "true&touch src/index.ts", repo).allowed).toBe(false);
  });

  test("detects ln and dd writes for read-only roles", () => {
    expect(evaluateBashForRole("build-review", "ln -s /etc/passwd src/x.ts", repo).allowed).toBe(false);
    expect(evaluateBashForRole("build-review", "dd if=/dev/zero of=src/x.ts", repo).allowed).toBe(false);
  });
});

function shellQuoted(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
