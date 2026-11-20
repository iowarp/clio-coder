/**
 * CLI flags that used to be parsed and then dropped. Each case runs the real
 * entry (`dist/cli/index.js`) in a scratch home, so the contract is what an
 * operator typing the command sees: a flag the command cannot honor is refused
 * with exit 2 and a message naming it, and a dry run writes nothing.
 */
import { deepStrictEqual, doesNotMatch, equal, match, ok } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parseRunCliArgs } from "../../src/cli/args.js";
import { parseRunArgsWithTaskFile } from "../../src/cli/task-envelope.js";
import {
	snapshotTurnConstraints,
	turnAllowsTool,
	turnDelegatesTool,
	workerTurnConstraints,
} from "../../src/core/turn-constraints.js";
import { resolvePanesEnablement } from "../../src/entry/panes-activation.js";
import { type HeadlessScratch, headlessScratch, runCli } from "../harness/headless-run.js";
import {
	closeServer,
	type OpenAICompatFixture,
	seedOpenAICompatFleetDefault,
	seedOpenAICompatOrchestrator,
	startOpenAICompatFixture,
} from "../harness/openai-compat-fixture.js";
import { makeScratchHome } from "../harness/scratch-env.js";

const ENTRY = fileURLToPath(new URL("../../dist/cli/index.js", import.meta.url));
const home = makeScratchHome("clio-coder-cli-flags-");
after(() => home.cleanup());

