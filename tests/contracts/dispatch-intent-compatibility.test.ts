import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import {
	type DispatchIntent,
	type DispatchIntentCheckBound,
	declaredScopeIntent,
	isDispatchIntent,
	narrowDispatchIntentToReadOnly,
	normalizeDispatchIntent,
} from "../../src/domains/dispatch/intent.js";
import {
	classifyDispatchIntentCompatibility,
	DISPATCH_INTENT_RETIREMENT_MAX_LEGACY_SHARE,
	DISPATCH_INTENT_RETIREMENT_MIN_SAMPLE,
	DISPATCH_INTENT_SUPPORTED_VERSIONS,
	DISPATCH_INTENT_VERSION,
	type DispatchIntentCompatibilityCode,
	dispatchIntentAdoption,
	dispatchIntentRefusals,
	dispatchIntentScopeWidening,
	isSupportedDispatchIntentVersion,
} from "../../src/domains/dispatch/intent-compatibility.js";
import { declaredIntentPathProvenance, resolveDispatchPathScope } from "../../src/domains/dispatch/path-scope.js";
import { validateJobSpec } from "../../src/domains/dispatch/validation.js";
import { createDispatchTool } from "../../src/tools/dispatch.js";
import { dispatchRequestsFromArgs } from "../../src/tools/dispatch-arguments.js";
import { resolvedDispatchPlanFromArgs } from "../../src/tools/dispatch-plan.js";
import { isolateDispatchState, makeDispatchBundle, restoreDispatchState } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";

const CHECKS = new Map<string, DispatchIntentCheckBound>([["typecheck", { id: "typecheck", timeoutMs: 60_000 }]]);

function intent(fields: Partial<Omit<DispatchIntent, "version" | "pathProvenance">> = {}): DispatchIntent {
	const readRoots = fields.readRoots ?? [];
	const writeRoots = fields.writeRoots ?? [];
	const relevantPaths = fields.relevantPaths ?? [];
	return {
		version: 2,
		readRoots,
		writeRoots,
		relevantPaths,
		pathProvenance: declaredIntentPathProvenance({ readRoots, writeRoots, relevantPaths }),
		expectedOutputs: fields.expectedOutputs ?? [],
		verification: fields.verification ?? [],
	};
}

function codes(findings: ReadonlyArray<{ code: DispatchIntentCompatibilityCode }>): DispatchIntentCompatibilityCode[] {
	return findings.map((entry) => entry.code);
}

