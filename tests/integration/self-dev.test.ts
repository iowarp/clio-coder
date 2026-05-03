import { ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	ensureSelfDevBranch,
	evaluateSelfDevBashCommand,
	evaluateSelfDevWritePath,
	resolveSelfDevMode,
	type SelfDevMode,
	sanitizeSelfDevSlug,
} from "../../src/core/self-dev.js";
import { resetXdgCache } from "../../src/core/xdg.js";

function mode(overrides: Partial<SelfDevMode> = {}): SelfDevMode {
	return {
		enabled: true,
		source: "--dev",
		repoRoot: "/repo/clio-coder",
		cwd: "/repo/clio-coder",
		branch: "feature/self-dev",
		dirtySummary: "clean",
		engineWritesAllowed: false,
		...overrides,
	};
}

describe("core/self-dev path policy", () => {
	it("allows source writes on a non-main branch", () => {
		const decision = evaluateSelfDevWritePath(mode(), "/repo/clio-coder/src/tools/read.ts");
		strictEqual(decision.allowed, true);
		if (decision.allowed) strictEqual(decision.restartRequired, false);
	});

	it("marks non-hot-reloadable source writes as restart-required", () => {
		const paths = [
			"/repo/clio-coder/src/core/config.ts",
			"/repo/clio-coder/src/domains/session/extension.ts",
			"/repo/clio-coder/src/interactive/index.ts",
			"/repo/clio-coder/src/tools/policy.ts",
			"/repo/clio-coder/src/tools/codewiki/shared.ts",
			"/repo/clio-coder/src/harness/classifier.ts",
			"/repo/clio-coder/damage-control-rules.yaml",
		];
		for (const path of paths) {
			const decision = evaluateSelfDevWritePath(mode({ engineWritesAllowed: true }), path);
			strictEqual(decision.allowed, true, path);
			if (decision.allowed) strictEqual(decision.restartRequired, true, path);
		}
	});

	it("does not require restart for hot-reloadable nested tool specs or worker changes", () => {
		const hot = evaluateSelfDevWritePath(mode(), "/repo/clio-coder/src/tools/codewiki/find-symbol.ts");
		const worker = evaluateSelfDevWritePath(mode(), "/repo/clio-coder/src/worker/entry.ts");
		strictEqual(hot.allowed, true);
		if (hot.allowed) strictEqual(hot.restartRequired, false);
		strictEqual(worker.allowed, true);
		if (worker.allowed) strictEqual(worker.restartRequired, false);
	});

	it("blocks writes outside the repository", () => {
		const decision = evaluateSelfDevWritePath(mode(), "/tmp/outside.txt");
		strictEqual(decision.allowed, false);
		if (!decision.allowed) ok(decision.reason.includes("outside the Clio repository"));
	});

	it("blocks fixtures and boundary audit records", () => {
		const fixture = evaluateSelfDevWritePath(mode(), "/repo/clio-coder/tests/fixtures/providers/kb/qwen3.yaml");
		const audit = evaluateSelfDevWritePath(mode(), "/repo/clio-coder/docs/.superpowers/boundaries/pi.md");
		strictEqual(fixture.allowed, false);
		strictEqual(audit.allowed, false);
	});

	it("requires opt-in for engine writes and marks allowed engine writes as restart-required", () => {
		const blocked = evaluateSelfDevWritePath(mode(), "/repo/clio-coder/src/engine/types.ts");
		strictEqual(blocked.allowed, false);
		const allowed = evaluateSelfDevWritePath(mode({ engineWritesAllowed: true }), "/repo/clio-coder/src/engine/types.ts");
		strictEqual(allowed.allowed, true);
		if (allowed.allowed) strictEqual(allowed.restartRequired, true);
	});

	it("blocks source writes on protected branches", () => {
		const decision = evaluateSelfDevWritePath(mode({ branch: "main" }), "/repo/clio-coder/src/tools/read.ts");
		strictEqual(decision.allowed, false);
		if (!decision.allowed) ok(decision.reason.includes("non-main git branch"));
	});
});

describe("core/self-dev bash policy", () => {
	it("blocks push, force, and destructive git commands", () => {
		ok(evaluateSelfDevBashCommand("git push origin HEAD"));
		ok(evaluateSelfDevBashCommand("git push --force-with-lease"));
		ok(evaluateSelfDevBashCommand("git reset --hard HEAD"));
		ok(evaluateSelfDevBashCommand("git clean -fd"));
		ok(evaluateSelfDevBashCommand("git checkout -- src/core/config.ts"));
		ok(evaluateSelfDevBashCommand("gh pr merge 123"));
	});

	it("allows normal local verification commands", () => {
		strictEqual(evaluateSelfDevBashCommand("npm run ci"), null);
		strictEqual(evaluateSelfDevBashCommand("git status --short"), null);
		strictEqual(evaluateSelfDevBashCommand("git commit -m test"), null);
	});
});

