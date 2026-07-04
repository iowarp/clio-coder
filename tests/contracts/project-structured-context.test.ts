import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { DomainContext } from "../../src/core/domain-loader.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import { createContextBundle } from "../../src/domains/context/extension.js";

function context(): DomainContext {
	return {
		bus: createSafeEventBus(),
		getContract: () => undefined,
	};
}

function writeClioMd(cwd: string, extraSections: string): void {
	writeFileSync(
		join(cwd, "CLIO.md"),
		[
			"# Fixture Project",
			"",
			"A fixture handbook for the structured-context projection.",
			"",
			"## Conventions",
			"",
			"- Tabs, line width 120.",
			"",
			"## Hard invariants",
			"",
			"1. Only src/engine imports the pi SDK.",
			extraSections,
			"",
		].join("\n"),
		"utf8",
	);
}

describe("contracts/context projectStructuredContext", () => {
	it("projects the Verification expectations section body by exact title", () => {
		const cwd = mkdtempSync(join(tmpdir(), "clio-structured-context-"));
		try {
			writeClioMd(
				cwd,
				["", "## Verification expectations", "", "Run `npm run typecheck` and `npm run lint` before handoff."].join("\n"),
			);
			const bundle = createContextBundle(context());
			const project = bundle.contract.projectStructuredContext(cwd);
			ok(project);
			strictEqual(project?.projectName, "Fixture Project");
			deepStrictEqual(project?.conventions, ["Tabs, line width 120."]);
			deepStrictEqual(project?.invariants, ["Only src/engine imports the pi SDK."]);
			strictEqual(project?.verificationExpectations, "Run `npm run typecheck` and `npm run lint` before handoff.");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("matches the section title case-insensitively and only that title", () => {
		const cwd = mkdtempSync(join(tmpdir(), "clio-structured-context-"));
		try {
			writeClioMd(
				cwd,
				[
					"",
					"## Workflow traps",
					"",
					"Never projected to workers.",
					"",
					"## VERIFICATION EXPECTATIONS",
					"",
					"Case-insensitive body.",
				].join("\n"),
			);
			const bundle = createContextBundle(context());
			const project = bundle.contract.projectStructuredContext(cwd);
			strictEqual(project?.verificationExpectations, "Case-insensitive body.");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("omits the field when the handbook has no such section", () => {
		const cwd = mkdtempSync(join(tmpdir(), "clio-structured-context-"));
		try {
			writeClioMd(cwd, "");
			const bundle = createContextBundle(context());
			const project = bundle.contract.projectStructuredContext(cwd);
			ok(project);
			strictEqual("verificationExpectations" in (project ?? {}), false);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