function cli(args: ReadonlyArray<string>): { status: number | null; stdout: string; stderr: string } {
	const result = spawnSync(process.execPath, [ENTRY, ...args], {
		cwd: home.dir,
		env: { ...process.env, ...home.env, NO_COLOR: "1" },
		encoding: "utf8",
		timeout: 60_000,
	});
	return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("global startup flags before a subcommand", () => {
	for (const [args, flag, command] of [
		[["--no-skills", "paths"], "--no-skills", "paths"],
		[["--api-key", "k-123", "doctor"], "--api-key", "doctor"],
		[["-nc", "fleet", "status"], "-nc", "fleet"],
		[["--skill", "skill-dir", "share", "inspect", "x.json"], "--skill", "share"],
		[["--no-skills", "dev", "share", "inspect", "x.json"], "--no-skills", "share"],
		[["--with-panes", "run", "hello"], "--with-panes", "run"],
		[["--with-panes", "acp"], "--with-panes", "acp"],
	] as const) {
		it(`refuses ${args.join(" ")} and names ${flag} and ${command}`, () => {
			const result = cli(args);
			equal(result.status, 2, result.stderr);
			ok(result.stderr.includes(flag), result.stderr);
			ok(result.stderr.includes(`clio-coder ${command}`), result.stderr);
			doesNotMatch(result.stderr, /k-123/u, "the refusal must not echo the key");
		});
	}

	it("refuses --resume or --continue before a subcommand, and the two together, with exit 2", () => {
		for (const [args, refusal] of [
			[["--resume", "abc", "paths"], /--resume and --continue apply to the interactive session only/u],
			[["-c", "run", "hello"], /clio-coder run --continue/u],
			[["--resume", "abc", "--continue"], /--resume and --continue cannot be combined/u],
		] as const) {
			const result = cli(args);
			equal(result.status, 2, `${args.join(" ")}: ${result.stderr}`);
			match(result.stderr, refusal);
		}
	});

	it("run --resume takes the session, --session is a deprecated alias, and --fork needs a session (SPEC L3)", () => {
		const resume = parseRunCliArgs(["--resume", "abc", "--fork", "--name", " beta ", "hello"]);
		deepStrictEqual(
			[resume.sessionId, resume.forkSession, resume.sessionName, resume.diagnostics],
			["abc", true, "beta", []],
		);
		const alias = parseRunCliArgs(["--session", "abc", "hello"]);
		equal(alias.sessionId, "abc");
		deepStrictEqual(
			alias.diagnostics.map((entry) => entry.type),
			["warning"],
		);
		match(alias.diagnostics[0]?.message ?? "", /--session is deprecated; use --resume/u);
		for (const args of [
			["--fork", "hello"],
			["--resume", "abc", "--continue", "hello"],
			["--name", "", "hello"],
			["--resume", "abc", "--agent", "coder", "hello"],
		]) {
			const parsed = parseRunCliArgs(args);
			ok(
				parsed.diagnostics.some((entry) => entry.type === "error"),
				`${args.join(" ")}: ${JSON.stringify(parsed.diagnostics)}`,
			);
		}
	});

	it("names an unknown run option without repeating the command the caller prefixes", () => {
		const parsed = parseRunCliArgs(["--bogus", "hello"]);
		const message = parsed.diagnostics.map((entry) => entry.message).join(" ");
		equal(message, "unknown option: --bogus");
	});

	it("never tells run to take a panes flag before the subcommand", () => {
		const parsed = parseRunCliArgs(["--with-panes", "hello"]);
		const message = parsed.diagnostics.map((entry) => entry.message).join(" ");
		match(message, /--with-panes applies only to the interactive session/u);
		doesNotMatch(message, /--with-panes run/u);
	});

	it("reads -v and --version as the version only before the subcommand", () => {
		for (const args of [["-v"], ["--version", "paths"]]) {
			const result = cli(args);
			equal(result.status, 0, result.stderr);
			match(result.stdout, /^CLIO Coder /u);
		}
		for (const [args, refusal] of [
			[["paths", "-v"], /unknown flag: -v/u],
			[["paths", "--bogus", "--version"], /unknown flag: --bogus/u],
			[["run", "-v"], /clio-coder run: unknown option: -v/u],
		] as const) {
			const result = cli(args);
			equal(result.status, 2, `${args.join(" ")}: ${result.stdout}`);
			doesNotMatch(result.stdout, /CLIO Coder /u);
			match(result.stderr, refusal);
		}
		// After "--" a -v is the task text: neither the version nor a refused option.
		const task = cli(["run", "--", "-v"]);
		doesNotMatch(task.stdout, /^CLIO Coder /u);
		doesNotMatch(task.stderr, /unknown option/u);
	});

	it("still hands the boot options run honors to run", () => {
		const result = cli(["--no-context-files", "--no-skills", "run", "--help"]);
		equal(result.status, 0, result.stderr);
	});
});

describe("share", () => {
	it("export --dry-run reports the archive and writes nothing", () => {
		const out = join(home.dir, "dry.clio-coder-share.json");
		const result = cli(["share", "export", "--out", out, "--dry-run"]);
		equal(result.status, 0, result.stderr);
		equal(existsSync(out), false, "a dry run must never write the archive");
		match(result.stdout, /would write \d+ item\(s\) to /u);
		const json = cli(["share", "export", "--out", out, "--dry-run", "--json"]);
		equal(json.status, 0, json.stderr);
		equal(existsSync(out), false);
		const parsed = JSON.parse(json.stdout) as { dryRun?: unknown; out?: unknown; manifest?: { files?: unknown } };
		equal(parsed.dryRun, true);
		equal(parsed.out, out);
		ok(Array.isArray(parsed.manifest?.files));
	});

	for (const [args, flag] of [
		[["share", "export", "--out", "x.json", "--force"], "--force"],
		[["export", "--out", "x.json", "-f"], "-f"],
		[["share", "import", "x.json", "--both"], "--both"],
		[["share", "import", "x.json", "--prompts"], "--prompts"],
		[["share", "inspect", "x.json", "--force"], "--force"],
		[["share", "inspect", "x.json", "--dry-run"], "--dry-run"],
	] as const) {
		it(`refuses ${args.join(" ")} instead of ignoring ${flag}`, () => {
			const result = cli(args);
			equal(result.status, 2, result.stderr);
			ok(result.stderr.includes(flag), result.stderr);
			equal(existsSync(join(home.dir, "x.json")), false);
		});
	}
});

describe("fleet run", () => {
	it("refuses an unknown flag instead of running the contract", () => {
		const result = cli(["fleet", "run", "no-such-fleet", "--dry-run"]);
		equal(result.status, 2, result.stderr);
		match(result.stderr, /unknown fleet run option: --dry-run/u);
	});

	it("never takes an option value for the contract name", () => {
		mkdirSync(join(home.dir, ".clio-coder"), { recursive: true });
		const result = cli(["fleet", "run", "--resume", "run-abc", "no-such-fleet"]);
		equal(result.status, 2, result.stderr);
		match(result.stderr, /no-such-fleet/u);
		doesNotMatch(result.stderr, /run-abc\.md|named 'run-abc'/u);
	});

	it("answers a structured run it refused with one fleet_end document and refuses a bad output format", () => {
		const refused = cli(["fleet", "run", "no-such-fleet", "--output-format", "stream-json"]);
		equal(refused.status, 2, refused.stderr);
		const lines = refused.stdout.trim().split("\n");
		equal(lines.length, 1, refused.stdout);
		const end = JSON.parse(lines[0] ?? "") as { type: string; exitCode: number; completion: { state: string } };
		deepStrictEqual([end.type, end.exitCode, end.completion.state], ["fleet_end", 2, "refused"]);
		const format = cli(["fleet", "run", "no-such-fleet", "--output-format", "xml"]);
		equal(format.status, 2, format.stderr);
		equal(format.stdout, "");
		equal(cli(["fleet", "list", "--limit", "0"]).status, 2);
		equal(cli(["fleet", "admission", "bogus"]).status, 2);
		const verify = cli(["fleet", "verify", "no-such-run", "--json", "--exit-code"]);
		equal(verify.status, 1, verify.stderr);
		equal(JSON.parse(verify.stdout).error.code, "not_found");
	});
});

describe("run --json and --json-events (removed in 0.8.5)", () => {
	it("refuses every spelling as unknown_flag naming --output-format, beside any other flag", () => {
		for (const [argv, flag] of [
			[["--json", "Inspect"], "--json"],
			[["--json-events", "full", "Inspect"], "--json-events"],
			[["--json-events", "terminal", "Inspect"], "--json-events"],
			[["--json-events=terminal", "Inspect"], "--json-events"],
			[["--agent", "scout", "--json", "Inspect"], "--json"],
			[["--output-format", "json", "--json", "Inspect"], "--json"],
		] as const) {
			const parsed = parseRunCliArgs(argv);
			const errors = parsed.diagnostics.filter((entry) => entry.type === "error");
			deepStrictEqual(
				errors.map((entry) => [entry.slug, entry.message]),
				[["unknown_flag", `unknown option: ${flag} (removed in 0.8.5; use --output-format json|stream-json)`]],
				argv.join(" "),
			);
			deepStrictEqual(parsed.messages, ["Inspect"], argv.join(" "));
		}
	});
});

describe("run --delegate-tools", () => {
	it("parses a delegation ceiling separate from the parent's own tools", () => {
		const parsed = parseRunCliArgs([
			"--allow-tools",
			"dispatch,monitor,read",
			"--delegate-tools",
			"read,write,edit",
			"task",
		]);
		deepStrictEqual(parsed.diagnostics, []);
		const constraints = snapshotTurnConstraints(parsed.constraints);
		if (constraints === undefined) throw new Error("expected turn constraints");
		deepStrictEqual(constraints.allowedTools, ["dispatch", "monitor", "read"]);
		deepStrictEqual(constraints.delegatedTools, ["edit", "read", "write"]);
		equal(turnDelegatesTool(constraints, "write"), true);
		equal(turnAllowsTool(constraints, "write"), false);
		const worker = workerTurnConstraints(constraints);
		deepStrictEqual(worker.allowedTools, ["edit", "read", "write"]);
		equal("delegatedTools" in worker, false);
	});
});

describe("run --max-context-tokens", () => {
	it("accepts the = form exactly like the space form", () => {
		const inline = parseRunCliArgs(["--max-context-tokens=8192", "task"]);
		deepStrictEqual(inline.diagnostics, []);
		equal(inline.maxContextTokens, 8192);
		deepStrictEqual(inline.messages, ["task"]);
		deepStrictEqual(parseRunCliArgs(["--max-context-tokens=0", "task"]).diagnostics, [
			{ type: "error", message: "--max-context-tokens must be a positive integer" },
		]);
	});
});

describe("--with-panes", () => {
	it("activates guest detection; without it, panes follow whether Clio runs in a pane host", () => {
		equal(resolvePanesEnablement("with", {}), "auto");
		// Hosting is the launcher's job, so a boot reaching here is a guest inside
		// a pane host and a plain session outside one.
		equal(resolvePanesEnablement(undefined, { HERDR_ENV: "1" }), "auto");
		equal(resolvePanesEnablement(undefined, {}), "off");
	});

	it("no longer accepts --no-panes", () => {
		const result = cli(["--no-panes", "doctor"]);
		equal(result.status, 2, result.stderr);
		ok(result.stderr.includes("--no-panes"), result.stderr);
	});
});

describe("run --agent sampling flags", () => {
	const fixtures: OpenAICompatFixture[] = [];
	const scratches: HeadlessScratch[] = [];
	afterEach(async () => {
		await Promise.all(fixtures.splice(0).map((fixture) => closeServer(fixture.server)));
		for (const scratch of scratches.splice(0)) scratch.cleanup();
	});

	it("reach the dispatched worker's model request", async () => {
		const scratch = headlessScratch("clio-coder-agent-sampling-");
		scratches.push(scratch);
		const fixture = await startOpenAICompatFixture("done");
		fixtures.push(fixture);
		seedOpenAICompatOrchestrator(scratch.configDir, fixture.url);
		seedOpenAICompatFleetDefault(scratch.configDir);
		const turn = await runCli(
			[
				"--no-context-files",
				"--no-skills",
				"run",
				"--agent",
				"coder",
				"--temperature",
				"0.25",
				"--top-p",
				"0.5",
				"--frequency-penalty",
				"0.125",
				"Report done.",
			],
			{ env: scratch.env, cwd: scratch.root, timeoutMs: 60_000 },
		);
		// The fixture's plain reply does not satisfy the coder result contract, so
		// the worker's own exit is not the point; what its requests carried is.
		ok(turn.code === 0 || turn.code === 1, `unexpected exit ${turn.code}: ${turn.stderr}`);
		const streamed = fixture.requests.filter((request) => request.stream !== false);
		ok(streamed.length > 0, `the worker never reached the model: ${turn.stderr}`);
		for (const request of streamed) {
			equal(request.temperature, 0.25);
			equal(request.top_p, 0.5);
			equal(request.frequency_penalty, 0.125);
		}
	});
});

describe("fleet detach and wait flags (SPEC L7b)", () => {
	for (const [args, needle] of [
		[["fleet", "run", "demo", "--detach", "--json"], "--detach"],
		[["fleet", "run", "demo", "--detached-root", "not a root"], "--detached-root"],
		[["fleet", "wait", "fleet-abc", "--bogus"], "--bogus"],
		[["fleet", "wait"], "fleet wait"],
	] as const) {
		it(`refuses ${args.join(" ")} with exit 2`, () => {
			const result = cli(args);
			equal(result.status, 2, result.stderr);
			ok(result.stderr.includes(needle), result.stderr);
		});
	}

	it("fleet wait on an unknown root exits 1 not_found", () => {
		const result = cli(["fleet", "wait", "fleet-nosuchroot", "--json"]);
		equal(result.status, 1, result.stderr);
		match(result.stderr, /no fleet root matches/u);
	});

	it("fleet_end and fleet wait carry the plan hash and resolved playbook name the journal and fleet list record", {
		timeout: 120_000,
	}, async () => {
		const scratch = headlessScratch("clio-coder-fleet-plan-hash-");
		const fixture = await startOpenAICompatFixture("done");
		try {
			seedOpenAICompatOrchestrator(scratch.configDir, fixture.url);
			seedOpenAICompatFleetDefault(scratch.configDir);
			// An endpoint bound is what route preflight binds into the plan, and so into its hash.
			const settingsPath = join(scratch.configDir, "settings.yaml");
			writeFileSync(
				settingsPath,
				readFileSync(settingsPath, "utf8").replace(
					/^ {4}runtime: openai-compat$/m,
					"    runtime: openai-compat\n    maxConcurrentRequests: 2",
				),
			);
			const project = join(scratch.root, "project");
			mkdirSync(join(project, ".clio-coder", "playbooks"), { recursive: true });
			writeFileSync(
				join(project, ".clio-coder", "playbooks", "probe.md"),
				[
					"---",
					"version: 3",
					"name: probe",
					'description: "One read-only step."',
					"steps:",
					"  - kind: agent",
					"    id: look",
					"    agent: coder",
					"    scope: readonly",
					"    dependencies: []",
					"maxWorkers: 1",
					"onFailure: stop",
					"---",
					"",
					"Report done.",
					"",
				].join("\n"),
			);
			const options = { env: scratch.env, cwd: project, timeoutMs: 90_000 };
			// A .md spelling resolves to the bare playbook, and every surface names it as resolved.
			const run = await runCli(["fleet", "run", "probe.md", "--output-format", "stream-json"], options);
			const lines = run.stdout.trim().split("\n");
			const streamed = JSON.parse(lines[0] ?? "{}");
			const end = JSON.parse(lines.at(-1) ?? "{}");
			equal(end.type, "fleet_end", run.stderr);
			equal(streamed.type, "fleet_started", run.stdout);
			const list = JSON.parse((await runCli(["fleet", "list", "--json"], options)).stdout);
			const listed = list.roots.find((root: { rootId: string }) => root.rootId === end.rootId);
			const eventsRun = await runCli(["fleet", "events", end.rootId, "--json"], options);
			equal(eventsRun.code, 0, `${eventsRun.stderr} ${JSON.stringify(end)}`);
			const events = eventsRun.stdout;
			const started = events
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line))
				.find((line) => line.type === "fleet_started");
			const waited = JSON.parse((await runCli(["fleet", "wait", end.rootId, "--json"], options)).stdout);
			ok(typeof end.planHash === "string" && end.planHash.length > 0, run.stdout);
			deepStrictEqual([listed?.planHash, started?.planHash, waited.planHash], [end.planHash, end.planHash, end.planHash]);
			deepStrictEqual(
				[streamed.playbook, end.playbook, listed?.playbook, started?.fleet, waited.playbook],
				["probe", "probe", "probe", "probe", "probe"],
			);
		} finally {
			await closeServer(fixture.server);
			scratch.cleanup();
		}
	});
});

