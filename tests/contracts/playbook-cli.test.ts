import { match, strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { runPlaybookGraph } from "../../src/cli/playbook-graph.js";
import { runPlaybookValidate } from "../../src/cli/playbook-validate.js";
import { captureProjectSurface, recordProjectSurfaceTrust } from "../../src/core/workspace-trust.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

/** Run a synchronous CLI entry with its output captured. */
function captured(run: () => number): { code: number; stdout: string; stderr: string } {
	const out = process.stdout.write.bind(process.stdout);
	const err = process.stderr.write.bind(process.stderr);
	let stdout = "";
	let stderr = "";
	process.stdout.write = ((chunk: string | Uint8Array) => {
		stdout += String(chunk);
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = ((chunk: string | Uint8Array) => {
		stderr += String(chunk);
		return true;
	}) as typeof process.stderr.write;
	try {
		return { code: run(), stdout, stderr };
	} finally {
		process.stdout.write = out;
		process.stderr.write = err;
	}
}

describe("playbook CLI variables", () => {
	let env: IsolatedClioEnv;
	let root: string;
	let previous: string;
	beforeEach(async () => {
		env = await isolateClioEnv("clio-coder-playbook-cli-");
		root = realpathSync(mkdtempSync(join(tmpdir(), "clio-coder-playbook-cli-")));
		mkdirSync(join(root, ".clio-coder", "playbooks"), { recursive: true });
		writeFileSync(
			join(root, ".clio-coder", "playbooks", "stage.md"),
			[
				"---",
				"version: 3",
				"name: stage",
				'description: "Stage one named fixture."',
				"steps:",
				"  - kind: code",
				"    id: stage",
				"    command: stage",
				'    args: ["{{fixture}}"]',
				"    scope: readonly",
				"    dependencies: []",
				"maxWorkers: 1",
				"onFailure: stop",
				"---",
				"",
				"Stage {{fixture}}.",
				"",
			].join("\n"),
		);
		writeFileSync(
			join(root, ".clio-coder", "playbooks", "commands.yaml"),
			[
				"version: 1",
				"commands:",
				"  stage:",
				"    argv: [node, -e, '0']",
				"    argumentSlots: [{name: fixture, maxLength: 64}]",
				"",
			].join("\n"),
		);
		previous = process.cwd();
		process.chdir(root);
	});
	afterEach(() => {
		process.chdir(previous);
		rmSync(root, { recursive: true, force: true });
		env.restore();
	});

	it("validates and graphs a code step's variable argument from --var", () => {
		const bare = captured(() => runPlaybookValidate(["stage"]));
		strictEqual(bare.code, 1, bare.stdout + bare.stderr);
		match(bare.stderr, /missing variable fixture/);
		const valid = captured(() => runPlaybookValidate(["stage", "--var", "fixture=r7", "--json"]));
		strictEqual(valid.code, 0, valid.stdout + valid.stderr);
		match(valid.stdout, /"valid": true/);
		const graph = captured(() => runPlaybookGraph(["--var", "fixture=r7", "stage", "--json"]));
		strictEqual(graph.code, 0, graph.stdout + graph.stderr);
		match(graph.stdout, /"command": "stage"/);
		const malformed = captured(() => runPlaybookValidate(["stage", "--var", "fixture"]));
		strictEqual(malformed.code, 2);
		match(malformed.stderr, /--var requires key=value/);
	});

	it("preflights a route from the trusted project settings layer fleet run reads", () => {
		writeFileSync(
			join(root, ".clio-coder", "playbooks", "routed.md"),
			[
				"---",
				"version: 5",
				"name: routed",
				'description: "One routed agent step."',
				"steps:",
				"  - kind: agent",
				"    id: build",
				"    agent: scout",
				"    target: project-route",
				"    scope: readonly",
				"    dependencies: []",
				"maxWorkers: 1",
				"onFailure: stop",
				"---",
				"",
				"Build it.",
				"",
			].join("\n"),
		);
		writeFileSync(
			join(root, ".clio-coder", "settings.local.yaml"),
			"version: 2\ntargets:\n  - id: project-route\n    runtime: openai-compat\n    url: http://127.0.0.1:1/v1\n    defaultModel: fixture\n",
		);
		// Version 5 enforces write boundaries, which compare a git checkout.
		execFileSync("git", ["init", "-q"], { cwd: root });
		const untrusted = captured(() => runPlaybookValidate(["routed"]));
		strictEqual(untrusted.code, 1);
		match(untrusted.stderr, /unknown target 'project-route'/);
		recordProjectSurfaceTrust(root, "settings", captureProjectSurface(root, "settings").contentHash as string);
		const trusted = captured(() => runPlaybookValidate(["routed"]));
		strictEqual(trusted.code, 0, `${trusted.stdout}${trusted.stderr}`);
	});
});
