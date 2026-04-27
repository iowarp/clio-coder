import { ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	buildSelfDevPrompt,
	evaluateSelfDevBashCommand,
	evaluateSelfDevWritePath,
	resolveSelfDevMode,
	type SelfDevMode,
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

describe("core/self-dev prompt", () => {
	it("states the repository, branch, CI gate, and engine restart rule", () => {
		const prompt = buildSelfDevPrompt(mode({ dirtySummary: "2 changed path(s): src/a.ts; tests/b.ts" }));
		ok(prompt.includes("Clio Coder repository"));
		ok(prompt.includes("feature/self-dev"));
		ok(prompt.includes("npm run ci"));
		ok(prompt.includes("src/engine/"));
		ok(prompt.includes("restart"));
	});
});
