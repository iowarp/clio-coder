import { strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ToolNames } from "../../src/core/tool-names.js";
import type { SafetyContract } from "../../src/domains/safety/contract.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";

/**
 * Layer 2 of Slice C: a worker safety configured with writeRoots blocks every
 * write-class target that escapes the roots, regardless of whether the
 * classifier keeps it plain "write" (in-cwd sibling) or escalates it to
 * system_modify (out-of-cwd/system path). Read tools are never gated.
 */
describe("contracts/write-roots", () => {
	let scratch: string;
	let root: string;
	let safety: SafetyContract;
	let originalCwd: string;

	beforeEach(() => {
		originalCwd = process.cwd();
		scratch = mkdtempSync(join(tmpdir(), "clio-write-roots-"));
		// The worker runs with the job cwd as its process cwd, so writes inside it
		// classify plain "write". Mirror that here so the classifier does not
		// escalate scratch paths to system_modify for being outside the repo root.
		process.chdir(scratch);
		root = join(scratch, ".clio-coder", "wiki-staging-abc");
		safety = createWorkerSafety({ cwd: scratch, writeRoots: [root] });
	});

	afterEach(() => {
		process.chdir(originalCwd);
		rmSync(scratch, { recursive: true, force: true });
	});

	it("blocks a write whose absolute target is outside every root", () => {
		const decision = safety.evaluate({ tool: ToolNames.Write, args: { file_path: "/etc/passwd" } });
		strictEqual(decision.kind, "block");
		strictEqual(decision.policy?.reasonCode, "write-root");
	});

	it("blocks a ../ escape out of the root", () => {
		const decision = safety.evaluate({ tool: ToolNames.Edit, args: { file_path: join(root, "..", "escape.md") } });
		strictEqual(decision.kind, "block");
		strictEqual(decision.policy?.reasonCode, "write-root");
	});

	it("blocks a write into a sibling staging directory", () => {
		const sibling = join(scratch, ".clio-coder", "wiki-staging-other", "quickstart.md");
		const decision = safety.evaluate({ tool: ToolNames.Write, args: { file_path: sibling } });
		strictEqual(decision.kind, "block");
		strictEqual(decision.policy?.reasonCode, "write-root");
	});

	it("allows a write into a nested subdirectory of the root", () => {
		const decision = safety.evaluate({ tool: ToolNames.Write, args: { file_path: join(root, "sub", "quickstart.md") } });
		strictEqual(decision.kind, "allow");
	});

	it("allows a write to a page directly under the root", () => {
		const decision = safety.evaluate({ tool: ToolNames.Edit, args: { file_path: join(root, "quickstart.md") } });
		strictEqual(decision.kind, "allow");
	});

	it("does not gate read-class tools", () => {
		// A read that sits outside the write root is untouched by the containment.
		const decision = safety.evaluate({ tool: ToolNames.Read, args: { file_path: join(scratch, "README.md") } });
		strictEqual(decision.kind, "allow");
	});

	it("blocks an artifact write outside the root", () => {
		// artifact resolves its default .clio-coder/artifacts/ path against the
		// worker cwd, which is outside the staging root here.
		const decision = safety.evaluate({ tool: ToolNames.Artifact, args: { kind: "report" } });
		strictEqual(decision.kind, "block");
		strictEqual(decision.policy?.reasonCode, "write-root");
	});

	it("blocks execute-class tools that can write outside the root under confinement", () => {
		// verify runs project scripts that can write anywhere, so write-confinement
		// blocks it outright rather than trusting it to stay inside the root.
		const decision = safety.evaluate({ tool: ToolNames.Verify, args: { check: "build" } });
		strictEqual(decision.kind, "block");
		strictEqual(decision.policy?.reasonCode, "write-root");
		const bash = safety.evaluate({ tool: ToolNames.Bash, args: { command: "echo hi > out.txt" } });
		strictEqual(bash.kind, "block");
		strictEqual(bash.policy?.reasonCode, "write-root");
	});

	it("does not treat a sibling with a shared name prefix as inside the root", () => {
		// `${root}-evil` shares a string prefix with the root but is not beneath it.
		const decision = safety.evaluate({ tool: ToolNames.Write, args: { file_path: `${root}-evil/quickstart.md` } });
		strictEqual(decision.kind, "block");
		strictEqual(decision.policy?.reasonCode, "write-root");
	});

	it("imposes no containment when no writeRoots are configured", () => {
		const open = createWorkerSafety({ cwd: scratch });
		const decision = open.evaluate({ tool: ToolNames.Write, args: { file_path: join(root, "quickstart.md") } });
		strictEqual(decision.kind, "allow");
		// Without confinement, execute-class tools are not blocked by this rail.
		const verify = open.evaluate({ tool: ToolNames.Verify, args: { check: "build" } });
		strictEqual(verify.kind, "allow");
	});
});
