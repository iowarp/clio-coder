import { ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { detectClioCoderRepo } from "../../src/core/clio-repo.js";
import type { DomainContext } from "../../src/core/domain-loader.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import { createPromptsBundle } from "../../src/domains/prompts/extension.js";

const dirs: string[] = [];

function makeClioRepo(): string {
	const root = mkdtempSync(join(tmpdir(), "clio-repo-awareness-"));
	dirs.push(root);
	mkdirSync(join(root, ".git"), { recursive: true });
	mkdirSync(join(root, "src", "entry"), { recursive: true });
	mkdirSync(join(root, "src", "worker"), { recursive: true });
	mkdirSync(join(root, "src", "domains", "prompts", "fragments", "identity"), { recursive: true });
	writeFileSync(
		join(root, "package.json"),
		JSON.stringify({
			name: "@iowarp/clio-coder",
			repository: { type: "git", url: "git+https://github.com/iowarp/clio-coder.git" },
		}),
	);
	writeFileSync(join(root, "src", "entry", "orchestrator.ts"), "export {};\n");
	writeFileSync(join(root, "src", "worker", "entry.ts"), "export {};\n");
	writeFileSync(join(root, "src", "domains", "prompts", "fragments", "identity", "clio.md"), "---\n");
	return root;
}

function context(): DomainContext {
	return { bus: createSafeEventBus(), getContract: () => undefined };
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Clio repo awareness", () => {
	it("detects the source repository from package, git, and source markers", () => {
		const root = makeClioRepo();
		const nested = join(root, "src", "entry");
		const detected = detectClioCoderRepo(nested);
		strictEqual(detected.isClioCoderRepo, true);
		strictEqual(detected.repoRoot, root);
	});

	it("does not rely on directory name alone", () => {
		const root = mkdtempSync(join(tmpdir(), "clio-coder-"));
		dirs.push(root);
		mkdirSync(join(root, ".git"), { recursive: true });
		writeFileSync(join(root, "package.json"), JSON.stringify({ name: "not-clio" }));
		strictEqual(detectClioCoderRepo(root).isClioCoderRepo, false);
	});

	it("appends only the tiny prompt fragment inside the Clio source tree", async () => {
		const root = makeClioRepo();
		const bundle = createPromptsBundle(context());
		await bundle.extension.start?.();
		const result = await bundle.contract.compileForTurn({
			cwd: root,
			dynamicInputs: {},
			overrideMode: "default",
			safetyLevel: "auto-edit",
		});
		ok(result.text.includes("# Clio Source Tree"), result.text);
		ok(result.text.includes("ordinary local source-code changes"), result.text);
		ok(result.text.includes("Do not publish releases, push branches, open PRs"), result.text);
		strictEqual(
			result.fragmentManifest.some((entry) => entry.id === "context.clio-repo-awareness"),
			true,
		);
	});
});
