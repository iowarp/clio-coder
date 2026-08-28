import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { asDirectoryPathBoundary } from "../../src/core/path-boundary.js";
import { loadProjectRules, selectActiveRules } from "../../src/domains/context/project-rules.js";
import type { DispatchRequest } from "../../src/domains/dispatch/contract.js";
import {
	renderDispatchIntentRequirements,
	renderDispatchReviewerTask,
} from "../../src/domains/dispatch/intent-requirements.js";
import {
	declaredScopeReplacementDiagnostic,
	declaredScopeReplacementNotice,
	resolveDispatchPathScope,
} from "../../src/domains/dispatch/path-scope.js";
import { isSubset, type ScopeSpec } from "../../src/domains/safety/scope.js";

function request(cwd: string): DispatchRequest {
	return {
		agentId: "coder",
		executionRole: "builder",
		task: "Update docs/legacy.md while working on the declared source scope.",
		cwd,
		intent: {
			version: 1,
			readRoots: ["src/config.ts"],
			writeRoots: ["src/generated/"],
			relevantPaths: ["tests/unit/"],
			expectedOutputs: [],
			verification: [],
		},
	};
}

describe("typed dispatch scope", () => {
	it("uses mixed declared paths as the canonical scope and reports replaced prose paths", () => {
		const cwd = mkdtempSync(join(tmpdir(), "clio-typed-scope-"));
		try {
			const scope = resolveDispatchPathScope(request(cwd));
			strictEqual(scope.source, "declared");
			deepStrictEqual(scope.workingContextPaths, ["src/config.ts", "src/generated/", "tests/unit/"]);
			deepStrictEqual(scope.writeBoundaries, [asDirectoryPathBoundary(join(cwd, "src/generated"))]);
			deepStrictEqual(scope.inferredOnlyPaths, ["docs/legacy.md"]);
			match(declaredScopeReplacementDiagnostic(scope) ?? "", /typed_scope_replaced_inferred_paths.*docs\/legacy\.md/u);
			deepStrictEqual(declaredScopeReplacementNotice(scope), {
				code: "typed_scope_replaced_inferred_paths",
				level: "warning",
				omittedPaths: ["docs/legacy.md"],
				message:
					"[dispatch scope] typed intent replaced prose path inference; omitted paths: docs/legacy.md. Those paths did not select project rules or expand worker authority.",
			});
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("keeps prose inference unchanged when typed intent is absent", () => {
		const legacy: DispatchRequest = {
			agentId: "coder",
			executionRole: "builder",
			task: "Update src/index.ts and docs/readme.md",
			writeRoots: ["legacy/staging"],
		};
		const scope = resolveDispatchPathScope(legacy);
		deepStrictEqual(scope.workingContextPaths, ["legacy/staging", "src/index.ts", "docs/readme.md"]);
		strictEqual(scope.source, "inferred");
		strictEqual(declaredScopeReplacementDiagnostic(scope), null);
	});

	it("matches exact files and nested directory roots without activating unrelated rules", () => {
		const cwd = mkdtempSync(join(tmpdir(), "clio-typed-rules-"));
		try {
			const rules = join(cwd, ".clio-coder", "rules");
			mkdirSync(rules, { recursive: true });
			writeFileSync(join(rules, "nested.md"), "---\npaths: ['src/**/*.ts']\n---\nNested source rule.\n", "utf8");
			writeFileSync(join(rules, "exact.md"), "---\npaths: ['docs/README.md']\n---\nExact docs rule.\n", "utf8");
			writeFileSync(join(rules, "other.md"), "---\npaths: ['scripts/**']\n---\nUnrelated rule.\n", "utf8");
			const loaded = loadProjectRules(cwd);
			deepStrictEqual(
				selectActiveRules(loaded.rules, ["src/deep/nested/"]).map((rule) => rule.id),
				["nested.md"],
			);
			deepStrictEqual(
				selectActiveRules(loaded.rules, ["docs/README.md"]).map((rule) => rule.id),
				["exact.md"],
			);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("carries expected outputs and verification into result and reviewer context as requirements", () => {
		const intent = {
			version: 1 as const,
			readRoots: [],
			writeRoots: [],
			relevantPaths: [],
			expectedOutputs: ["file provenance verdicts"],
			verification: [{ check: "typecheck", timeoutMs: 30_000 }],
		};
		const requirements = renderDispatchIntentRequirements(intent);
		ok(requirements);
		match(requirements, /requirements to satisfy and verify/u);
		match(requirements, /not evidence/u);
		match(requirements, /file provenance verdicts/u);
		match(requirements, /typecheck must pass/u);
		const reviewer = renderDispatchReviewerTask("Implement typed scope.", "builder-1", 1, intent);
		match(reviewer, /Original task.*Implement typed scope/su);
		match(reviewer, /Declared Result Requirements.*typecheck must pass/su);
	});

	it("admits only monotonic exact and subtree scope narrowing", () => {
		const root = asDirectoryPathBoundary(join(process.cwd(), "src"));
		const actions = new Set(["read", "write"] as const);
		const outer: ScopeSpec = {
			allowedActions: actions,
			allowedWriteRoots: [root],
			allowNetwork: true,
			allowDispatch: false,
		};
		const exact: ScopeSpec = {
			...outer,
			allowedWriteRoots: [join(process.cwd(), "src", "index.ts")],
		};
		const nested: ScopeSpec = {
			...outer,
			allowedWriteRoots: [asDirectoryPathBoundary(join(process.cwd(), "src", "domains"))],
		};
		strictEqual(isSubset(exact, outer), true);
		strictEqual(isSubset(nested, outer), true);
		strictEqual(isSubset(outer, exact), false);
	});
});
