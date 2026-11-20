import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, test } from "node:test";
import { confirmAction } from "../../src/cli/kit/confirm.js";
import { parseDuration } from "../../src/cli/kit/duration.js";
import { parseCommandFlags } from "../../src/cli/kit/flags.js";
import { defineCommandSpec, helpRequested } from "../../src/cli/kit/help.js";
import { jsonDocument, writeCliFailure } from "../../src/cli/kit/json-out.js";
import { type RunExitFact, resolveRunExit } from "../../src/cli/modes/run-json-schema-v2.js";
import { COMMAND_SPECS } from "../../src/cli/specs/table.js";

const root = resolve(import.meta.dirname, "../..");

describe("cli kit flag parser", () => {
	const declarations = {
		json: { kind: "boolean" },
		yes: { kind: "boolean", short: "y" },
		target: { kind: "value" },
		var: { kind: "value", repeatable: true },
		verify: { kind: "value", freeText: true },
		timeout: { kind: "duration", bareUnit: "s" },
	} as const;

	test("accepts --flag value and --flag=value, short aliases, repeats and positionals", () => {
		const parsed = parseCommandFlags(
			["fix", "-y", "--target", "local", "--var=a=1", "--var", "b=2", "--timeout=90", "-", "--", "--json"],
			declarations,
		);
		deepStrictEqual(parsed, {
			ok: true,
			flags: { yes: true, target: "local", var: ["a=1", "b=2"], timeout: 90_000 },
			positional: ["fix", "-", "--json"],
		});
	});

	test("a value flag takes a token starting with -- only when declared free text", () => {
		deepStrictEqual(parseCommandFlags(["--target", "--json"], declarations), {
			ok: false,
			slug: "usage",
			message: "--target requires a value",
		});
		deepStrictEqual(parseCommandFlags(["--verify", "--strict"], declarations), {
			ok: true,
			flags: { verify: "--strict" },
			positional: [],
		});
	});

	test("refuses undeclared, valued boolean, repeated and malformed flags", () => {
		deepStrictEqual(parseCommandFlags(["--jsn"], declarations), {
			ok: false,
			slug: "unknown_flag",
			message: "unknown flag: --jsn",
		});
		deepStrictEqual(parseCommandFlags(["-q"], declarations), {
			ok: false,
			slug: "unknown_flag",
			message: "unknown flag: -q",
		});
		equal(parseCommandFlags(["--json=1"], declarations).ok, false);
		equal(parseCommandFlags(["--target", "a", "--target=b"], declarations).ok, false);
		const bad = parseCommandFlags(["--timeout", "soon"], declarations);
		ok(!bad.ok && bad.slug === "usage" && bad.message.startsWith("--timeout: expected a duration"));
	});
});

describe("cli kit duration parser", () => {
	test("reads every unit and a bare number in the flag's own unit", () => {
		deepStrictEqual(
			["1500ms", "30s", "5m", "1.5h", "45"].map((text) => parseDuration(text, { bareUnit: "s" })),
			[1_500, 30_000, 300_000, 5_400_000, 45_000].map((ms) => ({ ok: true, ms })),
		);
		deepStrictEqual(parseDuration("250", { bareUnit: "ms" }), { ok: true, ms: 250 });
	});

	test("refuses malformed, negative, zero and oversized values", () => {
		for (const text of ["", "5 m", "-5s", "5d", ".5s", "1e3", "s"]) {
			equal(parseDuration(text, { bareUnit: "s" }).ok, false, text);
		}
		equal(parseDuration("0s", { bareUnit: "s" }).ok, false);
		deepStrictEqual(parseDuration("0", { bareUnit: "s", allowZero: true }), { ok: true, ms: 0 });
		equal(parseDuration("99999999999999999h", { bareUnit: "s" }).ok, false);
	});
});

