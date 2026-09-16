import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { runHostVerification } from "../../src/domains/dispatch/host-verification.js";
import { loadProjectVerifierCatalog, parseProjectVerifierCatalogText } from "../../src/tools/verify/catalog.js";
import { verifyTool } from "../../src/tools/verify/index.js";
import {
	compareNumeric,
	normalizeNumericTolerance,
	parseNumericPayload,
	renderNumericReport,
	ulpDistance,
} from "../../src/tools/verify/numeric.js";
import {
	extractNumericPayloadText,
	JUDGED_CHECK_MAX_OUTPUT_BYTES,
	runProjectCheck,
} from "../../src/tools/verify/scripts.js";

/** A report with its text provenance removed, for comparing verdicts judged from differently labeled inputs. */
function verdictOf(report: unknown): unknown {
	if (report === null || typeof report !== "object") return report;
	const { reference: _reference, actual: _actual, ...verdict } = report as Record<string, unknown>;
	return verdict;
}

const roots: string[] = [];
const originalCwd = process.cwd();

function workspace(files: Record<string, string>): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "clio-coder-verify-numeric-")));
	roots.push(root);
	for (const [relative, text] of Object.entries(files)) {
		mkdirSync(join(root, relative, ".."), { recursive: true });
		writeFileSync(join(root, relative), text, "utf8");
	}
	return root;
}

