import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
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