describe("core/self-dev bash policy uses the dev rule pack", () => {
	it("evaluateSelfDevBashCommand resolves block reasons from the dev pack, not a local list", () => {
		// Asserts the wiring: the rule descriptions in damage-control-rules.yaml
		// (packs[id=dev]) are the source of truth. If self-dev-guards held its
		// own local regex array, the description text below would diverge.
		const reason = evaluateSelfDevBashCommand("git push origin HEAD");
		strictEqual(reason, "self-dev: git push is blocked");
	});
});

describe("core/self-dev activation gate", () => {
	const ORIGINAL_ENV = { ...process.env };
	let scratch: string;
	let originalCwd: string;
	let stderrBuffer: string;
	let originalStderrWrite: typeof process.stderr.write;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "clio-selfdev-gate-"));
		// Build a fake repo: package.json + src/ so resolveRepoRoot finds it.
		mkdirSync(join(scratch, "src"), { recursive: true });
		writeFileSync(join(scratch, "package.json"), '{"name":"fake"}', "utf8");
		// Sandbox CLIO_HOME so the XDG fallback for CLIO-dev.md does not see
		// the developer's real ~/.config/clio/CLIO-dev.md.
		process.env.CLIO_HOME = scratch;
		process.env.CLIO_CONFIG_DIR = join(scratch, "config");
		process.env.CLIO_DATA_DIR = join(scratch, "data");
		process.env.CLIO_CACHE_DIR = join(scratch, "cache");
		mkdirSync(process.env.CLIO_CONFIG_DIR, { recursive: true });
		resetXdgCache();
		originalCwd = process.cwd();
		process.chdir(scratch);
		stderrBuffer = "";
		originalStderrWrite = process.stderr.write.bind(process.stderr);
		process.stderr.write = ((chunk: unknown) => {
			stderrBuffer += typeof chunk === "string" ? chunk : String(chunk);
			return true;
		}) as typeof process.stderr.write;
	});
	afterEach(() => {
		process.stderr.write = originalStderrWrite;
		process.chdir(originalCwd);
		for (const k of Object.keys(process.env)) {
			if (!(k in ORIGINAL_ENV)) Reflect.deleteProperty(process.env, k);
		}
		for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
			if (v !== undefined) process.env[k] = v;
		}
		resetXdgCache();
		rmSync(scratch, { recursive: true, force: true });
	});

	it("returns null and writes a clear stderr error when CLIO_DEV=1 but no CLIO-dev.md exists", () => {
		process.env.CLIO_DEV = "1";
		Reflect.deleteProperty(process.env, "CLIO_SELF_DEV");
		const mode = resolveSelfDevMode();
		strictEqual(mode, null);
		ok(stderrBuffer.includes("CLIO-dev.md"), stderrBuffer);
		ok(stderrBuffer.includes("create one to enable dev mode"), stderrBuffer);
	});

	it("returns a SelfDevMode when CLIO_DEV=1 and <repoRoot>/CLIO-dev.md exists", () => {
		process.env.CLIO_DEV = "1";
		writeFileSync(join(scratch, "CLIO-dev.md"), "# dev supplement\n", "utf8");
		const mode = resolveSelfDevMode();
		ok(mode !== null);
		strictEqual(mode?.repoRoot, scratch);
	});

	it("returns a SelfDevMode when only the XDG fallback CLIO-dev.md exists", () => {
		process.env.CLIO_DEV = "1";
		writeFileSync(join(process.env.CLIO_CONFIG_DIR ?? "", "CLIO-dev.md"), "# dev supplement\n", "utf8");
		const mode = resolveSelfDevMode();
		ok(mode !== null);
	});
});

describe("core/self-dev slug sanitization", () => {
	it("kebab-cases, trims, and caps at 40 chars", () => {
		strictEqual(sanitizeSelfDevSlug("Add Cool Feature!"), "add-cool-feature");
		strictEqual(sanitizeSelfDevSlug("  multiple   spaces  "), "multiple-spaces");
		strictEqual(sanitizeSelfDevSlug("a".repeat(60)).length, 40);
		// trailing/leading punctuation collapses cleanly
		strictEqual(sanitizeSelfDevSlug("---"), "");
		strictEqual(sanitizeSelfDevSlug(""), "");
		strictEqual(sanitizeSelfDevSlug("***"), "");
	});
});

