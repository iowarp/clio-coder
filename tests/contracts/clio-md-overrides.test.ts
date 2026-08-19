import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { DomainContext } from "../../src/core/domain-loader.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import { runContextClear } from "../../src/domains/context/clear.js";
import { loadProjectClioMd, serializeClioMd } from "../../src/domains/context/clio-md.js";
import { createContextBundle } from "../../src/domains/context/extension.js";
import { renderPromptContext } from "../../src/domains/context/prompt-context.js";

function domainContext(): DomainContext {
	return {
		bus: createSafeEventBus(),
		getContract: () => undefined,
	};
}

function writeHandbook(directory: string, filename: "CLIO-CODER.md" | "CLIO-CODER.override.md", name: string): string {
	mkdirSync(directory, { recursive: true });
	const path = join(directory, filename);
	writeFileSync(
		path,
		serializeClioMd({
			projectName: name,
			identity: `${name} identity.`,
			conventions: [`${name} convention.`],
			invariants: [`${name} invariant.`],
			sections: [{ title: "Verification expectations", body: `${name} verification.` }],
		}),
		"utf8",
	);
	return path;
}

describe("contracts/CLIO-CODER.override.md", () => {
	it("replaces inherited handbooks for one subtree while preserving descendant layers and siblings", () => {
		const root = mkdtempSync(join(tmpdir(), "clio-context-override-"));
		try {
			// The root override creates a deterministic boundary if the machine running
			// the test happens to have a handbook above the temporary directory.
			const rootBoundary = writeHandbook(root, "CLIO-CODER.override.md", "Root boundary");
			const workspace = join(root, "workspace");
			const workspaceBase = writeHandbook(workspace, "CLIO-CODER.md", "Workspace");
			const app = join(workspace, "app");
			const shadowedAppBase = writeHandbook(app, "CLIO-CODER.md", "Shadowed app base");
			const appOverride = writeHandbook(app, "CLIO-CODER.override.md", "App override");
			const child = join(app, "child");
			const childBase = writeHandbook(child, "CLIO-CODER.md", "Child");
			const sibling = join(workspace, "sibling");
			const siblingBase = writeHandbook(sibling, "CLIO-CODER.md", "Sibling");

			const childLoaded = loadProjectClioMd(child);
			deepStrictEqual(
				childLoaded.files.map((file) => file.path),
				[appOverride, childBase],
			);
			strictEqual(childLoaded.errors.length, 0);
			deepStrictEqual(childLoaded.value?.conventions, ["App override convention.", "Child convention."]);
			deepStrictEqual(childLoaded.value?.invariants, ["App override invariant.", "Child invariant."]);

			const prompt = renderPromptContext(child);
			ok(prompt.text.includes(`<project-context path="${appOverride}">`));
			ok(prompt.text.includes(`<project-context path="${childBase}">`));
			ok(prompt.text.includes("App override identity."));
			ok(prompt.text.includes("Child identity."));
			ok(!prompt.text.includes("Root boundary identity."));
			ok(!prompt.text.includes("Workspace identity."));
			ok(!prompt.text.includes("Shadowed app base identity."));

			const structured = createContextBundle(domainContext()).contract.projectStructuredContext(child);
			strictEqual(structured?.projectName, "Child");
			deepStrictEqual(structured?.conventions, ["App override convention.", "Child convention."]);
			deepStrictEqual(structured?.invariants, ["App override invariant.", "Child invariant."]);
			strictEqual(structured?.verificationExpectations, "App override verification.\n\nChild verification.");

			const siblingLoaded = loadProjectClioMd(sibling);
			deepStrictEqual(
				siblingLoaded.files.map((file) => file.path),
				[rootBoundary, workspaceBase, siblingBase],
			);
			ok(siblingLoaded.value?.identity.includes("Root boundary identity."));
			ok(siblingLoaded.value?.identity.includes("Workspace identity."));
			ok(siblingLoaded.value?.identity.includes("Sibling identity."));
			ok(!siblingLoaded.value?.identity.includes("App override identity."));
			ok(existsSync(shadowedAppBase), "resolution must not mutate the shadowed handbook");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("fails closed when an override is malformed instead of reactivating inherited or same-directory content", () => {
		const root = mkdtempSync(join(tmpdir(), "clio-context-override-malformed-"));
		try {
			writeHandbook(root, "CLIO-CODER.override.md", "Root boundary");
			const app = join(root, "app");
			const appBase = writeHandbook(app, "CLIO-CODER.md", "App base");
			const override = join(app, "CLIO-CODER.override.md");
			writeFileSync(override, "# Malformed override\n", "utf8");

			const loaded = loadProjectClioMd(app);
			strictEqual(loaded.files.length, 0);
			strictEqual(loaded.errors.length, 1);
			strictEqual(loaded.errors[0]?.path, override);
			strictEqual(loaded.value, null);

			const prompt = renderPromptContext(app);
			strictEqual(prompt.clioMd, null);
			ok(prompt.warnings.some((warning) => warning.includes(override)));
			ok(!prompt.text.includes("Root boundary identity."));
			ok(!prompt.text.includes("App base identity."));

			rmSync(override);
			deepStrictEqual(
				loadProjectClioMd(app).files.map((file) => file.path),
				[join(root, "CLIO-CODER.override.md"), appBase],
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps the local override human-owned even when reset --all removes the local base handbook", async () => {
		const root = mkdtempSync(join(tmpdir(), "clio-context-override-reset-"));
		try {
			const base = writeHandbook(root, "CLIO-CODER.md", "Base");
			const override = writeHandbook(root, "CLIO-CODER.override.md", "Override");
			const result = await runContextClear({
				cwd: root,
				all: true,
				confirmContext: () => true,
				confirmAll: () => true,
			});
			strictEqual(existsSync(base), false);
			strictEqual(existsSync(override), true);
			ok(result.removed.includes("CLIO-CODER.md"));
			ok(result.preserved.includes("CLIO-CODER.override.md"));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