describe("run --task-file envelope (SPEC 6.3)", () => {
	const envelope = (name: string, body: unknown): string => {
		const file = join(home.dir, `${name}.task.json`);
		writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body));
		return file;
	};
	const refusal = async (args: string[]): Promise<{ slug: string | undefined; message: string }> => {
		const parsed = await parseRunArgsWithTaskFile(args);
		const error = parsed.diagnostics.find((diagnostic) => diagnostic.type === "error");
		return { slug: error?.slug, message: error?.message ?? "" };
	};

	it("merges the envelope's task and flags into the run arguments", async () => {
		const file = envelope("ok", { schemaVersion: 1, task: "say hi", route: { model: "m1" } });
		const parsed = await parseRunArgsWithTaskFile(["--task-file", file]);
		equal(parsed.diagnostics.filter((diagnostic) => diagnostic.type === "error").length, 0);
		deepStrictEqual(parsed.messages, ["say hi"]);
		equal(parsed.model, "m1");
	});

	it("refuses a key given in the file and on the command line, naming the dotted path", async () => {
		const file = envelope("conflict", { schemaVersion: 1, task: "say hi", route: { model: "m1" } });
		const { slug, message } = await refusal(["--model", "m2", "--task-file", file]);
		equal(slug, "task_flag_conflict");
		match(message, /route\.model/);
	});

	it("refuses an unknown key and malformed JSON as usage, and a schemaVersion other than 1 as schema_unsupported", async () => {
		const unknown = await refusal([
			"--task-file",
			envelope("unknown", { schemaVersion: 1, task: "x", route: { bogus: 1 } }),
		]);
		equal(unknown.slug, "usage");
		match(unknown.message, /route\.bogus/);
		equal((await refusal(["--task-file", envelope("bad", "{")])).slug, "usage");
		// SPEC 6.6: the envelope names the version it cannot read at the source.
		equal((await refusal(["--task-file", envelope("v2", { schemaVersion: 2, task: "x" })])).slug, "schema_unsupported");
		equal((await refusal(["--task-file", envelope("nov", { task: "x" })])).slug, "schema_unsupported");
	});

	it("refuses argv text, @file and - beside --task-file", async () => {
		const file = envelope("ok2", { schemaVersion: 1, task: "x" });
		for (const extra of [["text"], [`@${file}`], ["-"]])
			equal((await refusal(["--task-file", file, ...extra])).slug, "task_file_conflict");
	});

	it("refuses verify without --trust-task-file and accepts it with the flag", async () => {
		const file = envelope("verify", { schemaVersion: 1, task: "x", verify: [{ command: "true" }] });
		equal((await refusal(["--task-file", file])).slug, "task_authority");
		const trusted = await parseRunArgsWithTaskFile(["--trust-task-file", "--task-file", file]);
		equal(trusted.diagnostics.filter((diagnostic) => diagnostic.type === "error").length, 0);
	});

	it("hands an inline output schema to the run as an object", async () => {
		const file = envelope("schema", { schemaVersion: 1, task: "x", output: { schema: { type: "array" } } });
		const parsed = await parseRunArgsWithTaskFile(["--task-file", file]);
		equal(typeof parsed.outputSchema, "object");
	});
});

describe("run stdin (SPEC 6.2)", () => {
	it("reads stdin only with -: a pipe with no task and no - is empty_task naming -", () => {
		const result = spawnSync(process.execPath, [ENTRY, "run", "--output-format", "json"], {
			cwd: home.dir,
			env: { ...process.env, ...home.env, NO_COLOR: "1" },
			encoding: "utf8",
			input: "B",
			timeout: 60_000,
		});
		equal(result.status, 2, result.stderr);
		const cause = JSON.parse(result.stdout).causes[0];
		equal(cause.code, "empty_task");
		match(cause.message, / - /u);
		doesNotMatch(result.stderr, /deprecated/u);
	});
});
