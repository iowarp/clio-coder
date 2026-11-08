import { deepStrictEqual, ok } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { COMPOSITION_ROOT_LINE_CEILING, checkCompositionRoot } from "../boundaries/check-boundaries.js";

const ROOT = "src/entry/orchestrator.ts";

describe("composition root boundary (rule15)", () => {
	it("holds the orchestrator as it stands", () => {
		deepStrictEqual(checkCompositionRoot(ROOT, readFileSync(ROOT, "utf8")), []);
	});

	it("rejects a feature internal by module path or by name through a barrel", () => {
		const byPath = checkCompositionRoot(ROOT, 'import { anything } from "../domains/session/compaction/compact.js";');
		ok(byPath.some((line) => line.includes("src/domains/session/compaction/compact.ts")));
		const byName = checkCompositionRoot(ROOT, 'import { openCallScope } from "../domains/telemetry/index.js";');
		ok(byName.some((line) => line.startsWith("rule15:") && line.includes("openCallScope")));
	});

	it("allows type-only imports of a feature internal", () => {
		deepStrictEqual(
			checkCompositionRoot(
				ROOT,
				[
					'import type { CompactInput } from "../domains/session/compaction/compact.js";',
					'import { type CompactResult } from "../domains/session/compaction/compact.js";',
				].join("\n"),
			),
			[],
		);
	});

	it("rejects a new module-scope helper, declared or bound to an arrow", () => {
		for (const source of ["function routeMemory() {}", "const routeMemory = () => {};"])
			ok(checkCompositionRoot(ROOT, source).some((line) => line.includes("module-scope function routeMemory")));
		deepStrictEqual(checkCompositionRoot(ROOT, "export async function bootOrchestrator() {}"), []);
	});

	it("rejects growth past the line ceiling", () => {
		const source = "\n".repeat(COMPOSITION_ROOT_LINE_CEILING);
		ok(checkCompositionRoot(ROOT, source).some((line) => line.includes("ceiling")));
	});
});
