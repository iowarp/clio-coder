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
import type { DispatchContract } from "../../src/domains/dispatch/contract.js";
import { compile } from "../../src/domains/prompts/compiler.js";
import { createPromptsBundle } from "../../src/domains/prompts/extension.js";
import { loadFragments } from "../../src/domains/prompts/fragment-loader.js";
import { canonicalJson, sha256 } from "../../src/domains/prompts/hash.js";
import { emptyWorkspaceSnapshot } from "../../src/domains/session/workspace/index.js";
import { createDispatchTool } from "../../src/tools/dispatch.js";
import { workspaceContextTool } from "../../src/tools/workspace-context.js";

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
		return await promptsBundle.contract.compileSessionPrompt({
			cwd,
			sessionInputs: {
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

async function compileProjectPromptWithWorkingPaths(cwd: string, workingContextPaths: ReadonlyArray<string>) {
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
		return await promptsBundle.contract.compileSessionPrompt({
			cwd,
			workingContextPaths,
			sessionInputs: {
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
	it("compiles deterministically: same inputs, same prompt, same hash", () => {
		const table = loadFragments();
		const a = compile(table, {
			identity: "identity.clio",
			operatingContract: "operating.contract",
			safety: "safety.auto-edit",
			sessionInputs: { provider: "p", model: "m" },
		});
		const b = compile(table, {
			identity: "identity.clio",
			operatingContract: "operating.contract",
			safety: "safety.auto-edit",
			sessionInputs: { provider: "p", model: "m" },
		});

		strictEqual(a.systemPromptHash, b.systemPromptHash);
		strictEqual(a.systemPrompt, b.systemPrompt);
		ok(a.systemPrompt.length > 0);
		ok(a.tokenEstimate > 0);
		ok(a.sections.some((section) => section.id === "operating-contract"));
	});

	it("compiles at every autonomy level, including read-only", () => {
		const table = loadFragments();
		for (const level of ["read-only", "suggest", "auto-edit", "full-auto"]) {
			const result = compile(table, {
				identity: "identity.clio",
				operatingContract: "operating.contract",
				safety: `safety.${level}`,
				sessionInputs: { provider: "p", model: "m" },
			});
			ok(result.systemPrompt.includes(`Autonomy: ${level}.`), `one-liner for ${level}`);
		}
	});

	it("renders no per-turn state: tool-free phrasing is an instruction, not a prompt change", () => {
		const table = loadFragments();
		const result = compile(table, {
			identity: "identity.clio",
			operatingContract: "operating.contract",
			safety: "safety.auto-edit",
			sessionInputs: {
				provider: "stub",
				model: "stub-model",
				providerSupportsTools: true,
				activeToolNames: ["read", "grep"],
			},
		});

		// The prompt never claims schemas were detached for a turn; the session
		// surface is fixed and the model simply follows a tool-free instruction.
		strictEqual(result.systemPrompt.includes("No tool schemas are attached this turn"), false);
		ok(result.systemPrompt.includes("If the user asks for a tool-free answer"));
	});

	it("discloses catalogs through tools instead of rendering them into the prompt", () => {
		const table = loadFragments();
		const result = compile(table, {
			identity: "identity.clio",
			operatingContract: "operating.contract",
			safety: "safety.auto-edit",
			sessionInputs: {
				provider: "stub",
				model: "stub-model",
				providerSupportsTools: true,
				activeToolNames: ["read", "grep", "read_skill", "dispatch"],
			},
		});

		strictEqual(result.systemPrompt.includes("# Agent Fleet"), false);
		strictEqual(result.systemPrompt.includes("available_skills"), false);
		strictEqual(
			result.sections.some((section) => section.id === "tools-and-agents"),
			false,
		);
		strictEqual(
			result.sections.some((section) => section.id === "skills-catalog"),
			false,
		);
		ok(result.systemPrompt.includes("Call read_skill with no name to list available skills"));
		ok(result.systemPrompt.includes("Call dispatch with list:true"));
	});

	it("omits the catalog one-liners when read_skill and dispatch are not in the session surface", () => {
		const table = loadFragments();
		const result = compile(table, {
			identity: "identity.clio",
			operatingContract: "operating.contract",
			safety: "safety.auto-edit",
			sessionInputs: {
				provider: "stub",
				model: "stub-model",
				providerSupportsTools: true,
				activeToolNames: ["read", "grep"],
			},
		});

		strictEqual(result.systemPrompt.includes("read_skill with no name"), false);
		strictEqual(result.systemPrompt.includes("list:true"), false);
	});

	it("never renders volatile runtime state into the prompt", () => {
		const table = loadFragments();
		const result = compile(table, {
			identity: "identity.clio",
			operatingContract: "operating.contract",
			safety: "safety.auto-edit",
			sessionInputs: {
				provider: "stub",
				model: "stub-model",
				providerSupportsTools: true,
				activeToolNames: ["read", "grep", "dispatch", "read_skill", "ask_user"],
			},
		});
		strictEqual(result.systemPrompt.includes("send policy"), false);
		strictEqual(result.systemPrompt.includes("Prompt send policy"), false);
		strictEqual(result.systemPrompt.includes("Thinking applied"), false);
		strictEqual(result.systemPrompt.includes("Thinking level"), false);
	});

	it("describes ask_user interview behavior only when ask_user is in the session surface", () => {
		const table = loadFragments();
		const active = compile(table, {
			identity: "identity.clio",
			operatingContract: "operating.contract",
			safety: "safety.auto-edit",
			sessionInputs: {
				provider: "stub",
				model: "stub-model",
				providerSupportsTools: true,
				activeToolNames: ["read_skill", "ask_user"],
			},
		});
		ok(active.systemPrompt.includes("first call read_skill for that skill"));
		ok(active.systemPrompt.includes("Use ask_user for operator interviews"));
		ok(active.systemPrompt.includes("If cancelled, continue with defaults"));

		const inactive = compile(table, {
			identity: "identity.clio",
			operatingContract: "operating.contract",
			safety: "safety.auto-edit",
			sessionInputs: {
				provider: "stub",
				model: "stub-model",
				providerSupportsTools: true,
				activeToolNames: ["read_skill"],
			},
		});
		strictEqual(inactive.systemPrompt.includes("Use ask_user for operator interviews"), false);
	});

	it("summarizes project context across missing, CLIO-only, fresh codewiki, and stale codewiki states", async () => {
		const empty = scratchProject();
		let result = await compileProjectPrompt(empty);
		strictEqual(result.systemPrompt.includes("CLIO.md: available"), false);
		strictEqual(result.systemPrompt.includes("Codewiki: available"), false);
		strictEqual(result.systemPrompt.includes("promptFixtureSymbol"), false);

		const clioOnly = scratchProject();
		writeClioMd(clioOnly);
		result = await compileProjectPrompt(clioOnly);
		ok(result.systemPrompt.includes("# Prompt Fixture"));
		ok(result.systemPrompt.includes("Keep prompt context compact."));
		strictEqual(result.systemPrompt.includes("Codewiki: available"), false);

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
		ok(result.systemPrompt.includes("<codewiki>available; use code_nav</codewiki>"));
		strictEqual(result.systemPrompt.includes("promptFixtureSymbol"), false);
		strictEqual(result.systemPrompt.includes('"entries"'), false);

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
		ok(existsSync(join(staleWiki, ".clio", "codewiki.json")));
		strictEqual(result.systemPrompt.includes("Codewiki: available"), false);
		strictEqual(result.systemPrompt.includes("legacySymbol"), false);
	});
});

describe("contracts/prompts grounding, invalidation, and tools policy", () => {
	it("each compile re-reads project context, so post-context-init compiles see fresh content", async () => {
		const cwd = scratchProject();
		writeClioMd(cwd);
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
			const sessionInputs = {
				provider: "stub",
				model: "stub-model",
				providerSupportsTools: true,
				activeToolNames: ["workspace_context", "grep", "read"],
			};
			const first = await promptsBundle.contract.compileSessionPrompt({ cwd, sessionInputs });
			ok(first.systemPrompt.includes("Keep prompt context compact."));

			// Same inputs compile to the byte-identical prompt: the session
			// prompt is deterministic, so recompiles without underlying change
			// keep the provider prefix cache intact.
			const second = await promptsBundle.contract.compileSessionPrompt({ cwd, sessionInputs });
			strictEqual(second.systemPrompt, first.systemPrompt);
			strictEqual(second.systemPromptHash, first.systemPromptHash);

			// A changed CLIO.md is reflected in the next compile (the chat-loop
			// decides when to recompile; the compiler never caches stale context).
			writeFileSync(
				join(cwd, "CLIO.md"),
				serializeClioMd({
					projectName: "Prompt Fixture",
					identity: "Prompt Fixture is a TypeScript project used to test prompt context selection.",
					conventions: ["Updated convention after context-init."],
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
			const third = await promptsBundle.contract.compileSessionPrompt({ cwd, sessionInputs });
			ok(third.systemPrompt.includes("Updated convention after context-init."));
			notStrictEqual(third.systemPromptHash, first.systemPromptHash);
		} finally {
			await promptsBundle.extension.stop?.();
		}
	});

	it("prompt text says project-internal location questions require codewiki/tool grounding", async () => {
		const cwd = scratchProject();
		const res = await compileProjectPrompt(cwd);
		const systemPrompt = res.systemPrompt;
		ok(systemPrompt.includes("# Retrieval Hints"));
		ok(systemPrompt.includes("inspect with code_nav, workspace_context, grep, or read before answering"));
		ok(systemPrompt.includes("Never invent file paths, automatic tool behavior, or mutable repo details"));
	});

	it("activates path-scoped project rules from prompt working paths", async () => {
		const cwd = scratchProject();
		mkdirSync(join(cwd, ".clio", "rules"), { recursive: true });
		writeFileSync(join(cwd, ".clio", "rules", "always.md"), "# Always\nKeep generated files small.\n", "utf8");
		writeFileSync(
			join(cwd, ".clio", "rules", "typescript.md"),
			"---\npaths:\n  - 'src/**/*.ts'\n---\n# TypeScript\nPrefer explicit exports for fixture modules.\n",
			"utf8",
		);

		const withoutWorkingPath = await compileProjectPromptWithWorkingPaths(cwd, []);
		ok(withoutWorkingPath.systemPrompt.includes("Keep generated files small."));
		ok(!withoutWorkingPath.systemPrompt.includes("Prefer explicit exports for fixture modules."));

		const withWorkingPath = await compileProjectPromptWithWorkingPaths(cwd, [join(cwd, "src", "index.ts")]);
		ok(withWorkingPath.systemPrompt.includes("Keep generated files small."));
		ok(withWorkingPath.systemPrompt.includes("Prefer explicit exports for fixture modules."));
	});

	it("workspace_context is not described as automatic and is explicit/manual", () => {
		const spec = workspaceContextTool({
			getSnapshot: () => null,
			probeWorkspace: () => emptyWorkspaceSnapshot(process.cwd()),
			saveSnapshot: () => {},
			hasSession: () => true,
		});
		ok(spec.description.includes("An explicit, manual workspace snapshot tool"));
		ok(spec.description.includes("Do not assume this tool is run automatically"));
		strictEqual(spec.description.includes("runs automatically"), false);
	});

	it("dispatch is not described as context handoff", () => {
		const dispatch: DispatchContract = {
			dispatch: async () => {
				throw new Error("unused");
			},
			dispatchBatch: async () => {
				throw new Error("unused");
			},
			listRuns: () => [],
			getRun: () => null,
			abort: () => {},
			steer: () => {},
			snapshot: () => ({
				generatedAt: new Date().toISOString(),
				running: [],
				retrying: [],
				totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, runtimeSeconds: 0 },
			}),
			drain: async () => {},
		};
		const spec = createDispatchTool({ dispatch });
		strictEqual(spec.description.includes("handoff"), false);
	});
});
