import { ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { DomainContext, DomainContract } from "../../src/core/domain-loader.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import { ContextDomainModule, serializeClioMd } from "../../src/domains/context/index.js";
import { createPromptsBundle } from "../../src/domains/prompts/extension.js";
import { createResourcesBundle } from "../../src/domains/resources/extension.js";
import { createResourcesLoader } from "../../src/domains/resources/loader.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const scratchRoots: string[] = [];

afterEach(() => {
	for (const root of scratchRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function scratchProject(): string {
	const root = mkdtempSync(join(tmpdir(), "clio-resources-s5-"));
	scratchRoots.push(root);
	writeFileSync(join(root, "package.json"), JSON.stringify({ name: "s5-fixture", type: "module" }), "utf8");
	mkdirSync(join(root, "src"), { recursive: true });
	writeFileSync(join(root, "src", "index.ts"), "export const s5FixtureSymbol = true;\n", "utf8");
	return root;
}

function writeClioMd(cwd: string): void {
	writeFileSync(
		join(cwd, "CLIO-CODER.md"),
		serializeClioMd({
			projectName: "S5 Fixture",
			identity: "S5 Fixture is a TypeScript project used to verify project-context suppression.",
			conventions: ["Keep prompt context compact."],
			invariants: [],
			fingerprint: {
				initAt: "2026-05-01T00:00:00.000Z",
				model: "test",
				gitHead: null,
				treeHash: "0".repeat(64),
				loc: 1,
			},
		}),
		"utf8",
	);
}

function domainContext(): { context: DomainContext; contracts: Map<string, DomainContract> } {
	const bus = createSafeEventBus();
	const contracts = new Map<string, DomainContract>();
	const context: DomainContext = {
		bus,
		getContract<T extends DomainContract>(name: string): T | undefined {
			return contracts.get(name) as T | undefined;
		},
	};
	return { context, contracts };
}

async function compileProjectPrompt(cwd: string, noContextFiles: boolean): Promise<string> {
	const { context, contracts } = domainContext();
	const contextBundle = await ContextDomainModule.createExtension(context);
	contracts.set("context", contextBundle.contract);
	const promptsBundle = createPromptsBundle(context, noContextFiles ? { noContextFiles: true } : {});
	await promptsBundle.extension.start();
	try {
		const result = await promptsBundle.contract.compileSessionPrompt({
			cwd,
			sessionInputs: {
				provider: "stub",
				model: "stub-model",
				providerSupportsTools: true,
			},
		});
		return result.systemPrompt;
	} finally {
		await promptsBundle.extension.stop?.();
	}
}

describe("contracts/resources context-file loader deletion (S5)", () => {
	it("the dead resources context-file loader and instruction-merge modules are gone", () => {
		strictEqual(existsSync(join(repoRoot, "src", "domains", "resources", "context-files", "loader.ts")), false);
		strictEqual(existsSync(join(repoRoot, "src", "domains", "resources", "context-files")), false);
		strictEqual(existsSync(join(repoRoot, "src", "domains", "prompts", "instruction-merge.ts")), false);
	});

	it("ResourcesContract no longer declares contextFiles / renderContextFiles", () => {
		const { context } = domainContext();
		const { contract } = createResourcesBundle(context);
		strictEqual("contextFiles" in contract, false);
		strictEqual("renderContextFiles" in contract, false);
		// Sanity: the live surface survives.
		strictEqual(typeof contract.skills, "function");
		strictEqual(typeof contract.expandSkillInvocation, "function");
	});

	it("the resources loader no longer exposes context-file methods", () => {
		const loader = createResourcesLoader();
		strictEqual("contextFiles" in loader, false);
		strictEqual("renderContextFiles" in loader, false);
		strictEqual(typeof loader.skills, "function");
	});

	it("without --no-context-files the compiled prompt injects CLIO-CODER.md project context", async () => {
		const cwd = scratchProject();
		writeClioMd(cwd);
		const prompt = await compileProjectPrompt(cwd, false);
		ok(prompt.includes("# S5 Fixture"), "project-context section present by default");
		ok(prompt.includes("Keep prompt context compact."));
	});

	it("clio-coder --no-context-files still suppresses CLIO-CODER.md project-context injection", async () => {
		const cwd = scratchProject();
		writeClioMd(cwd);
		const prompt = await compileProjectPrompt(cwd, true);
		strictEqual(prompt.includes("# S5 Fixture"), false);
		strictEqual(prompt.includes("Keep prompt context compact."), false);
	});
});
