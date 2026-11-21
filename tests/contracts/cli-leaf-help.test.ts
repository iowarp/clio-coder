/**
 * Every leaf command answers `--help` the way the routers and most leaves do:
 * its usage on stdout, exit 0, and nothing executed. These leaves used to run
 * their strict argument loop first, so `--help` came back as an unknown flag
 * with exit 2, or as "--help needs a value" from `telemetry share`, whose
 * parser asked any unknown flag for a value before naming it as unknown.
 */
import { deepEqual, equal, match, ok } from "node:assert/strict";
import { spawn } from "node:child_process";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { makeScratchHome } from "../harness/scratch-env.js";

const ENTRY = fileURLToPath(new URL("../../src/cli/index.ts", import.meta.url));
const home = makeScratchHome("clio-coder-leaf-help-");
after(() => home.cleanup());

function cli(
	args: ReadonlyArray<string>,
	at: { dir: string; env: NodeJS.ProcessEnv } = home,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), ENTRY, ...args], {
			cwd: at.dir,
			env: { ...process.env, ...at.env, NO_COLOR: "1" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("close", (status) => resolve({ status, stdout, stderr }));
	});
}

// The arena, interop and research routers answer --help before naming the leaf, so one row each covers them.
const CASES: ReadonlyArray<{ args: string[]; usage: RegExp }> = [
	...["inspect", "calls", "cache", "timeline", "why-stopped", "explain"].map((leaf) => ({
		args: ["telemetry", leaf, "--help"],
		usage: new RegExp(`clio-coder telemetry ${leaf} `),
	})),
	{ args: ["telemetry", "cost", "some-session", "-h"], usage: /clio-coder telemetry cost / },
	...["insights", "consent", "share", "import", "prune", "doctor"].map((leaf) => ({
		args: ["telemetry", leaf, "--help"],
		usage: new RegExp(`clio-coder telemetry ${leaf} `),
	})),
	{ args: ["session", "list", "--help"], usage: /clio-coder session list / },
	{ args: ["session", "terminate", "some-session", "--help"], usage: /clio-coder session terminate / },
	{ args: ["interop", "adopt", "claude-code", "--yes", "--help"], usage: /clio-coder interop <subcommand>/ },
	{ args: ["verifiers", "inspect", "--help"], usage: /clio-coder verifiers inspect --json/ },
	{ args: ["version", "--help"], usage: /clio-coder version \[--worker-specs \| --build \| --json\]/ },
	{ args: ["arena", "run", "--help"], usage: /clio-coder arena run --contender / },
	{ args: ["research", "start", "--help"], usage: /clio-coder research start / },
	{ args: ["help", "--help"], usage: /clio-coder help --json / },
	{ args: ["schema", "--help"], usage: /clio-coder schema <name>/ },
	// The fleet leaves answer from src/cli/fleet-help.ts with their own usage, not the whole fleet help.
	...["admission", "wait", "cancel"].map((leaf) => ({
		args: ["fleet", leaf, "--help"],
		usage: new RegExp(`^clio-coder fleet ${leaf} [^\\n]*\\n\\n(?![\\s\\S]*Subcommands:)`, "u"),
	})),
];

