/**
 * CLI flags that used to be parsed and then dropped. Each case runs the real
 * entry (`src/cli/index.ts`) in a scratch home, so the contract is what an
 * operator typing the command sees: a flag the command cannot honor is refused
 * with exit 2 and a message naming it, and a dry run writes nothing.
 */
import { deepStrictEqual, doesNotMatch, equal, match, ok } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parseRunCliArgs } from "../../src/cli/args.js";
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

const ENTRY = fileURLToPath(new URL("../../src/cli/index.ts", import.meta.url));
const home = makeScratchHome("clio-coder-cli-flags-");
after(() => home.cleanup());

function cli(args: ReadonlyArray<string>): { status: number | null; stdout: string; stderr: string } {
	const result = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), ENTRY, ...args], {
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
		[["--no-panes", "acp"], "--no-panes", "acp"],
	] as const) {
		it(`refuses ${args.join(" ")} and names ${flag} and ${command}`, () => {
			const result = cli(args);
			equal(result.status, 2, result.stderr);
			ok(result.stderr.includes(flag), result.stderr);
			ok(result.stderr.includes(`clio-coder ${command}`), result.stderr);
			doesNotMatch(result.stderr, /k-123/u, "the refusal must not echo the key");
		});
	}

	it("never tells run to take a panes flag before the subcommand", () => {
		const parsed = parseRunCliArgs(["--with-panes", "hello"]);
		const message = parsed.diagnostics.map((entry) => entry.message).join(" ");
		match(message, /--with-panes applies only to the interactive session/u);
		doesNotMatch(message, /--with-panes run/u);
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
});

describe("run --agent", () => {
	it("refuses --json-events, which only the main-agent stream reads", () => {
		const parsed = parseRunCliArgs(["--agent", "scout", "--json-events", "terminal", "Inspect"]);
		match(parsed.diagnostics.map((entry) => entry.message).join(" "), /--json-events.*main agent/u);
		const mainAgent = parseRunCliArgs(["--json-events", "terminal", "Inspect"]);
		deepStrictEqual(mainAgent.diagnostics, []);
	});
});

describe("--with-panes", () => {
	it("activates guest detection even over the unimplemented embedded rung", () => {
		equal(resolvePanesEnablement("with", "embedded"), "auto");
		equal(resolvePanesEnablement("with", "off"), "auto");
		equal(resolvePanesEnablement("with", undefined), "auto");
		equal(resolvePanesEnablement("without", "embedded"), "off");
		equal(resolvePanesEnablement(undefined, "embedded"), "embedded");
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
