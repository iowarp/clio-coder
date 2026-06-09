import { notStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { DomainContext, DomainContract } from "../../src/core/domain-loader.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import {
	buildCodewiki,
	ContextDomainModule,
	computeFingerprint,
	serializeClioMd,
	writeClioState,
	writeCodewiki,
} from "../../src/domains/context/index.js";
import { compile } from "../../src/domains/prompts/compiler.js";
import { createPromptsBundle } from "../../src/domains/prompts/extension.js";
import { loadFragments } from "../../src/domains/prompts/fragment-loader.js";
import { canonicalJson, sha256 } from "../../src/domains/prompts/hash.js";

const scratchRoots: string[] = [];

afterEach(() => {
	for (const root of scratchRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function scratchProject(): string {
	const root = mkdtempSync(join(tmpdir(), "clio-prompts-"));
	scratchRoots.push(root);
	writeFileSync(join(root, "package.json"), JSON.stringify({ name: "prompt-fixture", type: "module" }), "utf8");
	mkdirSync(join(root, "src"), { recursive: true });
	writeFileSync(join(root, "src", "index.ts"), "export const promptFixtureSymbol = true;\n", "utf8");
	return root;
}

function writeClioMd(cwd: string): void {
	writeFileSync(
		join(cwd, "CLIO.md"),
		serializeClioMd({
			projectName: "Prompt Fixture",
			identity: "Prompt Fixture is a TypeScript project used to test prompt context selection.",
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

async function compileProjectPrompt(cwd: string) {
	const bus = createSafeEventBus();
	const contracts = new Map<string, DomainContract>();
	const domainContext: DomainContext = {
		bus,
		getContract<T extends DomainContract>(name: string): T | undefined {
			return contracts.get(name) as T | undefined;
		},
	};
	const contextBundle = await ContextDomainModule.createExtension(domainContext);
	contracts.set("context", contextBundle.contract);
	const promptsBundle = createPromptsBundle(domainContext);
	await promptsBundle.extension.start();
	try {
		return await promptsBundle.contract.compileForTurn({
			cwd,
			contextPolicy: {
				providerSupportsTools: true,
				activeToolCount: 3,
				userText: "audit the repository context",
				turnCount: 0,
			},
			dynamicInputs: {
				provider: "stub",
				model: "stub-model",
				providerSupportsTools: true,
				activeToolNames: ["workspace_context", "grep", "read"],
			},
		});
	} finally {
		await promptsBundle.extension.stop?.();
	}
}

describe("contracts/prompts hash", () => {
	it("sha256 returns stable, correct hashes", () => {
		strictEqual(sha256(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
		strictEqual(sha256("clio"), sha256("clio"));
		notStrictEqual(sha256("a"), sha256("b"));
	});

	it("canonicalJson normalizes keys and sorts alphabetically", () => {
		strictEqual(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
		strictEqual(canonicalJson([3, 1, 2]), "[3,1,2]");
		strictEqual(canonicalJson({ a: undefined, b: 1 }), '{"b":1}');
		strictEqual(canonicalJson(null), "null");

		throws(() => canonicalJson(Number.POSITIVE_INFINITY));
		throws(() => canonicalJson(() => 0));
	});
});

describe("contracts/prompts identity anti-leak safety", () => {
	it("loads identity.clio with correct organisation, name, and vendor rejection clauses", () => {
		const table = loadFragments();
		const identity = table.byId.get("identity.clio");
		ok(identity, "identity.clio must be registered");

		const body = identity.body;
		ok(body.includes("You are Clio"));
		ok(body.includes("IOWarp"));
		ok(!body.includes('reply: "')); // no verbatim-reply template

		// Rejects Claude, GPT, Qwen vendors to preserve persona
		ok(body.includes("not Claude"));
		ok(body.includes("GPT"));
		ok(body.includes("Qwen"));
		ok(body.includes("Anthropic"));
		ok(body.includes("OpenAI"));
	});

	it("identity.clio is static without dynamic prompt placeholders", () => {
		const table = loadFragments();
		const identity = table.byId.get("identity.clio");
		ok(identity);
		strictEqual(identity.dynamic, false);
		strictEqual(/\{\{[A-Za-z][A-Za-z0-9]*\}\}/.test(identity.body), false);
	});
});

describe("contracts/prompts compiler logic", () => {
	it("compiles template with stable composition hashes", () => {
		const table = loadFragments();
		const a = compile(table, {
			identity: "identity.clio",
			operatingContract: "operating.contract",
			safety: "safety.auto-edit",
			dynamicInputs: { provider: "p", model: "m" },
		});
		const b = compile(table, {
			identity: "identity.clio",
			operatingContract: "operating.contract",
			safety: "safety.auto-edit",
			dynamicInputs: { provider: "p", model: "m" },
		});

		strictEqual(a.renderedPromptHash, b.renderedPromptHash);
		ok(a.systemPrompt.length > 0);
		ok(a.segmentManifest.some((segment) => segment.id === "operating-contract"));
	});

	it("trims session-shell tool guidance when no tools are active", () => {
		const table = loadFragments();
		const result = compile(table, {
			identity: "identity.clio",
			operatingContract: "operating.contract",
			safety: "safety.auto-edit",
			dynamicInputs: {
				provider: "stub",
				model: "stub-model",
				providerSupportsTools: true,
				activeToolNames: [],
				toolPaletteIntent: "small_talk",
				toolPalettePhase: "initial",
				agentCatalogStable: "Clio fleet details.",
				skillsCatalog: "# Skills",
			},
		});

		ok(result.systemPrompt.includes("Active tools this turn: none"));
		strictEqual(result.systemPrompt.includes("# Agent Fleet"), false);
		strictEqual(result.systemPrompt.includes("# Skills"), false);
	});

	it("always renders the tool catalog so the model knows its full surface with no active tools", () => {
		const table = loadFragments();
		const result = compile(table, {
			identity: "identity.clio",
			operatingContract: "operating.contract",
			safety: "safety.auto-edit",
			dynamicInputs: {
				provider: "stub",
				model: "stub-model",
				providerSupportsTools: true,
				activeToolNames: [],
				toolPaletteIntent: "small_talk",
				toolPalettePhase: "initial",
				toolCatalog: "- inspect (read, grep, list): read, grep, ls\n- delegate (dispatch fleet): dispatch",
			},
		});

		ok(result.systemPrompt.includes("# Tool Catalog"));
		ok(result.systemPrompt.includes("read, grep, ls"));
		ok(result.systemPrompt.includes("dispatch"));
		// The old wording told the model to deny repository capability; it must be gone.
		strictEqual(result.systemPrompt.includes("Do not claim repository facts that require inspection"), false);
		// The catalog is part of the stable session shell, not the volatile turn fragments.
		strictEqual(
			result.dynamicPromptFragments.some((fragment) => fragment.id === "tool-catalog"),
			false,
		);
	});

	it("omits the tool catalog when the target has no tool channel", () => {
		const table = loadFragments();
		const result = compile(table, {
			identity: "identity.clio",
			operatingContract: "operating.contract",
			safety: "safety.auto-edit",
			dynamicInputs: {
				provider: "stub",
				model: "stub-model",
				providerSupportsTools: false,
				toolCatalog: "- inspect (read, grep): read, grep",
			},
		});

		strictEqual(result.systemPrompt.includes("# Tool Catalog"), false);
	});

	it("does not emit tool-gated catalogs when active tool names are absent", () => {
		const table = loadFragments();
		const result = compile(table, {
			identity: "identity.clio",
			operatingContract: "operating.contract",
			safety: "safety.auto-edit",
			dynamicInputs: {
				provider: "stub",
				model: "stub-model",
				providerSupportsTools: true,
				agentCatalogStable: "Clio fleet details.",
				skillsCatalog: '# Skills\n\n<available_skills catalog_hash="abc123">\n</available_skills>',
			},
		});

		strictEqual(result.systemPrompt.includes("# Agent Fleet"), false);
		strictEqual(result.systemPrompt.includes("# Skills"), false);
	});

	it("includes the skills catalog when read_skill is active", () => {
		const table = loadFragments();
		const result = compile(table, {
			identity: "identity.clio",
			operatingContract: "operating.contract",
			safety: "safety.auto-edit",
			dynamicInputs: {
				provider: "stub",
				model: "stub-model",
				providerSupportsTools: true,
				activeToolNames: ["read_skill"],
				toolPaletteIntent: "skill_work",
				toolPalettePhase: "editing",
				skillsCatalog: '# Skills\n\n<available_skills catalog_hash="abc123">\n</available_skills>',
			},
		});

		ok(result.systemPrompt.includes("# Skills"));
		ok(result.systemPrompt.includes("available_skills"));
	});

	it("summarizes project context across missing, CLIO-only, fresh codewiki, and stale codewiki states", async () => {
		const empty = scratchProject();
		let result = await compileProjectPrompt(empty);
		let project = result.dynamicPromptFragments.find((fragment) => fragment.id === "project-context")?.body ?? "";
		strictEqual(project.includes("CLIO.md: available"), false);
		strictEqual(project.includes("Codewiki: available"), false);
		strictEqual(project.includes("promptFixtureSymbol"), false);

		const clioOnly = scratchProject();
		writeClioMd(clioOnly);
		result = await compileProjectPrompt(clioOnly);
		project = result.dynamicPromptFragments.find((fragment) => fragment.id === "project-context")?.body ?? "";
		ok(project.includes("Project: Prompt Fixture"));
		ok(project.includes("CLIO.md: available, not preloaded in full."));
		strictEqual(project.includes("Keep prompt context compact."), false);
		strictEqual(project.includes("Codewiki: available"), false);

		const freshWiki = scratchProject();
		writeClioMd(freshWiki);
		const generatedAt = "2026-05-01T00:00:00.000Z";
		writeCodewiki(freshWiki, buildCodewiki({ cwd: freshWiki, language: "typescript", generatedAt }));
		writeClioState(freshWiki, {
			version: 1,
			projectType: "typescript",
			fingerprint: computeFingerprint(freshWiki),
			lastSessionAt: generatedAt,
			lastIndexedAt: generatedAt,
		});
		result = await compileProjectPrompt(freshWiki);
		project = result.dynamicPromptFragments.find((fragment) => fragment.id === "project-context")?.body ?? "";
		ok(project.includes("Codewiki: available for entry_points, where_is, and find_symbol."));
		strictEqual(project.includes("promptFixtureSymbol"), false);
		strictEqual(project.includes('"entries"'), false);

		const staleWiki = scratchProject();
		writeClioMd(staleWiki);
		mkdirSync(join(staleWiki, ".clio"), { recursive: true });
		writeFileSync(
			join(staleWiki, ".clio", "codewiki.json"),
			JSON.stringify({
				version: 1,
				generatedAt,
				language: "typescript",
				entries: [{ path: "src/index.ts", exports: ["legacySymbol"], imports: [], role: "entry point" }],
			}),
			"utf8",
		);
		result = await compileProjectPrompt(staleWiki);
		project = result.dynamicPromptFragments.find((fragment) => fragment.id === "project-context")?.body ?? "";
		ok(existsSync(join(staleWiki, ".clio", "codewiki.json")));
		strictEqual(project.includes("Codewiki: available"), false);
		strictEqual(project.includes("legacySymbol"), false);
	});
});