describe("leaf commands answer --help", { concurrency: 4 }, () => {
	for (const { args, usage } of CASES) {
		it(`clio-coder ${args.join(" ")} prints its usage and exits 0`, async () => {
			const result = await cli(args);
			equal(result.stderr, "", `${args.join(" ")} wrote to stderr`);
			equal(result.status, 0, result.stdout);
			match(result.stdout, usage);
		});
	}
	it("clio-coder context --help lists every context init form that context init --help does", async () => {
		const [summary, init] = await Promise.all([cli(["context", "--help"]), cli(["context", "init", "--help"])]);
		equal(summary.status, 0, summary.stderr);
		equal(init.status, 0, init.stderr);
		const forms = init.stdout.split("\n").filter((line) => line.startsWith("  clio-coder context init "));
		match(forms.join("\n"), /--verify[\s\S]*--accept/);
		for (const form of forms) ok(summary.stdout.includes(`${form}\n`), `context --help omits: ${form.trim()}`);
	});
	it("clio-coder help --json is one compact manifest that names the nested leaves, and schema prints each schema", async () => {
		const manifest = await cli(["help", "--json"]);
		equal(manifest.status, 0, manifest.stderr);
		equal(manifest.stdout.trimEnd().split("\n").length, 1, "help --json printed more than one line");
		const doc = JSON.parse(manifest.stdout) as {
			version: number;
			leaves: Array<{
				path: string[];
				flags: Array<{ name: string; value: unknown; persistence?: string; conflicts?: string[] }>;
				positionals: Array<{ name: string; required: boolean; variadic: boolean }>;
			}>;
		};
		equal(doc.version, 1);
		const paths = new Set(doc.leaves.map((leaf) => leaf.path.join(" ")));
		for (const sentinel of [
			"targets profile bind",
			"context replay",
			"fleet nodes tools install",
			"telemetry share forget",
		])
			ok(paths.has(sentinel), `help --json omits ${sentinel}`);
		// SPEC 6.4 (R08): the credential flags that write to disk say so per flag.
		for (const [path, flag] of [
			["configure", "--api-key"],
			["configure", "--api-key-env"],
			["auth login", "--api-key"],
		] as const) {
			const row = doc.leaves.find((leaf) => leaf.path.join(" ") === path)?.flags.find((f) => f.name === flag);
			equal(row?.persistence, "persisted", `help --json: ${path} ${flag}`);
		}
		// CLI-P21: a value set after a flag in a synopsis is published as its choices, not as a boolean.
		const method = doc.leaves
			.find((leaf) => leaf.path.join(" ") === "auth login")
			?.flags.find((f) => f.name === "--method");
		deepEqual(method?.value, ["browser", "device"], "help --json: auth login --method");
		// c-r-help-enum: a parenthesized group's flags share the value after it and conflict with each other; a
		// positional in a top-level alternation is optional; a capitals metavariable with digits is a value.
		const leaf = (path: string) => doc.leaves.find((entry) => entry.path.join(" ") === path);
		const flagRows = (path: string) =>
			Object.fromEntries((leaf(path)?.flags ?? []).map((f) => [f.name, { value: f.value, conflicts: f.conflicts }]));
		const workingSet = flagRows("context working-set");
		deepEqual(workingSet["--session"], { value: ["id", "path"], conflicts: ["--verify"] });
		deepEqual(workingSet["--verify"], { value: ["id", "path"], conflicts: ["--session"] });
		deepEqual(leaf("context working-set")?.positionals, []);
		deepEqual(flagRows("context replay")["--sessions"], { value: "string", conflicts: ["--synthetic"] });
		deepEqual(leaf("telemetry cost")?.positionals, [{ name: "session", required: false, variadic: false }]);
		deepEqual(leaf("telemetry runs")?.positionals, [{ name: "session", required: false, variadic: false }]);
		equal(flagRows("config trust")["--hash"]?.value, "string");
		for (const name of ["run-result", "run-events", "task", "help", "fleet-result"]) {
			const schema = await cli(["schema", name]);
			equal(schema.status, 0, schema.stderr);
			match((JSON.parse(schema.stdout) as { $id: string }).$id, new RegExp(`^urn:clio-coder:schema:${name}:`));
		}
		equal((await cli(["schema", "nope"])).status, 1);
	});
});

describe("telemetry share names the flag it refuses", { concurrency: 2 }, () => {
	for (const [args, refusal] of [
		[["telemetry", "share", "--bogus"], /error: unknown flag: --bogus\n/],
		[["telemetry", "share", "--repo", "a", "--repo", "b"], /error: repeated flag --repo\n/],
	] as const) {
		it(`clio-coder ${args.join(" ")} exits 2 naming it`, async () => {
			const result = await cli(args);
			equal(result.status, 2, result.stderr);
			match(result.stderr, refusal);
		});
	}
});

describe("config and version refuse what they do not take", { concurrency: 2 }, () => {
	for (const [args, refusal] of [
		[["config", "--jsn"], /^clio-coder config inspect: unknown flag: --jsn\nsee: clio-coder config inspect --help\n/],
		[
			["config", "inspect", "extra"],
			/^clio-coder config inspect: unexpected argument: extra\nsee: clio-coder config inspect --help\n/,
		],
		[["version", "--bogus"], /^clio-coder version: unknown flag: --bogus\nsee: clio-coder version --help\n$/],
		[["config", "toString"], /^clio-coder config: unknown subcommand: toString\nsee: clio-coder config --help\n$/],
	] as const) {
		it(`clio-coder ${args.join(" ")} exits 2 naming it`, async () => {
			const result = await cli(args);
			equal(result.status, 2, result.stdout);
			equal(result.stdout, "");
			match(result.stderr, refusal);
		});
	}
});

