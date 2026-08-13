import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { parse as parseYaml } from "yaml";
import { validateSettings } from "../../src/core/config.js";
import { createRuntimeRegistry } from "../../src/domains/providers/registry.js";
import { registerBuiltinRuntimes } from "../../src/domains/providers/runtimes/builtins.js";
import {
	buildProviderSupportEntry,
	defaultModelForRuntime,
	describeRuntimeModels,
} from "../../src/domains/providers/support.js";
import { makeScratchHome, runCli } from "../harness/spawn.js";

// BUG-007: a partial non-interactive `configure` invocation (only --id, or only
// --runtime) used to fall into the wizard, read EOF from non-interactive stdin,
// write the default settings template, and exit 0 without configuring anything.
// With no TTY it must instead fail with exit 2 and name the missing half.

describe("contracts/configure-cli non-interactive gating", () => {
	it("rejects removed settings keys through strict current-schema validation", () => {
		const validation = validateSettings(
			parseYaml("version: 1\nsafetyLevel: auto-edit\nendpoints: []\nstate: {}\ntargets: []\n"),
		);
		const issuePaths = validation.issues.map((issue) => issue.path);
		for (const path of ["safetyLevel", "endpoints", "state"]) {
			ok(issuePaths.includes(path), `expected strict validation issue for ${path}`);
		}
	});

	const scratch = makeScratchHome("clio-configure-cli-");
	after(() => scratch.cleanup());

	const partialCases: ReadonlyArray<ReadonlyArray<string>> = [
		["configure", "--id", "local"],
		["configure", "--runtime", "llamacpp"],
	];

	for (const args of partialCases) {
		it(`clio ${args.join(" ")} rejects the incomplete non-interactive invocation`, async () => {
			const result = await runCli(args, { env: scratch.env, input: "" });
			strictEqual(result.code, 2, `stderr=${result.stderr}`);
			strictEqual(result.stdout, "", `unexpected stdout: ${result.stdout}`);
			match(result.stderr, /--runtime is required|--id is required|usage/i);
		});
	}

	// A complete non-interactive invocation still succeeds without a TTY.
	it("clio configure with --id and --runtime and a target flag succeeds", async () => {
		const result = await runCli(
			[
				"configure",
				"--id",
				"local",
				"--runtime",
				"llamacpp",
				"--url",
				"http://127.0.0.1:1",
				"--model",
				"local-model",
				"--set-orchestrator",
				"--force",
			],
			{ env: scratch.env, input: "" },
		);
		strictEqual(result.code, 0, `stderr=${result.stderr}`);
	});
});

/**
 * `clio configure --list` and `clio auth list` render the same runtime registry
 * through two predicates: everything registered, and the subset whose
 * credential Clio owns. Both screens read as "the runtimes you can connect", so
 * the eight rows only one of them showed looked like a disagreement about what
 * exists. The subset is correct and stays; what each screen owes the reader is
 * the name of the other one.
 */
describe("contracts/configure-cli runtime inventories agree", () => {
	const scratch = makeScratchHome("clio-runtime-lists-");
	after(() => scratch.cleanup());

	/** Runtime ids in listing order, from either table's `<id> ... targets=N` rows. */
	function listedIds(stdout: string): string[] {
		return stdout
			.split("\n")
			.map((line) => /^ {2}(\S+)\s+.*targets=\d+\s*$/.exec(line)?.[1])
			.filter((id): id is string => id !== undefined);
	}

	/** The auth column `configure --list` prints for each runtime id. */
	function authByRuntime(stdout: string): Map<string, string> {
		const rows = new Map<string, string>();
		for (const line of stdout.split("\n")) {
			const match = /^ {2}(\S+)\s+(\S+)\s+targets=\d+\s*$/.exec(line);
			if (match?.[1] !== undefined && match[2] !== undefined) rows.set(match[1], match[2]);
		}
		return rows;
	}

	it("the connectable list is an ordered subset of the full list, and each names the other", async () => {
		const full = await runCli(["configure", "--list"], { env: scratch.env });
		const connectable = await runCli(["auth", "list"], { env: scratch.env });
		strictEqual(full.code, 0, `stderr=${full.stderr}`);
		strictEqual(connectable.code, 0, `stderr=${connectable.stderr}`);

		const fullIds = listedIds(full.stdout);
		const connectableIds = listedIds(connectable.stdout);
		ok(fullIds.length > connectableIds.length, "the full list must be the wider of the two");

		// Subset: nothing is offered for login that configure does not admit exists.
		for (const id of connectableIds) ok(fullIds.includes(id), `${id} is missing from configure --list`);

		// Same order: the report read the omissions as a reordering. Both screens
		// sort with compareProviderSupportEntries, so one is a subsequence of the other.
		const positions = connectableIds.map((id) => fullIds.indexOf(id));
		deepStrictEqual(
			[...positions].sort((a, b) => a - b),
			positions,
			"auth list must keep configure --list's order",
		);

		// Every omission is a runtime that authenticates somewhere Clio is not.
		const auth = authByRuntime(full.stdout);
		const omitted = fullIds.filter((id) => !connectableIds.includes(id));
		ok(omitted.length > 0, "this contract is vacuous if nothing is omitted");
		for (const id of omitted) {
			ok(
				["claude-cli", "aws-sdk", "none"].includes(auth.get(id) ?? ""),
				`${id} is omitted from auth list but configure calls its auth '${auth.get(id)}'`,
			);
		}

		// Each screen says which set it is and where the rest are.
		match(connectable.stdout, /runtimes clio authenticates itself/);
		match(connectable.stdout, /clio configure --list/);
		match(full.stdout, /every registered runtime/);
		match(full.stdout, /clio auth list/);
	});

	// Where a name copied off the wider list lands if the caption did not stop
	// the user first. Refusing is right; refusing without a next step is what
	// made the two screens feel like a contradiction.
	for (const [runtimeId, authKind] of [
		["claude-code", "claude-cli"],
		["bedrock", "aws-sdk"],
	] as const) {
		it(`clio auth login ${runtimeId} names where that runtime authenticates instead`, async () => {
			const result = await runCli(["auth", "login", runtimeId], { env: scratch.env, input: "" });
			strictEqual(result.code, 1, `stdout=${result.stdout}`);
			match(result.stderr, new RegExp(`runtime ${runtimeId} does not support interactive auth login`));
			match(result.stderr, new RegExp(`authenticates as '${authKind}'`));
			match(result.stderr, new RegExp(`clio auth status ${runtimeId}`));
			match(result.stderr, /clio configure --list/);
		});
	}
});

