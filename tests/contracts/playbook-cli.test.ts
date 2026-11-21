import { deepStrictEqual, match, strictEqual } from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { runPlaybookGraph } from "../../src/cli/playbook-graph.js";
import { runPlaybookValidate } from "../../src/cli/playbook-validate.js";
import { updateSettings } from "../../src/core/config.js";
import { captureProjectSurface, recordProjectSurfaceTrust } from "../../src/core/workspace-trust.js";
import { clioStateDir } from "../../src/core/xdg.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

const CLI_ENTRY = fileURLToPath(new URL("../../src/cli/index.ts", import.meta.url));

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
		strictEqual(bare.code, 2, bare.stdout + bare.stderr);
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

	it("resolves a .md name or a path in the project playbooks directory to the bare name, and refuses others", () => {
		const inside = join(root, ".clio-coder", "playbooks", "stage.md");
		for (const spelling of ["stage.md", ".clio-coder/playbooks/stage.md", inside]) {
			const result = captured(() => runPlaybookValidate([spelling, "--var", "fixture=r7", "--json"]));
			strictEqual(result.code, 0, `${spelling}: ${result.stdout}${result.stderr}`);
		}
		writeFileSync(join(root, "stage.md"), readFileSync(inside, "utf8"));
		for (const spelling of ["./stage.md", join(root, "stage.md"), ".clio-coder/playbooks/../../stage.md"]) {
			const refused = captured(() => runPlaybookValidate([spelling, "--var", "fixture=r7"]));
			strictEqual(refused.code, 2, `${spelling}: ${refused.stdout}${refused.stderr}`);
			match(refused.stderr, /playbook path refused: .* pass a playbook name \(hello for .*hello\.md\) or a builtin name/);
		}
		const missing = captured(() => runPlaybookValidate(["absent.md"]));
		strictEqual(missing.code, 2);
		match(missing.stderr, /playbook not found: .*absent\.md \(and no builtin named 'absent'\); pass a playbook name/);
	});

	it("exits 2 for a parse, schema, or unknown-dependency error in text and --json (SPEC L7a row 7)", () => {
		const path = join(root, ".clio-coder", "playbooks", "stage.md");
		const source = readFileSync(path, "utf8");
		const broken: ReadonlyArray<[string, RegExp]> = [
			["---\nversion: 3\nsteps: [ {kind: agent\n---\n", /invalid YAML/],
			[source.replace("scope: readonly", "scope: everywhere"), /stage\.md: \/steps\/0/],
			[source.replace("dependencies: []", "dependencies: [absent]"), /unknown dependency 'absent'/],
		];
		for (const [text, diagnostic] of broken) {
			writeFileSync(path, text);
			const plain = captured(() => runPlaybookValidate(["stage", "--var", "fixture=r7"]));
			strictEqual(plain.code, 2, plain.stdout + plain.stderr);
			match(plain.stderr, diagnostic);
			const json = captured(() => runPlaybookValidate(["stage", "--var", "fixture=r7", "--json"]));
			strictEqual(json.code, 2, json.stdout + json.stderr);
			match(json.stdout, /"valid": false/);
		}
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
				"    agent: coder",
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
		// SPEC L7a row 7: exit 2, as `fleet run routed` refuses it.
		strictEqual(untrusted.code, 2);
		// The preflight fleet run shares, so the diagnostic reads the same from both commands.
		match(untrusted.stderr, /preflight failed: unknown target 'project-route' at step 'build'/);
		recordProjectSurfaceTrust(root, "settings", captureProjectSurface(root, "settings").contentHash as string);
		const trusted = captured(() => runPlaybookValidate(["routed"]));
		strictEqual(trusted.code, 0, `${trusted.stdout}${trusted.stderr}`);
	});
	it("refuses shadow agents during playbook validation", () => {
		const path = join(root, ".clio-coder", "playbooks", "stage.md");
		const source = readFileSync(path, "utf8");
		for (const agent of ["scout", "oracle", "provenance", "researcher", "world-knowledge"]) {
			writeFileSync(
				path,
				source.replace(
					/ {2}- kind: code[\s\S]*? {4}dependencies: \[\]/,
					`  - kind: agent\n    id: stage\n    agent: ${agent}\n    scope: readonly\n    dependencies: []`,
				),
			);
			const result = captured(() => runPlaybookValidate(["stage", "--var", "fixture=r7", "--json"]));
			strictEqual(result.code, 2, result.stdout + result.stderr);
			match(result.stdout, /reserved for CLIO Coder internal orchestration/);
		}
	});

	it("refuses a shadow agent before fleet writes a run journal", async () => {
		const path = join(root, ".clio-coder", "playbooks", "stage.md");
		writeFileSync(
			path,
			readFileSync(path, "utf8").replace(
				/ {2}- kind: code[\s\S]*? {4}dependencies: \[\]/,
				"  - kind: agent\n    id: stage\n    agent: scout\n    scope: readonly\n    dependencies: []",
			),
		);
		process.env.HOME = env.dir;
		updateSettings((settings) => {
			settings.targets.push({
				id: "fixture",
				runtime: "openai-compat",
				url: "http://127.0.0.1:1/v1",
				defaultModel: "fixture",
			});
			settings.fleet.default.target = "fixture";
			settings.fleet.default.model = "fixture";
		});
		const { runFleetCommand } = await import("../../src/cli/fleet.js");
		strictEqual(await runFleetCommand(["run", "stage", "--var", "fixture=r7"]), 2);
		const runs = join(clioStateDir(), "fleet-runs");
		deepStrictEqual(existsSync(runs) ? readdirSync(runs) : [], []);
	});

	it("answers a fleet run a drained admission gate denied with a refused result, not a completed one", () => {
		writeFileSync(
			join(root, ".clio-coder", "playbooks", "one.md"),
			[
				"---",
				"version: 3",
				"name: one",
				'description: "One agent step."',
				"steps:",
				"  - kind: agent",
				"    id: one",
				"    agent: coder",
				"    scope: readonly",
				"    dependencies: []",
				"maxWorkers: 1",
				"onFailure: stop",
				"---",
				"",
				"Do one thing.",
				"",
			].join("\n"),
		);
		process.env.HOME = env.dir;
		updateSettings((settings) => {
			settings.targets.push({
				id: "fixture",
				runtime: "openai-compat",
				url: "http://127.0.0.1:1/v1",
				defaultModel: "fixture",
			});
			settings.fleet.default.target = "fixture";
			settings.fleet.default.model = "fixture";
		});
		const cli = (args: ReadonlyArray<string>) =>
			spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), CLI_ENTRY, ...args], {
				cwd: root,
				env: { ...process.env, NO_COLOR: "1" },
				encoding: "utf8",
			});
		const drain = cli(["fleet", "admission", "drain"]);
		strictEqual(drain.status, 0, drain.stderr);
		const run = cli(["fleet", "run", "one", "--output-format", "json"]);
		strictEqual(run.status, 2, run.stderr);
		const result = JSON.parse(run.stdout) as {
			exitCode: number;
			completion: unknown;
			causes: Array<{ code: string; message?: string }>;
		};
		strictEqual(result.exitCode, 2);
		deepStrictEqual(result.completion, { state: "refused", stopReason: null });
		strictEqual(result.causes[0]?.code, "not_started", run.stdout);
		match(result.causes[0]?.message ?? "", /capacity is draining/);
		// Streamed, the refused run answers with its fleet_end alone: it never announced a start it did not make.
		const streamed = cli(["fleet", "run", "one", "--output-format", "stream-json"]);
		strictEqual(streamed.status, 2, streamed.stderr);
		const events = streamed.stdout
			.split("\n")
			.filter((line) => line.trim().length > 0)
			.map((line) => (JSON.parse(line) as { type: string }).type);
		deepStrictEqual(events, ["fleet_end"], streamed.stdout);
	});
});