afterEach(() => {
	process.chdir(originalCwd);
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A node one-liner that prints the payload on stdout, as a catalog argv vector. */
function printing(payload: Record<string, unknown>, stderr?: string): string[] {
	const script = `${stderr === undefined ? "" : `process.stderr.write(${JSON.stringify(stderr)});`}process.stdout.write(JSON.stringify(${JSON.stringify(payload)}))`;
	return ["node", "-e", script];
}

function catalog(check: Record<string, unknown>): string {
	return JSON.stringify({ version: 2, checks: [check] });
}

describe("numeric-compare tolerance math", () => {
	it("passes within relative tolerance and fails outside it", () => {
		const within = compareNumeric({ e: 1.0000005 }, { e: 1 }, { relative: 1e-6 });
		strictEqual(within.passed, true);
		const outside = compareNumeric({ e: 1.00001 }, { e: 1 }, { relative: 1e-6 });
		strictEqual(outside.passed, false);
		deepStrictEqual(outside.failedKeys, ["e"]);
		deepStrictEqual(outside.keys[0]?.failed, ["relative"]);
		match(outside.keys[0]?.detail ?? "", /^e: failed relative at worst actual=1\.00001 expected=1/u);
		match(outside.summary, /numeric-compare failed: 1 of 1 key\(s\) out of tolerance \(e\)/u);
	});

	it("agrees with an unscaled reference at extreme relative-tolerance boundaries", () => {
		// These binary fractions scale exactly. Cancel the common MAX_VALUE
		// factor in the reference calculation so its subtraction cannot overflow.
		const pairs = [
			[-0.5, 1],
			[0.5, -1],
			[-1, 0.5],
			[1, -0.5],
			[-1, 1],
			[1, -1],
			[0.5, 1],
			[-0.5, -1],
			[1, 0.5],
			[-1, -0.5],
			[1, 1],
			[-1, -1],
			[0, 1],
			[0, -1],
		] as const;
		for (const [a, e] of pairs) {
			const relative = Math.abs(a - e) / Math.abs(e);
			const step = Number.EPSILON * Math.max(1, relative);
			const bounds = relative === 0 ? [0, step] : [relative, relative - step, relative + step];
			for (const bound of bounds) {
				const label = `actual=${a}*MAX_VALUE expected=${e}*MAX_VALUE tolerance=${bound}`;
				const report = compareNumeric({ v: a * Number.MAX_VALUE }, { v: e * Number.MAX_VALUE }, { relative: bound });
				const passed = relative <= bound;
				strictEqual(report.passed, passed, label);
				strictEqual(report.keys[0]?.passed, passed, label);
				strictEqual(report.keys[0]?.worst?.relative, relative, label);
				deepStrictEqual(report.failedKeys, passed ? [] : ["v"], label);
				deepStrictEqual(report.keys[0]?.failed, passed ? [] : ["relative"], label);
			}
		}
	});

	it("preserves relative precision between adjacent values near MAX_VALUE", () => {
		// The significands differ by one: (2^53 - 1) versus (2^53 - 2).
		const relative = 1 / (2 ** 53 - 2);
		for (const sign of [-1, 1]) {
			const actual = { v: sign * Number.MAX_VALUE };
			const expected = { v: sign * (Number.MAX_VALUE - 2 ** 971) };
			const report = compareNumeric(actual, expected, { relative });
			strictEqual(report.passed, true);
			strictEqual(report.keys[0]?.worst?.relative, relative);
			strictEqual(compareNumeric(actual, expected, { relative: relative * (1 - Number.EPSILON) }).passed, false);
		}
	});

	it("preserves signed-zero and subnormal relative comparisons", () => {
		for (const actual of [0, -0]) {
			for (const expected of [0, -0]) {
				const report = compareNumeric({ v: actual }, { v: expected }, { relative: 0 });
				strictEqual(report.passed, true);
				strictEqual(report.keys[0]?.worst?.relative, 0);
			}
			for (const expected of [Number.MIN_VALUE, -Number.MIN_VALUE]) {
				strictEqual(compareNumeric({ v: actual }, { v: expected }, { relative: 1 }).passed, true);
				strictEqual(compareNumeric({ v: actual }, { v: expected }, { relative: 1 - Number.EPSILON }).passed, false);
				const reversed = compareNumeric({ v: expected }, { v: actual }, { relative: Number.MAX_VALUE });
				strictEqual(reversed.passed, false);
				strictEqual(reversed.keys[0]?.worst?.relative, null);
			}
		}
		const actual = { v: -Number.MIN_VALUE };
		const expected = { v: Number.MIN_VALUE };
		strictEqual(compareNumeric(actual, expected, { relative: 2 }).passed, true);
		strictEqual(compareNumeric(actual, expected, { relative: 2 - Number.EPSILON }).passed, false);
	});

	it("still rejects unrepresentable relative errors and independent absolute or ulp failures", () => {
		const unbounded = compareNumeric({ v: Number.MAX_VALUE }, { v: Number.MIN_VALUE }, { relative: Number.MAX_VALUE });
		strictEqual(unbounded.passed, false);
		strictEqual(unbounded.keys[0]?.worst?.relative, "Infinity");
		deepStrictEqual(unbounded.keys[0]?.failed, ["relative"]);
		const report = compareNumeric(
			{ v: -Number.MAX_VALUE / 2 },
			{ v: Number.MAX_VALUE },
			{ relative: 1.5, absolute: Number.MAX_VALUE, ulp: Number.MAX_SAFE_INTEGER },
		);
		strictEqual(report.passed, false);
		strictEqual(report.keys[0]?.worst?.relative, 1.5);
		strictEqual(report.keys[0]?.worst?.absolute, "Infinity");
		deepStrictEqual(report.keys[0]?.failed, ["absolute", "ulp"]);
	});

	it("judges extreme array elements and reports the out-of-tolerance element", () => {
		const actual = { v: [Number.MAX_VALUE, -Number.MAX_VALUE / 2, -Number.MAX_VALUE] };
		const expected = { v: [Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE] };
		strictEqual(compareNumeric(actual, expected, { relative: 2 }).passed, true);
		const report = compareNumeric(actual, expected, { relative: 1.5 });
		strictEqual(report.passed, false);
		deepStrictEqual(report.failedKeys, ["v"]);
		deepStrictEqual(report.keys[0]?.failed, ["relative"]);
		strictEqual(report.keys[0]?.worst?.index, 2);
		strictEqual(report.keys[0]?.worst?.relative, 2);
	});

	it("judges absolute tolerance, including against a zero reference", () => {
		strictEqual(compareNumeric({ z: 0.004 }, { z: 0 }, { absolute: 0.005 }).passed, true);
		strictEqual(compareNumeric({ z: 0.006 }, { z: 0 }, { absolute: 0.005 }).passed, false);
		// Relative deviation is undefined against zero, so it fails unless exact.
		strictEqual(compareNumeric({ z: 0 }, { z: 0 }, { relative: 1e-9 }).passed, true);
		const undefinedRelative = compareNumeric({ z: 1e-12 }, { z: 0 }, { relative: 1e-9 });
		strictEqual(undefinedRelative.passed, false);
		strictEqual(undefinedRelative.keys[0]?.worst?.relative, null);
	});

	it("measures ulp distance as representable doubles and judges it", () => {
		strictEqual(ulpDistance(1, 1), 0);
		strictEqual(ulpDistance(1, 1 + Number.EPSILON), 1);
		strictEqual(ulpDistance(0, -0), 0);
		strictEqual(ulpDistance(-1, -1 - Number.EPSILON), 1);
		ok(ulpDistance(-Number.MIN_VALUE, Number.MIN_VALUE) === 2, "a sign crossing counts every double in between");
		strictEqual(ulpDistance(1, Number.NaN), Number.POSITIVE_INFINITY);
		strictEqual(compareNumeric({ v: 1 + 3 * Number.EPSILON }, { v: 1 }, { ulp: 4 }).passed, true);
		const failed = compareNumeric({ v: 1 + 6 * Number.EPSILON }, { v: 1 }, { ulp: 4 });
		strictEqual(failed.passed, false);
		deepStrictEqual(failed.keys[0]?.failed, ["ulp"]);
	});

	it("requires every named tolerance to hold unless combine is any", () => {
		const report = compareNumeric({ v: 1.5 }, { v: 1 }, { relative: 1, absolute: 0.1 });
		strictEqual(report.passed, false);
		strictEqual(report.combine, "all");
		strictEqual(report.nonFinite, "fail");
		deepStrictEqual(report.keys[0]?.failed, ["absolute"]);
		deepStrictEqual(report.keys[0]?.held, ["relative"]);
		deepStrictEqual(report.keys[0]?.violated, ["absolute"]);
		strictEqual(report.rule, "all of relative<=1, absolute<=0.1 must hold; non-finite values fail");
		const any = compareNumeric({ v: 1.5 }, { v: 1 }, { relative: 1, absolute: 0.1, combine: "any" });
		strictEqual(any.passed, true);
		strictEqual(any.combine, "any");
		deepStrictEqual(any.keys[0]?.failed, []);
		deepStrictEqual(any.keys[0]?.held, ["relative"]);
		deepStrictEqual(any.keys[0]?.violated, ["absolute"]);
		strictEqual(any.rule, "any of relative<=1, absolute<=0.1 may hold; non-finite values fail");
		match(any.keys[0]?.detail ?? "", /^v: within tolerance by relative \(absolute violated\), worst actual=1\.5/u);
		const rendered = renderNumericReport(any);
		match(rendered, /\nrule: any of relative<=1, absolute<=0\.1 may hold; non-finite values fail\n/u);
		deepStrictEqual(
			any.tolerance,
			{ relative: 1, absolute: 0.1, combine: "any" },
			"declared tolerance is echoed as written",
		);
	});

	it("compares arrays elementwise, reports the worst element, and fails on length mismatch", () => {
		const report = compareNumeric({ grid: [1, 2.5, 3] }, { grid: [1, 2, 3] }, { absolute: 0.1 });
		strictEqual(report.passed, false);
		strictEqual(report.keys[0]?.worst?.index, 1);
		strictEqual(report.keys[0]?.worst?.absolute, 0.5);
		const passed = compareNumeric({ grid: [1, 2.05, 3] }, { grid: [1, 2, 3] }, { absolute: 0.1 });
		strictEqual(passed.passed, true);
		const length = compareNumeric({ grid: [1, 2] }, { grid: [1, 2, 3] }, { absolute: 0.1 });
		deepStrictEqual(length.keys[0]?.failed, ["length-mismatch"]);
		match(length.keys[0]?.detail ?? "", /2 element\(s\) in the command output but 3 in the reference/u);
		const shape = compareNumeric({ grid: 1 }, { grid: [1] }, { absolute: 0.1 });
		deepStrictEqual(shape.keys[0]?.failed, ["shape-mismatch"]);
	});

	it("fails a key missing on either side and names the side", () => {
		const report = compareNumeric({ a: 1, extra: 2 }, { a: 1, b: 2 }, { absolute: 0 });
		strictEqual(report.passed, false);
		deepStrictEqual(report.failedKeys, ["b", "extra"]);
		deepStrictEqual(
			report.keys.map((key) => [key.key, key.failed]),
			[
				["a", []],
				["b", ["missing-actual"]],
				["extra", ["missing-reference"]],
			],
		);
	});

	it("fails NaN and infinity under every tolerance", () => {
		for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
			const report = compareNumeric({ v: value }, { v: 1 }, { relative: 1e9, absolute: 1e9, ulp: 1_000_000 });
			strictEqual(report.passed, false, String(value));
			deepStrictEqual(report.keys[0]?.failed, ["not-finite"]);
		}
		strictEqual(compareNumeric({ v: 1 }, { v: Number.POSITIVE_INFINITY }, { absolute: 1e9 }).passed, false);
	});

	it("rejects payloads and tolerances that are not the documented shape", () => {
		ok(parseNumericPayload("[1,2]", "command output") instanceof Error);
		ok(parseNumericPayload('{"a":"1"}', "command output") instanceof Error);
		ok(parseNumericPayload('{"a":[1,"x"]}', "command output") instanceof Error);
		ok(parseNumericPayload("not json", "reference") instanceof Error);
		deepStrictEqual(parseNumericPayload('{"a":1,"b":[1,2]}', "x"), { a: 1, b: [1, 2] });
		ok(normalizeNumericTolerance({}) instanceof Error);
		ok(normalizeNumericTolerance({ relative: -1 }) instanceof Error);
		ok(normalizeNumericTolerance({ ulp: 1.5 }) instanceof Error);
		ok(normalizeNumericTolerance({ epsilon: 1 }) instanceof Error);
		deepStrictEqual(normalizeNumericTolerance({ relative: 1e-6, ulp: 2 }), { relative: 1e-6, ulp: 2 });
		strictEqual(extractNumericPayloadText('loading...\n{"a": 1}\n'), '{"a": 1}');
	});

	it("preserves inherited property names as measured scalar and array fields", () => {
		for (const expected of [1, [1, 2]]) {
			const reference = parseNumericPayload(JSON.stringify({ ["__proto__"]: expected, constructor: 2 }), "reference");
			const actual = parseNumericPayload(JSON.stringify({ ["__proto__"]: 999, constructor: 2 }), "actual");
			ok(!(reference instanceof Error));
			ok(!(actual instanceof Error));
			deepStrictEqual(Object.keys(reference), ["__proto__", "constructor"]);
			strictEqual(Object.hasOwn(reference, "__proto__"), true);
			deepStrictEqual(Object.getOwnPropertyDescriptor(reference, "__proto__")?.value, expected);
			strictEqual(compareNumeric(reference, reference, { absolute: 0 }).passed, true);
			const report = compareNumeric(actual, reference, { absolute: 0 });
			strictEqual(report.passed, false);
			deepStrictEqual(report.failedKeys, ["__proto__"]);
		}
	});
});

describe("verifier catalog kinds", () => {
	it("loads a version 1 catalog with every check as kind command", () => {
		const parsed = parseProjectVerifierCatalogText(
			JSON.stringify({
				version: 1,
				checks: [
					{ id: "unit", description: "Unit tests", command: ["node", "--test"], cwd: ".", timeoutMs: 1000, tags: [] },
				],
			}),
			workspace({}),
		);
		strictEqual(parsed.ok, true);
		if (!parsed.ok) return;
		strictEqual(parsed.source?.checks[0]?.kind, "command");
		strictEqual("numeric" in (parsed.source?.checks[0] ?? {}), false);
	});

	it("rejects kind fields under version 1, an unknown kind, and incomplete kind parameters", () => {
		const root = workspace({});
		const base = { id: "c", description: "Check", command: ["node", "-v"], cwd: ".", timeoutMs: 1000, tags: [] };
		const cases: Array<[Record<string, unknown>, RegExp]> = [
			[{ version: 1, checks: [{ ...base, kind: "numeric-compare" }] }, /checks\[0\] has unknown field\(s\): kind/u],
			[
				{ version: 2, checks: [{ ...base, kind: "fuzzy" }] },
				/checks\[0\]\.kind must be one of command, numeric-compare, perf-budget/u,
			],
			[
				{ version: 2, checks: [{ ...base, kind: "numeric-compare", reference: "ref.json" }] },
				/checks\[0\]\.tolerance is required for kind numeric-compare/u,
			],
			[
				{ version: 2, checks: [{ ...base, kind: "numeric-compare", reference: "ref.json", tolerance: {} }] },
				/checks\[0\]\.tolerance must name at least one of relative, absolute, or ulp/u,
			],
			[
				{ version: 2, checks: [{ ...base, kind: "numeric-compare", reference: "/abs/ref.json", tolerance: { ulp: 1 } }] },
				/checks\[0\]\.reference must be repository-relative/u,
			],
			[
				{ version: 2, checks: [{ ...base, kind: "numeric-compare", reference: "../ref.json", tolerance: { ulp: 1 } }] },
				/checks\[0\]\.reference escapes the workspace root/u,
			],
			[{ version: 2, checks: [{ ...base, kind: "perf-budget" }] }, /requires exactly one of budget or baseline/u],
			[
				{ version: 2, checks: [{ ...base, kind: "perf-budget", budget: { wallTimeMs: 10 }, baseline: "b.json" }] },
				/requires exactly one of budget or baseline/u,
			],
			[
				{
					version: 2,
					checks: [{ ...base, kind: "perf-budget", budget: { wallTimeMs: 10 }, tolerance: { relative: 0.1 } }],
				},
				/tolerance belongs inside budget/u,
			],
			[
				{ version: 2, checks: [{ ...base, kind: "command", reference: "ref.json" }] },
				/kind 'command' does not accept reference/u,
			],
			[
				{
					version: 2,
					checks: [{ ...base, kind: "numeric-compare", reference: "ref.json", tolerance: { ulp: 1, combine: "either" } }],
				},
				/^\.clio-coder\/verifiers\.yaml: checks\[0\]\.tolerance\.combine must be all or any$/u,
			],
			[
				{
					version: 2,
					checks: [{ ...base, kind: "numeric-compare", reference: "ref.json", tolerance: { ulp: 1, nonFinite: "ignore" } }],
				},
				/^\.clio-coder\/verifiers\.yaml: checks\[0\]\.tolerance\.nonFinite must be fail or match$/u,
			],
			[
				{
					version: 2,
					checks: [{ ...base, kind: "numeric-compare", reference: "ref.json", tolerance: { combine: "any" } }],
				},
				/checks\[0\]\.tolerance must name at least one of relative, absolute, or ulp/u,
			],
			[{ version: 3, checks: [] }, /unsupported version 3; supported versions are 1 and 2/u],
		];
		for (const [text, expected] of cases) {
			const parsed = parseProjectVerifierCatalogText(JSON.stringify(text), root);
			strictEqual(parsed.ok, false, JSON.stringify(text));
			if (!parsed.ok) match(parsed.reason, expected);
		}
		const accepted = parseProjectVerifierCatalogText(
			JSON.stringify({
				version: 2,
				checks: [
					{ ...base, id: "n", kind: "numeric-compare", reference: "ref.json", tolerance: { relative: 1e-6 } },
					{
						...base,
						id: "o",
						kind: "numeric-compare",
						reference: "ref.json",
						tolerance: { relative: 1e-6, absolute: 1e-9, combine: "any", nonFinite: "match" },
					},
					{ ...base, id: "p", kind: "perf-budget", baseline: "b.json", tolerance: { relative: 0.2 } },
					{ ...base, id: "q", kind: "perf-budget", budget: { wallTimeMs: 50, tolerance: { relative: 0.1 } } },
				],
			}),
			root,
		);
		strictEqual(accepted.ok, true, accepted.ok ? "" : accepted.reason);
		if (!accepted.ok) return;
		deepStrictEqual(
			accepted.source?.checks.map((check) => [check.id, check.kind]),
			[
				["n", "numeric-compare"],
				["o", "numeric-compare"],
				["p", "perf-budget"],
				["q", "perf-budget"],
			],
		);
		deepStrictEqual(accepted.source?.checks[0]?.numeric?.tolerance, { relative: 1e-6 }, "no defaults are filled in");
		deepStrictEqual(accepted.source?.checks[1]?.numeric?.tolerance, {
			relative: 1e-6,
			absolute: 1e-9,
			combine: "any",
			nonFinite: "match",
		});
		deepStrictEqual(accepted.source?.checks[2]?.perf, { baseline: "b.json", tolerance: { relative: 0.2 } });
	});
});

describe("numeric-compare through the verify runner", () => {
	it("judges the command's stdout against the reference and records the report", async () => {
		const root = workspace({
			".clio-coder/verifiers.yaml": catalog({
				id: "stats",
				description: "Grid statistics",
				kind: "numeric-compare",
				command: printing({ mean: 1.0000001, grid: [1, 2, 3] }, "loading grid\n"),
				reference: "tests/reference/stats.json",
				tolerance: { relative: 1e-6 },
				cwd: ".",
				timeoutMs: 30_000,
				tags: ["scientific"],
			}),
			"tests/reference/stats.json": JSON.stringify({ mean: 1, grid: [1, 2, 3] }),
		});
		process.chdir(root);
		const loaded = loadProjectVerifierCatalog(root);
		strictEqual(loaded.ok, true, loaded.ok ? "" : loaded.reason);
		if (!loaded.ok || loaded.source === null) return;
		const check = loaded.source.checks[0];
		if (check === undefined) throw new Error("expected a check");
		const result = await runProjectCheck(check);
		strictEqual(result.kind, "ok", JSON.stringify(result));
		if (result.kind !== "ok") return;
		match(
			result.output,
			/^numeric-compare passed: 2 key\(s\) within tolerance\nrule: relative<=1e-6 must hold; non-finite values fail\n/u,
		);
		match(
			result.output,
			/\nreference: tests\/reference\/stats\.json sha256=[0-9a-f]{12} \(\d+B\)\nactual: sha256=[0-9a-f]{12} \(\d+B\)\n/u,
		);
		const report = result.details?.report as {
			kind: string;
			passed: boolean;
			failedKeys: string[];
			reference?: { source: string; path?: string; sha256: string; bytes: number };
			actual?: { sha256: string; bytes: number };
		};
		strictEqual(report.kind, "numeric-compare");
		strictEqual(report.passed, true);
		strictEqual(result.details?.kind, "numeric-compare");
		strictEqual(result.details?.check, "stats");
		const referenceText = JSON.stringify({ mean: 1, grid: [1, 2, 3] });
		deepStrictEqual(report.reference, {
			source: "reference 'tests/reference/stats.json'",
			path: "tests/reference/stats.json",
			sha256: createHash("sha256").update(referenceText).digest("hex"),
			bytes: Buffer.byteLength(referenceText),
		});
		const payloadText = JSON.stringify({ mean: 1.0000001, grid: [1, 2, 3] });
		deepStrictEqual(report.actual, {
			sha256: createHash("sha256").update(payloadText).digest("hex"),
			bytes: Buffer.byteLength(payloadText),
		});
		deepStrictEqual(result.details?.judgement, {
			execution: "succeeded",
			validation: "passed",
			scientificValidity: "not established by this check",
		});
	});

	it("fails before judgement when the command's output overruns the judged-check ceiling", async () => {
		const root = workspace({
			".clio-coder/verifiers.yaml": catalog({
				id: "flood",
				description: "Prints more than the ceiling",
				kind: "numeric-compare",
				command: [
					"node",
					"-e",
					`const chunk="1".repeat(1<<20);for(let i=0;i<${Math.ceil(JUDGED_CHECK_MAX_OUTPUT_BYTES / (1 << 20)) + 2};i+=1)process.stdout.write(chunk);`,
				],
				reference: "ref.json",
				tolerance: { absolute: 0 },
				cwd: ".",
				timeoutMs: 120_000,
				tags: [],
			}),
			"ref.json": JSON.stringify({ mean: 1 }),
		});
		process.chdir(root);
		const loaded = loadProjectVerifierCatalog(root);
		if (!loaded.ok || loaded.source === null) throw new Error("catalog must load");
		const check = loaded.source.checks[0];
		if (check === undefined) throw new Error("expected a check");
		const result = await runProjectCheck(check);
		strictEqual(result.kind, "error");
		if (result.kind !== "error") return;
		strictEqual(
			result.message,
			`verify: numeric-compare command output exceeded ${JUDGED_CHECK_MAX_OUTPUT_BYTES} bytes before judgement`,
		);
		strictEqual(result.details?.outputCapped, true);
		strictEqual("report" in (result.details ?? {}), false);
		deepStrictEqual(result.details?.judgement, {
			execution: "output-capped",
			validation: "not-run",
			scientificValidity: "not established by this check",
		});
	});

	it("refuses a reference file over the byte ceiling before reading it and reads one exactly at it", async () => {
		const cap = JUDGED_CHECK_MAX_OUTPUT_BYTES;
		const root = workspace({
			".clio-coder/verifiers.yaml": JSON.stringify({
				version: 2,
				checks: [
					{
						id: "over",
						description: "Reference past the cap",
						kind: "numeric-compare",
						command: printing({ mean: 1 }),
						reference: "over.json",
						tolerance: { absolute: 0 },
						cwd: ".",
						timeoutMs: 30_000,
						tags: [],
					},
					{
						id: "at",
						description: "Reference at the cap",
						kind: "numeric-compare",
						command: printing({ mean: 1 }),
						reference: "at.json",
						tolerance: { absolute: 0 },
						cwd: ".",
						timeoutMs: 30_000,
						tags: [],
					},
				],
			}),
			"over.json": `{"mean":1}${" ".repeat(cap - 9)}`,
			"at.json": `{"mean":1}${" ".repeat(cap - 10)}`,
		});
		process.chdir(root);
		const loaded = loadProjectVerifierCatalog(root);
		if (!loaded.ok || loaded.source === null) throw new Error("catalog must load");
		const [at, over] = loaded.source.checks;
		if (at === undefined || over === undefined) throw new Error("expected two checks");
		const refused = await runProjectCheck(over);
		strictEqual(refused.kind, "error");
		if (refused.kind !== "error") return;
		strictEqual(refused.message, `verify: reference 'over.json' exceeds the ${cap}-byte cap (${cap + 1} bytes)`);
		strictEqual("report" in (refused.details ?? {}), false);
		deepStrictEqual(refused.details?.judgement, {
			execution: "succeeded",
			validation: "not-run",
			scientificValidity: "not established by this check",
		});
		const judged = await runProjectCheck(at);
		strictEqual(judged.kind, "ok", JSON.stringify(judged));
		const report = judged.details?.report as { reference?: { bytes: number } };
		strictEqual(report.reference?.bytes, cap);
	});

	it("fails with the report when a key is out of tolerance, and before judgement when the command fails", async () => {
		const root = workspace({
			".clio-coder/verifiers.yaml": JSON.stringify({
				version: 2,
				checks: [
					{
						id: "drift",
						description: "Drifted statistics",
						kind: "numeric-compare",
						command: printing({ mean: 1.5 }),
						reference: "ref.json",
						tolerance: { absolute: 0.1 },
						cwd: ".",
						timeoutMs: 30_000,
						tags: [],
					},
					{
						id: "crash",
						description: "Crashing validator",
						kind: "numeric-compare",
						command: ["node", "-e", "process.exit(3)"],
						reference: "ref.json",
						tolerance: { absolute: 0.1 },
						cwd: ".",
						timeoutMs: 30_000,
						tags: [],
					},
				],
			}),
			"ref.json": JSON.stringify({ mean: 1 }),
		});
		process.chdir(root);
		const loaded = loadProjectVerifierCatalog(root);
		if (!loaded.ok || loaded.source === null) throw new Error("catalog must load");
		const [crash, drift] = loaded.source.checks;
		if (crash === undefined || drift === undefined) throw new Error("expected two checks");
		const drifted = await runProjectCheck(drift);
		strictEqual(drifted.kind, "error");
		if (drifted.kind !== "error") return;
		match(drifted.message, /numeric-compare failed: 1 of 1 key\(s\) out of tolerance \(mean\)/u);
		match(drifted.message, /mean: failed absolute at worst actual=1\.5 expected=1 abs=0\.5/u);
		const report = drifted.details?.report as { passed: boolean; failedKeys: string[] };
		deepStrictEqual(report.failedKeys, ["mean"]);
		deepStrictEqual(drifted.details?.judgement, {
			execution: "succeeded",
			validation: "failed",
			scientificValidity: "not established by this check",
		});
		const crashed = await runProjectCheck(crash);
		strictEqual(crashed.kind, "error");
		if (crashed.kind !== "error") return;
		match(crashed.message, /numeric-compare command exited with code 3 before judgement/u);
		strictEqual("report" in (crashed.details ?? {}), false);
		deepStrictEqual(crashed.details?.judgement, {
			execution: "failed",
			validation: "not-run",
			scientificValidity: "not established by this check",
		});
	});

	it("attaches the exit-code judgement to a plain command check", async () => {
		const root = workspace({
			".clio-coder/verifiers.yaml": JSON.stringify({
				version: 2,
				checks: [
					{ id: "ok", description: "Exits 0", command: ["node", "-e", "0"], cwd: ".", timeoutMs: 30_000, tags: [] },
					{
						id: "bad",
						description: "Exits 4",
						command: ["node", "-e", "process.exit(4)"],
						cwd: ".",
						timeoutMs: 30_000,
						tags: [],
					},
				],
			}),
		});
		process.chdir(root);
		const loaded = loadProjectVerifierCatalog(root);
		if (!loaded.ok || loaded.source === null) throw new Error("catalog must load");
		const [bad, good] = loaded.source.checks;
		if (bad === undefined || good === undefined) throw new Error("expected two checks");
		const passed = await runProjectCheck(good);
		strictEqual(passed.kind, "ok");
		deepStrictEqual(passed.details?.judgement, {
			execution: "succeeded",
			validation: "exit-code",
			scientificValidity: "not established by this check",
		});
		const failed = await runProjectCheck(bad);
		strictEqual(failed.kind, "error");
		deepStrictEqual(failed.details?.judgement, {
			execution: "failed",
			validation: "exit-code",
			scientificValidity: "not established by this check",
		});
	});
});

describe("package-script checks through the verify tool", () => {
	it("carries the exit-code judgement on every package script it runs and none on a refusal", async () => {
		const root = workspace({
			"package.json": JSON.stringify({ scripts: { test: "node -e 0", lint: "exit 4", start: "node -e 0" } }),
		});
		process.chdir(root);
		const passed = await verifyTool.run({ check: "test" });
		strictEqual(passed.kind, "ok", JSON.stringify(passed));
		strictEqual(passed.details?.exitCode, 0);
		deepStrictEqual(passed.details?.argv, ["npm", "run", "test"]);
		deepStrictEqual(passed.details?.source, { kind: "package.json", path: join(root, "package.json") });
		deepStrictEqual(passed.details?.judgement, {
			execution: "succeeded",
			validation: "exit-code",
			scientificValidity: "not established by this check",
		});
		const failed = await verifyTool.run({ check: "lint" });
		strictEqual(failed.kind, "error");
		ok(typeof failed.details?.exitCode === "number" && failed.details.exitCode !== 0);
		deepStrictEqual(failed.details?.judgement, {
			execution: "failed",
			validation: "exit-code",
			scientificValidity: "not established by this check",
		});
		// A script outside the verification family and a missing script are
		// refused before anything runs, so there is no execution to judge.
		for (const check of ["start", "test:missing"]) {
			const refused = await verifyTool.run({ check });
			strictEqual(refused.kind, "error", check);
			strictEqual("judgement" in (refused.details ?? {}), false, check);
			strictEqual("exitCode" in (refused.details ?? {}), false, check);
		}
	});
});

describe("numeric-compare under host verification", () => {
	it("judges every parsed field through both ordinary and host verification", async () => {
		for (const measurement of [1, 999]) {
			const output = JSON.stringify({ ["__proto__"]: measurement });
			const argv = [process.execPath, "-e", `process.stdout.write(${JSON.stringify(output)})`];
			const root = workspace({
				"ref.json": JSON.stringify({ ["__proto__"]: 1 }),
				".clio-coder/verifiers.yaml": catalog({
					id: "measurement",
					description: "Preserve every measurement",
					kind: "numeric-compare",
					command: argv,
					reference: "ref.json",
					tolerance: { absolute: 0 },
					cwd: ".",
					timeoutMs: 30_000,
					tags: [],
				}),
			});
			process.chdir(root);
			const loaded = loadProjectVerifierCatalog(root);
			ok(loaded.ok && loaded.source !== null);
			const check = loaded.source.checks[0];
			ok(check);
			const ordinary = await runProjectCheck(check);
			strictEqual(ordinary.kind, measurement === 1 ? "ok" : "error");
			const host = await runHostVerification({
				runId: `measurement-${measurement}`,
				request: {
					resolvedVerification: [
						{
							check: "measurement",
							argv,
							cwd: root,
							timeoutMs: 30_000,
							kind: "numeric-compare",
							numeric: { reference: join(root, "ref.json"), tolerance: { absolute: 0 } },
						},
					],
				},
				workerSuccessful: true,
				stateDir: join(root, "state"),
			});
			strictEqual(host?.status, measurement === 1 ? "verified" : "rejected");
			const report = host?.checks[0]?.report;
			ok(report?.kind === "numeric-compare");
			strictEqual(report.keys.length, 1);
			// Ordinary verify labels the reference by its catalog path and host
			// verification by its sealed absolute path, so the provenance differs
			// while the verdict must not; the digests name the same bytes.
			deepStrictEqual(verdictOf(report), verdictOf(ordinary.details?.report));
			const ordinaryReport = ordinary.details?.report as { reference?: { path?: string; sha256: string } };
			strictEqual(ordinaryReport.reference?.path, "ref.json");
			strictEqual(report.reference?.sha256, ordinaryReport.reference?.sha256);
			strictEqual(report.reference?.path, join(root, "ref.json"), "host verification labels the sealed path");
		}
	});

	for (const stdout of ["", '{"value":1}\n']) {
		it(`agrees with ordinary verify when stdout is ${stdout === "" ? "empty" : "valid"} and stderr contains diagnostic JSON`, async () => {
			const diagnostic = '{"value":1}\n';
			const argv = [
				process.execPath,
				"-e",
				`process.stdout.write(${JSON.stringify(stdout)}); process.stderr.write(${JSON.stringify(diagnostic)});`,
			];
			const root = workspace({
				"ref.json": '{"value":1}',
				".clio-coder/verifiers.yaml": catalog({
					id: "value",
					description: "Measurement with diagnostics",
					kind: "numeric-compare",
					command: argv,
					reference: "ref.json",
					tolerance: { absolute: 0 },
					cwd: ".",
					timeoutMs: 30_000,
					tags: [],
				}),
			});
			process.chdir(root);
			const loaded = loadProjectVerifierCatalog(root);
			if (!loaded.ok || loaded.source === null) throw new Error("catalog must load");
			const declared = loaded.source.checks[0];
			ok(declared);
			const ordinary = await runProjectCheck(declared);
			strictEqual(ordinary.kind, stdout === "" ? "error" : "ok");
			const host = await runHostVerification({
				runId: "diagnostic-json",
				request: {
					resolvedVerification: [
						{
							check: "value",
							argv,
							cwd: root,
							timeoutMs: 30_000,
							kind: "numeric-compare",
							numeric: { reference: join(root, "ref.json"), tolerance: { absolute: 0 } },
						},
					],
				},
				workerSuccessful: true,
				stateDir: join(root, "state"),
			});
			strictEqual(host?.status, stdout === "" ? "rejected" : "verified");
			const result = host?.checks[0];
			strictEqual(result?.exitCode, stdout === "" ? 1 : 0);
			if (stdout === "") match(result?.outputTail ?? "", /command output.*not valid JSON/u);
			// Same verdict; the reference labels differ between the two paths.
			else deepStrictEqual(verdictOf(result?.report), verdictOf(ordinary.details?.report));
			ok(result?.artifactPath);
			ok(readFileSync(result.artifactPath, "utf8").includes(diagnostic), "stderr remains in the diagnostic artifact");
		});
	}

	it("seals the report on the check and turns a failed judgement into a rejection", async () => {
		const root = workspace({ "ref.json": JSON.stringify({ energy: [1, 2] }) });
		const stateDir = join(root, "state");
		mkdirSync(stateDir, { recursive: true });
		const base = { cwd: root, timeoutMs: 30_000, kind: "numeric-compare" as const };
		const numeric = { reference: join(root, "ref.json"), tolerance: { absolute: 0.01 } };
		const passing = await runHostVerification({
			runId: "run-pass",
			request: { resolvedVerification: [{ ...base, check: "energy", argv: printing({ energy: [1, 2.005] }), numeric }] },
			workerSuccessful: true,
			stateDir,
		});
		strictEqual(passing?.status, "verified");
		const passedCheck = passing?.checks[0];
		strictEqual(passedCheck?.exitCode, 0);
		strictEqual(passedCheck?.report?.kind, "numeric-compare");
		strictEqual(passedCheck?.report?.passed, true);
		const failing = await runHostVerification({
			runId: "run-fail",
			request: { resolvedVerification: [{ ...base, check: "energy", argv: printing({ energy: [1, 2.5] }), numeric }] },
			workerSuccessful: true,
			stateDir,
		});
		strictEqual(failing?.status, "rejected");
		const failedCheck = failing?.checks[0];
		strictEqual(failedCheck?.exitCode, 1);
		strictEqual(failedCheck?.report?.passed, false);
		match(failedCheck?.outputTail ?? "", /^numeric-compare failed/u);
		const missing = await runHostVerification({
			runId: "run-missing",
			request: {
				resolvedVerification: [
					{
						...base,
						check: "energy",
						argv: printing({ energy: [1, 2] }),
						numeric: { ...numeric, reference: join(root, "absent.json") },
					},
				],
			},
			workerSuccessful: true,
			stateDir,
		});
		strictEqual(missing?.status, "rejected");
		match(missing?.checks[0]?.outputTail ?? "", /reference .* cannot be read/u);
	});
});