/**
 * The pi-ai provider catalogs are keyed in name order. `--list` printed the
 * first two ids of that order as though they were the models to use, which for
 * openai is `gpt-4, gpt-4-turbo` out of 38 current ids, and `configure` with no
 * --model persisted the same head as the target's defaultModel. Nothing in the
 * dependency's model records supports a recency ranking, so the fix is to stop
 * asserting one: report the size and the source, and require the operator to
 * name the model.
 */
describe("contracts/configure-cli catalog-ordered model ids", () => {
	const scratch = makeScratchHome("clio-catalog-models-");
	after(() => scratch.cleanup());

	function registry(): ReturnType<typeof createRuntimeRegistry> {
		const created = createRuntimeRegistry();
		registerBuiltinRuntimes(created);
		return created;
	}

	it("offers no default model for a catalog-ordered runtime and keeps one for a repo-owned list", () => {
		const runtimes = registry().list();
		const openai = runtimes.find((runtime) => runtime.id === "openai");
		ok(openai, "openai runtime must be registered");
		if (!openai) return;
		const openaiEntry = buildProviderSupportEntry(openai);
		strictEqual(openaiEntry.modelSource, "catalog");
		strictEqual(openaiEntry.defaultModel, undefined);
		strictEqual(defaultModelForRuntime("openai"), undefined);
		ok(openaiEntry.modelHints.length > 2, "the catalog must still be readable as a whole");

		// alcf owns its ids in src/domains/providers/runtimes/cloud/alcf.ts, ordered
		// with intent, so its head is a recommendation and stays one.
		const alcf = runtimes.find((runtime) => runtime.id === "alcf");
		ok(alcf, "alcf runtime must be registered");
		if (!alcf) return;
		const alcfEntry = buildProviderSupportEntry(alcf);
		strictEqual(alcfEntry.modelSource, "runtime");
		strictEqual(alcfEntry.defaultModel, alcf.knownModels?.[0]);
		strictEqual(describeRuntimeModels(alcfEntry, 2), alcf.knownModels?.slice(0, 2).join(", "));
	});

	it("describes a catalog-ordered runtime by size and source, never by a sample", () => {
		for (const runtime of registry().list()) {
			const entry = buildProviderSupportEntry(runtime);
			if (entry.modelSource !== "catalog") continue;
			strictEqual(describeRuntimeModels(entry, 2), `${entry.modelHints.length} in pi-ai catalog`);
		}
	});

	it("clio configure --list prints the catalog size for openai instead of its two oldest ids", async () => {
		const result = await runCli(["configure", "--list"], { env: scratch.env });
		strictEqual(result.code, 0, `stderr=${result.stderr}`);
		// At 80 columns the list uses its two-line form, so the models cell is on
		// the line after the id; at wider widths it is on the same one.
		const lines = result.stdout.split("\n");
		const index = lines.findIndex((line) => /^ {2}openai\s/.test(line));
		ok(index >= 0, `no openai row in:\n${result.stdout}`);
		const row = `${lines[index]}\n${lines[index + 1] ?? ""}`;
		match(row, /models=\d+ in pi-ai catalog/);
		ok(!/models=gpt-/.test(result.stdout), `a catalog row still samples ids:\n${result.stdout}`);
	});

	it("clio configure refuses to seed defaultModel from the catalog and names --model", async () => {
		const result = await runCli(["configure", "--id", "oa", "--runtime", "openai", "--api-key-env", "OPENAI_API_KEY"], {
			env: scratch.env,
			input: "",
		});
		strictEqual(result.code, 2, `stdout=${result.stdout}`);
		match(result.stderr, /--model is required for openai/);
		match(result.stderr, /pi-ai catalog in name order/);
		match(result.stderr, /clio configure --runtime openai/);

		// Refusing means nothing was written: no target, and no gpt-4 anywhere.
		const settings = join(scratch.dir, "config", "settings.yaml");
		const written = existsSync(settings) ? readFileSync(settings, "utf8") : "";
		ok(!written.includes("gpt-4"), `settings.yaml carries a catalog-seeded model:\n${written}`);
		ok(!written.includes("id: oa"), `settings.yaml carries the refused target:\n${written}`);
	});
});
