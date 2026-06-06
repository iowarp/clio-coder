import { notStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { describe, it } from "node:test";
import { compile } from "../../src/domains/prompts/compiler.js";
import { loadFragments } from "../../src/domains/prompts/fragment-loader.js";
import { canonicalJson, sha256 } from "../../src/domains/prompts/hash.js";

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
			mode: "modes.default",
			safety: "safety.auto-edit",
			dynamicInputs: { provider: "p", model: "m" },
		});
		const b = compile(table, {
			identity: "identity.clio",
			mode: "modes.default",
			safety: "safety.auto-edit",
			dynamicInputs: { provider: "p", model: "m" },
		});

		strictEqual(a.renderedPromptHash, b.renderedPromptHash);
		ok(a.systemPrompt.length > 0);
	});

	it("trims session-shell tool guidance when no tools are active", () => {
		const table = loadFragments();
		const result = compile(table, {
			identity: "identity.clio",
			mode: "modes.default",
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

		ok(result.systemPrompt.includes("Active tools this turn: none."));
		strictEqual(result.systemPrompt.includes("# Agent Fleet"), false);
		strictEqual(result.systemPrompt.includes("# Skills"), false);
	});

	it("does not emit tool-gated catalogs when active tool names are absent", () => {
		const table = loadFragments();
		const result = compile(table, {
			identity: "identity.clio",
			mode: "modes.default",
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
			mode: "modes.default",
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
});