// Lifecycle leaves (lane L9): one diagnostic and a see: line on stderr, and
// under --json one failure document on stdout with the slug a script branches on.
describe("lifecycle leaves refuse with one diagnostic and, under --json, one failure document", {
	concurrency: 2,
}, () => {
	for (const [args, slug] of [
		[["paths", "--bogus", "--json"], "unknown_flag"],
		[["version", "--json", "--build"], "flag_conflict"],
		[["reset", "--state", "--json"], "confirmation_required"],
		[["uninstall", "--json"], "confirmation_required"],
		[["doctor", "--yes", "--json"], "usage"],
		[["tools", "reset-profile", "--json"], "usage"],
		[["panes", "install", "--bogus", "--json"], "unknown_flag"],
		[["interop", "adopt", "--json"], "usage"],
	] as const) {
		it(`clio-coder ${args.join(" ")} exits 2 with ${slug}`, async () => {
			const result = await cli(args);
			equal(result.status, 2, result.stderr);
			const docs = result.stdout.trim().split("\n");
			equal(docs.length, 1, result.stdout);
			equal(JSON.parse(docs[0] as string).error.code, slug);
			match(result.stderr, /^clio-coder [a-z -]+: .+\n/);
		});
	}

	it("clio-coder version --json prints one version document", async () => {
		const result = await cli(["version", "--json"]);
		equal(result.status, 0, result.stderr);
		const doc = JSON.parse(result.stdout) as { version: number; clioVersion: string; workerSpecs: unknown[] };
		equal(doc.version, 1);
		ok(doc.clioVersion.length > 0);
		ok(Array.isArray(doc.workerSpecs));
	});

	it("clio-coder tools reset-profile names an unknown tool as not_found, exit 1", async () => {
		const result = await cli(["tools", "reset-profile", "nope", "--json"]);
		equal(result.status, 1, result.stderr);
		equal(JSON.parse(result.stdout).error.code, "not_found");
	});
});

// CLI SPEC L12: the root page, the full listing, and the spellings 0.8.5 removed.
describe("root help and removed spellings", { concurrency: 4 }, () => {
	it("root --help is at most 45 lines and names the core commands", async () => {
		const result = await cli(["--help"]);
		equal(result.status, 0, result.stderr);
		ok(result.stdout.trimEnd().split("\n").length <= 45, result.stdout);
		for (const name of ["run", "acp", "session", "fleet", "config", "help"]) {
			match(result.stdout, new RegExp(`^  clio-coder ${name}\\b`, "mu"), name);
		}
	});

	it("--help --all lists every command path and no removed spelling", async () => {
		const result = await cli(["--help", "--all"]);
		equal(result.status, 0, result.stderr);
		for (const path of [
			"clio-coder fleet list",
			"clio-coder fleet admission",
			"clio-coder fleet wait <fleetRootId> [--timeout <duration>] [--json]",
			"clio-coder session compact",
			"clio-coder help",
			"clio-coder schema",
			"clio-coder dev components",
		]) {
			ok(result.stdout.includes(path), path);
		}
		ok(!/clio-coder (fleet drain|fleet resume|targets add|ext |semantic inbox-)/u.test(result.stdout), result.stdout);
	});

	it("help run --topics prints the run prose that run --help no longer carries", async () => {
		const [topics, help] = await Promise.all([cli(["help", "run", "--topics"]), cli(["run", "--help"])]);
		equal(topics.status, 0, topics.stderr);
		match(topics.stdout, /^--cwd enters <dir>/u);
		ok(!help.stdout.includes("--cwd enters <dir>"), help.stdout);
		ok(help.stdout.includes("help run --topics"));
	});

	// No alias, tombstone or deprecation notice survives: each removed spelling is an ordinary usage error.
	for (const args of [
		["context-init"],
		["context-init", "--help"],
		["fleet", "inspect"],
		["fleet", "drain", "--json"],
		["evidence", "build"],
		["--acp", "--help"],
		["ext", "--help"],
		["export", "--help"],
		["evolve", "--help"],
		["dev", "share"],
		["targets", "workers"],
		["semantic", "inbox-list"],
	]) {
		it(`clio-coder ${args.join(" ")} is an ordinary usage error`, async () => {
			const result = await cli(args);
			equal(result.status, 2, result.stderr);
			match(result.stderr, /unknown/iu);
			ok(!/deprecated|was removed|\nuse: /u.test(result.stderr), result.stderr);
		});
	}
});