describe("core/self-dev branch enforcement", () => {
	let stderrBuffer: string;
	let originalStderrWrite: typeof process.stderr.write;

	beforeEach(() => {
		stderrBuffer = "";
		originalStderrWrite = process.stderr.write.bind(process.stderr);
		process.stderr.write = ((chunk: unknown) => {
			stderrBuffer += typeof chunk === "string" ? chunk : String(chunk);
			return true;
		}) as typeof process.stderr.write;
	});
	afterEach(() => {
		process.stderr.write = originalStderrWrite;
	});

	it("returns the input mode unchanged on a non-protected branch", async () => {
		const promptCalls: number[] = [];
		const gitCalls: string[][] = [];
		const m = mode({ branch: "feat/foo" });
		const result = await ensureSelfDevBranch(m, {
			readBranch: () => "feat/foo",
			promptSlug: async () => {
				promptCalls.push(1);
				return "x";
			},
			runGit: (_root, args) => {
				gitCalls.push([...args]);
			},
		});
		ok(result !== null);
		strictEqual(result, m);
		strictEqual(promptCalls.length, 0);
		strictEqual(gitCalls.length, 0);
	});

	it("creates selfdev/<date>-<slug> on a protected branch", async () => {
		const gitCalls: string[][] = [];
		const m = mode({ branch: "main" });
		const result = await ensureSelfDevBranch(m, {
			readBranch: () => "main",
			promptSlug: async () => "Add Auto Branch",
			runGit: (_root, args) => {
				gitCalls.push([...args]);
			},
			now: () => new Date("2026-04-27T10:00:00Z"),
		});
		ok(result !== null);
		strictEqual(result?.branch, "selfdev/2026-04-27-add-auto-branch");
		strictEqual(gitCalls.length, 1);
		strictEqual(gitCalls[0]?.[0], "switch");
		strictEqual(gitCalls[0]?.[1], "-c");
		strictEqual(gitCalls[0]?.[2], "selfdev/2026-04-27-add-auto-branch");
	});

	it("returns null and warns when the prompt resolves to null", async () => {
		const gitCalls: string[][] = [];
		const result = await ensureSelfDevBranch(mode({ branch: "main" }), {
			readBranch: () => "main",
			promptSlug: async () => null,
			runGit: (_root, args) => {
				gitCalls.push([...args]);
			},
		});
		strictEqual(result, null);
		strictEqual(gitCalls.length, 0);
		ok(stderrBuffer.includes("cancelled"), stderrBuffer);
	});

	it("returns null when sanitization swallows the entire input", async () => {
		const gitCalls: string[][] = [];
		const result = await ensureSelfDevBranch(mode({ branch: "master" }), {
			readBranch: () => "master",
			promptSlug: async () => "***",
			runGit: (_root, args) => {
				gitCalls.push([...args]);
			},
		});
		strictEqual(result, null);
		strictEqual(gitCalls.length, 0);
		ok(stderrBuffer.includes("cancelled"), stderrBuffer);
	});

	it("returns null and surfaces the git error when git switch fails", async () => {
		const result = await ensureSelfDevBranch(mode({ branch: "trunk" }), {
			readBranch: () => "trunk",
			promptSlug: async () => "feat",
			runGit: () => {
				throw new Error("fatal: a branch named 'selfdev/...' already exists");
			},
			now: () => new Date("2026-04-27T10:00:00Z"),
		});
		strictEqual(result, null);
		ok(stderrBuffer.includes("git switch -c"), stderrBuffer);
		ok(stderrBuffer.includes("already exists"), stderrBuffer);
	});

	it("treats detached HEAD as a protected branch", async () => {
		const gitCalls: string[][] = [];
		const result = await ensureSelfDevBranch(mode({ branch: null }), {
			readBranch: () => null,
			promptSlug: async () => "hotfix",
			runGit: (_root, args) => {
				gitCalls.push([...args]);
			},
			now: () => new Date("2026-04-27T10:00:00Z"),
		});
		ok(result !== null);
		strictEqual(result?.branch, "selfdev/2026-04-27-hotfix");
		strictEqual(gitCalls.length, 1);
		ok(stderrBuffer.includes("detached HEAD"), stderrBuffer);
	});

	it("returns the input mode unchanged when CLIO_DEV_ALLOW_PROTECTED_BRANCH=1", async () => {
		const previous = process.env.CLIO_DEV_ALLOW_PROTECTED_BRANCH;
		process.env.CLIO_DEV_ALLOW_PROTECTED_BRANCH = "1";
		try {
			const promptCalls: number[] = [];
			const gitCalls: string[][] = [];
			const m = mode({ branch: "main" });
			const result = await ensureSelfDevBranch(m, {
				readBranch: () => "main",
				promptSlug: async () => {
					promptCalls.push(1);
					return "x";
				},
				runGit: (_root, args) => {
					gitCalls.push([...args]);
				},
			});
			strictEqual(result, m);
			strictEqual(promptCalls.length, 0);
			strictEqual(gitCalls.length, 0);
			strictEqual(stderrBuffer, "");
		} finally {
			if (previous === undefined) {
				Reflect.deleteProperty(process.env, "CLIO_DEV_ALLOW_PROTECTED_BRANCH");
			} else {
				process.env.CLIO_DEV_ALLOW_PROTECTED_BRANCH = previous;
			}
		}
	});
});