test("run exit precedence: the highest applying row sets the exit code and leads causes[]", () => {
	const rows: Array<[string, RunExitFact[], number, string, string[]]> = [
		["nothing failed", [], 0, "succeeded", []],
		[
			"forced second signal wins, no payload",
			[{ code: "forced_exit", exitCode: 130 }, { code: "provider_error" }],
			130,
			"failed",
			["provider_error"],
		],
		[
			"signal over deadline",
			[
				{ code: "deadline", seconds: 5 },
				{ code: "interrupted", signal: "SIGHUP" },
			],
			129,
			"canceled",
			["interrupted", "deadline"],
		],
		[
			"deadline over limit",
			[
				{ code: "max_requests", limit: 1, observed: 2 },
				{ code: "deadline", seconds: 5 },
			],
			124,
			"timed_out",
			["deadline", "max_requests"],
		],
		["reader closed", [{ code: "noop" }, { code: "reader_closed" }], 141, "failed", ["reader_closed", "noop"]],
		[
			"unscripted over approval",
			[{ code: "permission_required" }, { code: "unscripted", id: "q1" }],
			5,
			"failed",
			["unscripted", "permission_required"],
		],
		[
			"approval over limit",
			[{ code: "autonomous_cap" }, { code: "judge_streak", window: 3 }],
			3,
			"failed",
			["judge_streak", "autonomous_cap"],
		],
		[
			"limit over work failure",
			[{ code: "verify_failed" }, { code: "session_cost_ceiling" }],
			4,
			"failed",
			["session_cost_ceiling", "verify_failed"],
		],
		[
			"work failures keep table order",
			[{ code: "output_write_failed", path: "o" }, { code: "no_answer" }, { code: "provider_error" }],
			1,
			"failed",
			["provider_error", "no_answer", "output_write_failed"],
		],
		["worker exit 2 is a failed run", [{ code: "worker_failed", exitCode: 2 }], 1, "failed", ["worker_failed"]],
	];
	for (const [name, facts, exitCode, outcome, codes] of rows) {
		const resolved = resolveRunExit(facts);
		equal(resolved.exitCode, exitCode, name);
		equal(resolved.outcome, outcome, name);
		deepStrictEqual(
			resolved.causes.map((cause) => cause.code),
			codes,
			name,
		);
	}
	equal(resolveRunExit([], { displayed: true }).outcome, "displayed");
});

test("json-out writes the C6 failure document and the C3 diagnostic", () => {
	const out: string[] = [];
	const err: string[] = [];
	const streams = { stdout: { write: (s: string) => out.push(s) }, stderr: { write: (s: string) => err.push(s) } };
	writeCliFailure(
		{ path: ["fleet", "verify"], slug: "unknown_flag", message: "unknown flag: --x", json: true },
		streams,
	);
	writeCliFailure({ path: ["fleet", "verify"], slug: "not_found", message: "no run abc", json: false }, streams);
	deepStrictEqual(out, ['{"version":1,"ok":false,"error":{"code":"unknown_flag","message":"unknown flag: --x"}}\n']);
	deepStrictEqual(err, [
		"clio-coder fleet verify: unknown flag: --x\nsee: clio-coder fleet verify --help\n",
		"clio-coder fleet verify: no run abc\n",
	]);
	deepStrictEqual(jsonDocument({ runs: [] }), { version: 1, runs: [] });
});

test("confirmation honours --yes, refuses without a terminal and reports a decline", async () => {
	deepStrictEqual(await confirmAction({ question: "Remove?", yes: true, interactive: false }), { proceed: true });
	deepStrictEqual(await confirmAction({ question: "Remove?", yes: false, interactive: false }), {
		proceed: false,
		slug: "confirmation_required",
		exitCode: 2,
	});
	deepStrictEqual(await confirmAction({ question: "Remove?", yes: false, interactive: true, ask: async () => "n" }), {
		proceed: false,
		slug: "declined",
		exitCode: 1,
	});
	deepStrictEqual(await confirmAction({ question: "Remove?", yes: false, interactive: true, ask: async () => "Yes " }), {
		proceed: true,
	});
	ok(helpRequested(["list", "-h"]) && !helpRequested(["--", "--help"]));
	deepStrictEqual(defineCommandSpec({ path: ["x"], summary: "s", hidden: false }).path, ["x"]);
});

test("spec stubs cover every command handler and the kit stays off the domain graph", async () => {
	const entry = readFileSync(join(root, "src/cli/index.ts"), "utf8");
	const table = entry.slice(
		entry.indexOf("const COMMAND_HANDLERS"),
		entry.indexOf("]);\n", entry.indexOf("const COMMAND_HANDLERS")),
	);
	const handlerKeys = [...table.matchAll(/^\t\[\n?\t*"([a-z-]+)",/gmu)].map((match) => match[1]);
	equal(handlerKeys.length, 49);
	deepStrictEqual(Object.keys(COMMAND_SPECS).sort(), [...handlerKeys].sort());
	for (const [key, load] of Object.entries(COMMAND_SPECS)) {
		const { spec } = await load();
		deepStrictEqual(spec.path, [key]);
		ok(spec.summary.length > 0, key);
	}
	for (const dir of ["src/cli/kit", "src/cli/specs"]) {
		for (const file of readdirSync(join(root, dir)).filter((name) => name.endsWith(".ts"))) {
			const source = readFileSync(join(root, dir, file), "utf8");
			for (const [, specifier] of source.matchAll(/(?:from|import\()\s*"([^"]+)"/gu)) {
				ok(
					specifier?.startsWith("node:") ||
						specifier === "chalk" ||
						/^\.\/[a-z-]+\.js$/u.test(specifier ?? "") ||
						(dir === "src/cli/specs" && /^\.\.\/kit\/[a-z-]+\.js$/u.test(specifier ?? "")),
					`${dir}/${file} imports ${specifier}`,
				);
			}
		}
	}
});