describe("typed dispatch intent compatibility", () => {
	it("accepts an omitted intent as a warning and never as a refusal", () => {
		const findings = classifyDispatchIntentCompatibility({ writeRoots: ["src/generated"] });
		deepStrictEqual(codes(findings), ["intent_absent_legacy_inference"]);
		strictEqual(findings[0]?.decision, "warn");
		deepStrictEqual(dispatchIntentRefusals(findings), []);
		match(findings[0].message, /never widen write or verification authority/u);
	});

	it("accepts a complete declaration without any finding", () => {
		deepStrictEqual(
			classifyDispatchIntentCompatibility({
				intent: intent({
					writeRoots: ["src/generated/"],
					expectedOutputs: ["src/generated/index.ts"],
					verification: [{ check: "typecheck", timeoutMs: 60_000 }],
				}),
			}),
			[],
		);
	});

	it("warns on a partial declaration that changes the tree without a verification requirement", () => {
		const findings = classifyDispatchIntentCompatibility({ intent: intent({ writeRoots: ["src/generated/"] }) });
		deepStrictEqual(codes(findings), ["intent_partial_verification_absent"]);
		strictEqual(findings[0]?.decision, "warn");
		deepStrictEqual(dispatchIntentRefusals(findings), []);
	});

	it("refuses a stale intent version rather than migrating it", () => {
		const stale = { ...intent({ readRoots: ["src/"] }), version: 1 };
		const findings = classifyDispatchIntentCompatibility({ intent: stale });
		deepStrictEqual(codes(findings), ["intent_version_unsupported"]);
		strictEqual(findings[0]?.decision, "refuse");
		match(findings[0].message, /refused rather than migrated/u);
		strictEqual(isSupportedDispatchIntentVersion(stale), false);
		strictEqual(isSupportedDispatchIntentVersion(intent()), true);
	});

	it("refuses an intent shaped object that carries no version at all", () => {
		const { version: _version, ...versionless } = intent({ readRoots: ["src/"] });
		const findings = classifyDispatchIntentCompatibility({ intent: versionless });
		deepStrictEqual(codes(findings), ["intent_version_unsupported"]);
	});

	it("refuses contradictory write declarations without unioning them", () => {
		const cwd = mkdtempSync(join(tmpdir(), "clio-intent-compat-"));
		try {
			const findings = classifyDispatchIntentCompatibility({
				intent: intent({ writeRoots: ["src/generated/"], verification: [{ check: "typecheck", timeoutMs: 1_000 }] }),
				writeRoots: ["docs"],
				cwd,
			});
			deepStrictEqual(codes(findings), ["intent_write_roots_contradiction"]);
			strictEqual(findings[0]?.decision, "refuse");
			match(findings[0].message, /Neither the union nor the legacy field wins/u);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("accepts write declarations that agree after resolution", () => {
		const cwd = mkdtempSync(join(tmpdir(), "clio-intent-compat-"));
		try {
			deepStrictEqual(
				classifyDispatchIntentCompatibility({
					intent: intent({ writeRoots: ["src/generated/"], verification: [{ check: "typecheck", timeoutMs: 1_000 }] }),
					writeRoots: ["src/generated/"],
					cwd,
				}),
				[],
			);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("refuses an expected output the declared write boundary would block", () => {
		const findings = classifyDispatchIntentCompatibility({
			intent: intent({
				writeRoots: ["src/generated/"],
				expectedOutputs: ["docs/report.md"],
				verification: [{ check: "typecheck", timeoutMs: 1_000 }],
			}),
		});
		deepStrictEqual(codes(findings), ["intent_outputs_outside_write_roots"]);
		strictEqual(findings[0]?.decision, "refuse");
	});

	it("refuses declared write roots on a read-only request", () => {
		const findings = classifyDispatchIntentCompatibility({
			intent: intent({ writeRoots: ["src/"], verification: [{ check: "typecheck", timeoutMs: 1_000 }] }),
			autonomy: "read-only",
		});
		deepStrictEqual(codes(findings), ["intent_write_without_authority"]);
	});

	it("demotes write roots to read roots when a declaration is projected onto a read-only run", () => {
		const narrowed = narrowDispatchIntentToReadOnly(
			intent({ readRoots: ["src/config.ts"], writeRoots: ["src/generated/"], relevantPaths: ["tests/unit/"] }),
		);
		deepStrictEqual(narrowed.writeRoots, []);
		deepStrictEqual(narrowed.readRoots, ["src/config.ts", "src/generated/"]);
		deepStrictEqual(
			narrowed.pathProvenance,
			declaredIntentPathProvenance({
				readRoots: ["src/config.ts", "src/generated/"],
				writeRoots: [],
				relevantPaths: ["tests/unit/"],
			}),
		);
		deepStrictEqual(classifyDispatchIntentCompatibility({ intent: narrowed, autonomy: "read-only" }), []);
	});

	it("refuses a narrowed scope that reaches outside its ceiling and admits one that shrinks it", () => {
		const ceiling = intent({ readRoots: ["src/"], writeRoots: ["src/generated/"], relevantPaths: [] });
		strictEqual(dispatchIntentScopeWidening(ceiling, intent({ readRoots: ["src/domains/"] })), null);
		strictEqual(dispatchIntentScopeWidening(ceiling, intent({ writeRoots: ["src/generated/api.ts"] })), null);
		const widened = dispatchIntentScopeWidening(ceiling, intent({ writeRoots: ["docs/"] }));
		strictEqual(widened?.code, "intent_scope_widening");
		strictEqual(widened.decision, "refuse");
		match(widened.message, /may shrink the ceiling and never reach outside it/u);
	});

	it("classifies identically without reading the filesystem or the package layout", () => {
		const source = process.cwd();
		const elsewhere = mkdtempSync(join(tmpdir(), "clio-intent-installed-"));
		try {
			const stale = { ...intent({ readRoots: ["src/"] }), version: 99 };
			deepStrictEqual(
				classifyDispatchIntentCompatibility({ intent: stale, cwd: source }),
				classifyDispatchIntentCompatibility({ intent: stale, cwd: elsewhere }),
			);
			deepStrictEqual(DISPATCH_INTENT_SUPPORTED_VERSIONS, [DISPATCH_INTENT_VERSION]);
		} finally {
			rmSync(elsewhere, { recursive: true, force: true });
		}
	});

	it("keeps the version rules free of anything a package layout could change", () => {
		// A source checkout, a global npm install, and a bundled dist/ must
		// classify the same input identically. That holds only while the rules
		// read no file, resolve no module URL, and consult no environment: the
		// supported set has to stay a compiled-in constant rather than a lookup.
		const source = readFileSync(new URL("../../src/domains/dispatch/intent-compatibility.ts", import.meta.url), "utf8");
		for (const forbidden of ["node:fs", "node:module", "node:url", "import.meta", "process.env", "createRequire"]) {
			strictEqual(source.includes(forbidden), false, `intent-compatibility.ts must not reference ${forbidden}`);
		}
	});
});

describe("non-model producers declaring typed scope", () => {
	it("normalizes producer-declared paths exactly as a model-facing declaration is normalized", () => {
		const built = declaredScopeIntent({ relevantPaths: ["docs/b.md", " src/a.ts ", "src/a.ts", "tests/"] });
		ok(built.ok);
		deepStrictEqual(built.intent.relevantPaths, ["docs/b.md", "src/a.ts", "tests/"]);
		deepStrictEqual(built.intent.writeRoots, []);
		deepStrictEqual(built.intent.expectedOutputs, []);
		deepStrictEqual(built.intent.verification, []);
		strictEqual(isDispatchIntent(built.intent), true);
		deepStrictEqual(classifyDispatchIntentCompatibility({ intent: built.intent }), []);
	});

	it("refuses producer paths that escape the repository instead of accepting them", () => {
		const escaping = declaredScopeIntent({ relevantPaths: ["../outside"] });
		ok(!escaping.ok);
		strictEqual(escaping.reason, "intent_path_escapes_root");
		const absolute = declaredScopeIntent({ writeRoots: ["/etc"] });
		ok(!absolute.ok);
		strictEqual(absolute.reason, "intent_path_absolute");
	});

	it("resolves a fleet step's declared scope as declared rather than inferred", () => {
		const built = declaredScopeIntent({ relevantPaths: ["src/generated/"] });
		ok(built.ok);
		const scope = resolveDispatchPathScope({
			agentId: "coder",
			executionRole: "builder",
			task: "Regenerate the client described in docs/plan.md.",
			intent: built.intent,
		});
		strictEqual(scope.source, "declared");
		deepStrictEqual(scope.workingContextPaths, ["src/generated/"]);
		// The contract's own boundary stays with the fleet enforcer: declared
		// scope never becomes a second per-tool write grant.
		deepStrictEqual(scope.writeBoundaries, []);
		deepStrictEqual(scope.inferredOnlyPaths, ["docs/plan.md"]);
	});
});

describe("typed dispatch intent job-spec admission", () => {
	it("admits a legacy spec that declares no intent", () => {
		const result = validateJobSpec({ agentId: "coder", task: "Update the generated client", writeRoots: ["src"] });
		strictEqual(result.ok, true);
	});

	it("refuses a stale intent version on any producer's spec", () => {
		const result = validateJobSpec({
			agentId: "coder",
			task: "Update the generated client",
			intent: { ...intent({ readRoots: ["src/"] }), version: 1 },
		});
		strictEqual(result.ok, false);
		ok(result.ok === false);
		ok(result.errors.some((error) => error.startsWith("intent_version_unsupported:")));
	});

	it("refuses contradictory write declarations on any producer's spec", () => {
		const result = validateJobSpec({
			agentId: "coder",
			task: "Update the generated client",
			cwd: process.cwd(),
			writeRoots: ["docs"],
			intent: intent({ writeRoots: ["src/generated/"], verification: [{ check: "typecheck", timeoutMs: 1_000 }] }),
		});
		strictEqual(result.ok, false);
		ok(result.ok === false);
		ok(result.errors.some((error) => error.startsWith("intent_write_roots_contradiction:")));
	});

	it("gives the model-facing parser the same verdict and the same wording as the validator", () => {
		// The parser used to compare the two write declarations as raw strings and
		// answer with a bare reason code. That disagreed with the validator, which
		// compares resolved boundaries, and it carried no fix for the caller.
		const parse = (writeRoots: ReadonlyArray<string>) =>
			dispatchRequestsFromArgs(
				{ tasks: [{ task: "Regenerate the client" }], intent: { write_roots: ["src/generated"] }, writeRoots },
				{
					auto: { approvedAuthorities: [], authorityBasis: "operator-plan-approval" },
					resolveIntent: (raw) => {
						const normalized = normalizeDispatchIntent(raw, CHECKS);
						if (!normalized.ok) return { ok: false, message: `${normalized.reason}: ${normalized.message}` };
						return { ok: true, intent: normalized.intent, resolvedVerification: [] };
					},
				},
			);

		// Two spellings of one tree are one declaration, not a contradiction.
		const equivalent = parse(["./src/generated"]);
		strictEqual(equivalent.ok, true);

		const contradictory = parse(["docs"]);
		strictEqual(contradictory.ok, false);
		ok(contradictory.ok === false);
		match(contradictory.message, /intent_write_roots_contradiction: /u);
		match(contradictory.message, /Neither the union nor the legacy field wins/u);

		// The validator reaches the same two verdicts on the same two pairs.
		const spec = (writeRoots: ReadonlyArray<string>) =>
			validateJobSpec({
				agentId: "coder",
				task: "Regenerate the client",
				cwd: process.cwd(),
				writeRoots,
				intent: intent({ writeRoots: ["src/generated"] }),
			});
		strictEqual(spec(["./src/generated"]).ok, true);
		strictEqual(spec(["docs"]).ok, false);
	});

	it("never widens the effective write roots to resolve an ambiguity", () => {
		const result = validateJobSpec({
			agentId: "coder",
			task: "Update the generated client",
			cwd: process.cwd(),
			intent: intent({ writeRoots: ["src/generated/"], verification: [{ check: "typecheck", timeoutMs: 1_000 }] }),
		});
		ok(result.ok === true);
		deepStrictEqual(result.spec.writeRoots, [`${join(process.cwd(), "src/generated")}/`]);
	});
});

describe("council admission narrowing", () => {
	beforeEach(async () => {
		await isolateDispatchState();
	});
	afterEach(() => {
		restoreDispatchState();
	});

	it("seals read roots, not write roots, onto every council member the plan approves", async () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.targets = [{ id: "primary", runtime: "openai", defaultModel: "base-model" }];
		settings.fleet.default.target = "primary";
		settings.fleet.default.model = "base-model";
		const bundle = makeDispatchBundle(dispatchStubContext({ settings }), {
			previewNode: () => ({ node: { id: "local", kind: "local" } }),
		});
		await bundle.extension.start();
		try {
			const tool = createDispatchTool({
				getAgentSpecs: () => [],
				dispatch: bundle.contract,
				getAutonomy: () => "full-auto",
			});
			const prepared = tool.prepareAdmissionArguments?.({
				mode: "council",
				task: "Assess the dispatch scope contract",
				members: [
					{ label: "one", target: "primary" },
					{ label: "two", target: "primary" },
				],
				intent: { read_roots: ["docs/"], write_roots: ["src/domains/dispatch/"] },
			});
			ok(prepared);
			// A preparation failure would leave no resolved plan and silently pass
			// every assertion below, so the refusal channel is checked first.
			strictEqual(prepared.__clio_dispatch_plan_preparation_error, undefined);
			const tasks = resolvedDispatchPlanFromArgs(prepared)?.tasks ?? [];
			const members = tasks.filter((task) => task.role === "member");
			strictEqual(members.length, 2);
			for (const member of members) {
				ok(member.intent, "a council member inherits the caller's declaration");
				deepStrictEqual(member.intent.writeRoots, [], "a read-only member never carries a write scope");
				deepStrictEqual(member.intent.readRoots, ["docs/", "src/domains/dispatch/"]);
				// The same trees, so rule selection and worker context are unchanged.
				deepStrictEqual(
					member.intent.pathProvenance.map((entry) => entry.path),
					["docs/", "src/domains/dispatch/"],
				);
			}
		} finally {
			await bundle.extension.stop?.();
		}
	});
});

describe("typed dispatch intent raw normalization", () => {
	it("accepts an echoed supported version", () => {
		const normalized = normalizeDispatchIntent({ version: 2, read_roots: ["src/"] }, CHECKS);
		ok(normalized.ok);
		strictEqual(normalized.intent.version, 2);
	});

	it("refuses an unsupported declared version with the stable reason code", () => {
		const normalized = normalizeDispatchIntent({ version: 1, read_roots: ["src/"] }, CHECKS);
		ok(!normalized.ok);
		strictEqual(normalized.reason, "intent_version_unsupported");
		match(normalized.message, /refused rather than migrated/u);
	});
});

describe("legacy inference retirement criterion", () => {
	it("reports no share when nothing was measured", () => {
		deepStrictEqual(dispatchIntentAdoption([]), {
			measured: 0,
			declared: 0,
			legacyInferred: 0,
			legacyShare: null,
			retirementReady: false,
		});
	});

	it("counts only receipts that sealed a resolved path scope", () => {
		const adoption = dispatchIntentAdoption([
			{ pathScope: { mode: "declared" } },
			{ pathScope: { mode: "legacy-inferred" } },
			{},
		]);
		strictEqual(adoption.measured, 2);
		strictEqual(adoption.declared, 1);
		strictEqual(adoption.legacyInferred, 1);
		strictEqual(adoption.legacyShare, 0.5);
		strictEqual(adoption.retirementReady, false);
	});

	it("is ready only at or under the legacy bound with a large enough sample", () => {
		const legacy = Math.floor(DISPATCH_INTENT_RETIREMENT_MIN_SAMPLE * DISPATCH_INTENT_RETIREMENT_MAX_LEGACY_SHARE);
		const receipts = [
			...Array.from({ length: DISPATCH_INTENT_RETIREMENT_MIN_SAMPLE - legacy }, () => ({
				pathScope: { mode: "declared" as const },
			})),
			...Array.from({ length: legacy }, () => ({ pathScope: { mode: "legacy-inferred" as const } })),
		];
		strictEqual(dispatchIntentAdoption(receipts).retirementReady, true);
		strictEqual(dispatchIntentAdoption(receipts.slice(0, 10)).retirementReady, false);
		strictEqual(
			dispatchIntentAdoption([...receipts, { pathScope: { mode: "legacy-inferred" as const } }]).retirementReady,
			false,
		);
	});
});
