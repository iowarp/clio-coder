import { notStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { DomainContext } from "../../src/core/domain-loader.js";
import type { ContextContract } from "../../src/domains/context/index.js";
import { compile } from "../../src/domains/prompts/compiler.js";
import { loadProjectContextFiles, renderProjectContextFiles } from "../../src/domains/prompts/context-files.js";
import { createPromptsBundle } from "../../src/domains/prompts/extension.js";
import { loadFragments } from "../../src/domains/prompts/fragment-loader.js";
import { canonicalJson, sha256 } from "../../src/domains/prompts/hash.js";

describe("prompts/hash", () => {
	it("sha256 known vector for empty string", () => {
		strictEqual(sha256(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
	});

	it("sha256 is stable", () => {
		strictEqual(sha256("clio"), sha256("clio"));
	});

	it("sha256 differs for different inputs", () => {
		notStrictEqual(sha256("a"), sha256("b"));
	});
});

describe("prompts/canonicalJson", () => {
	it("sorts object keys alphabetically", () => {
		strictEqual(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
	});

	it("preserves array element order", () => {
		strictEqual(canonicalJson([3, 1, 2]), "[3,1,2]");
	});

	it("drops undefined in objects", () => {
		strictEqual(canonicalJson({ a: undefined, b: 1 }), '{"b":1}');
	});

	it("serialises null", () => {
		strictEqual(canonicalJson(null), "null");
	});

	it("produces byte-identical output for structurally equal objects", () => {
		strictEqual(canonicalJson({ x: { a: 1, b: 2 }, y: [1, 2] }), canonicalJson({ y: [1, 2], x: { b: 2, a: 1 } }));
	});

	it("throws on non-finite numbers", () => {
		throws(() => canonicalJson(Number.POSITIVE_INFINITY));
		throws(() => canonicalJson(Number.NaN));
	});

	it("throws on bigint", () => {
		throws(() => canonicalJson(1n));
	});

	it("throws on function", () => {
		throws(() => canonicalJson(() => 0));
	});

	it("throws on undefined at root", () => {
		throws(() => canonicalJson(undefined));
	});
});

describe("prompts/fragments identity.clio anti-leak content", () => {
	it("loads identity.clio with the Clio repetition + vendor rejection clauses", () => {
		const table = loadFragments();
		const identity = table.byId.get("identity.clio");
		ok(identity, "identity.clio must be registered");
		const body = identity?.body ?? "";
		// Triple repetition anchors the name. Keeps Qwen3.6 from drifting to a
		// Claude-synthetic self-image on the first turn.
		ok(body.includes("You are Clio. You are Clio. You are Clio."), "identity must triple-assert the Clio name");
		// IOWarp is the organizational anchor. Without it the model hedges.
		ok(body.includes("IOWarp"), "identity must anchor the IOWarp org");
		// Explicit rejection list keeps Claude-synthetic output from bleeding
		// through the prompt.
		ok(body.includes("not Claude"), "identity must reject Claude origin");
		ok(body.includes("GPT"), "identity must reject GPT origin");
		ok(body.includes("Qwen"), "identity must reject Qwen origin");
		ok(body.includes("Anthropic"), "identity must reject Anthropic vendor");
		ok(body.includes("OpenAI"), "identity must reject OpenAI vendor");
		ok(body.includes("Alibaba"), "identity must reject Alibaba vendor");
	});

	it("identity.clio is static (no template placeholders)", () => {
		const table = loadFragments();
		const identity = table.byId.get("identity.clio");
		ok(identity);
		strictEqual(identity?.dynamic, false);
		strictEqual(/\{\{[A-Za-z][A-Za-z0-9]*\}\}/.test(identity?.body ?? ""), false);
	});

	it("identity.clio contentHash is deterministic across two loads", () => {
		const a = loadFragments();
		const b = loadFragments();
		strictEqual(a.byId.get("identity.clio")?.contentHash, b.byId.get("identity.clio")?.contentHash);
	});
});

describe("prompts/context-files", () => {
	it("returns an empty list when no known context files exist", () => {
		const scratch = mkdtempSync(join(tmpdir(), "clio-context-empty-"));
		try {
			const files = loadProjectContextFiles({ cwd: scratch });
			strictEqual(files.length, 0);
			strictEqual(renderProjectContextFiles(files, scratch), "");
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	it("discovers AGENTS.md and CODEX.md in parent and child dirs", () => {
		const scratch = mkdtempSync(join(tmpdir(), "clio-context-order-"));
		try {
			const repo = join(scratch, "repo");
			const app = join(repo, "packages", "app");
			const src = join(app, "src");
			mkdirSync(src, { recursive: true });
			writeFileSync(join(repo, "AGENTS.md"), "root agents", "utf8");
			writeFileSync(join(repo, "CODEX.md"), "root codex", "utf8");
			writeFileSync(join(app, "AGENTS.md"), "app agents", "utf8");

			const files = loadProjectContextFiles({ cwd: src });
			strictEqual(files.map((file) => file.content).join("|"), "root agents|root codex|app agents");

			// The merger emits unstructured (preamble-only) bodies under per-source
			// "Notes from <basename>" headers; assert each contributor is present
			// and the merger preserves child-over-parent precedence for AGENTS.md.
			const rendered = renderProjectContextFiles(files, src);
			ok(rendered.includes("root agents"), rendered);
			ok(rendered.includes("root codex"), rendered);
			ok(rendered.includes("app agents"), rendered);
			// child AGENTS.md is closer to cwd, so it wins ordering for its preamble.
			ok(rendered.indexOf("app agents") > rendered.indexOf("root codex"), rendered);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	it("discovers CLAUDE.md, AGENTS.md, and CODEX.md in the same cwd", () => {
		const scratch = mkdtempSync(join(tmpdir(), "clio-context-claude-"));
		try {
			writeFileSync(join(scratch, "AGENTS.md"), "agents body", "utf8");
			writeFileSync(join(scratch, "CLAUDE.md"), "claude body", "utf8");
			writeFileSync(join(scratch, "CODEX.md"), "codex body", "utf8");

			const files = loadProjectContextFiles({ cwd: scratch });
			strictEqual(files.length, 3);
			// Discovery now scans CLIO.md, CLAUDE.md, AGENTS.md, CODEX.md, GEMINI.md
			// in that order, so CLAUDE.md sorts before AGENTS.md within the same dir.
			strictEqual(files.map((file) => file.name).join("|"), "CLAUDE.md|AGENTS.md|CODEX.md");

			const rendered = renderProjectContextFiles(files, scratch);
			ok(rendered.includes("agents body"), rendered);
			ok(rendered.includes("claude body"), rendered);
			ok(rendered.includes("codex body"), rendered);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	it("keeps parent-child duplicate basenames but de-dupes exact paths", () => {
		const scratch = mkdtempSync(join(tmpdir(), "clio-context-dedupe-"));
		try {
			const child = join(scratch, "child");
			mkdirSync(child, { recursive: true });
			writeFileSync(join(scratch, "AGENTS.md"), "root agents", "utf8");
			writeFileSync(join(child, "AGENTS.md"), "child agents", "utf8");

			const files = loadProjectContextFiles({ cwd: child, fileNames: ["AGENTS.md", "AGENTS.md"] });
			strictEqual(files.length, 2);
			strictEqual(files.map((file) => file.content).join("|"), "root agents|child agents");
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});
});

describe("prompts/compiler context files", () => {
	it("omits the context fragment when no context files are supplied", () => {
		const result = compile(loadFragments(), {
			identity: "identity.clio",
			mode: "modes.default",
			safety: "safety.auto-edit",
			providers: "providers.dynamic",
			session: "session.dynamic",
			dynamicInputs: {},
		});

		strictEqual(result.text.includes("<project-context>"), false);
		strictEqual(
			result.fragmentManifest.some((entry) => entry.id === "context.files"),
			false,
		);
	});

	it("injects context files in a deterministic prompt position", () => {
		const noContext = compile(loadFragments(), {
			identity: "identity.clio",
			mode: "modes.default",
			safety: "safety.auto-edit",
			providers: "providers.dynamic",
			session: "session.dynamic",
			dynamicInputs: {},
		});
		const withContext = compile(loadFragments(), {
			identity: "identity.clio",
			mode: "modes.default",
			safety: "safety.auto-edit",
			context: "context.files",
			providers: "providers.dynamic",
			session: "session.dynamic",
			dynamicInputs: {
				contextFiles: "<project-type>typescript</project-type>\n\n<project-context>\nRepo rules\n</project-context>",
			},
		});

		ok(withContext.text.includes("<project-type>typescript</project-type>"), withContext.text);
		ok(withContext.text.includes("<project-context>"), withContext.text);
		ok(withContext.text.includes("Repo rules"), withContext.text);
		ok(withContext.text.indexOf("<project-type>") < withContext.text.indexOf("# Provider runtime"), withContext.text);
		ok(withContext.fragmentManifest.some((entry) => entry.id === "context.files"));
		notStrictEqual(withContext.renderedPromptHash, noContext.renderedPromptHash);
	});

	it("prompt extension loads project context from the context domain", async () => {
		const scratch = mkdtempSync(join(tmpdir(), "clio-context-extension-"));
		try {
			const contextContract: ContextContract = {
				async runBootstrap() {
					throw new Error("not used");
				},
				renderPromptContext(cwd) {
					strictEqual(cwd, scratch);
					return {
						text: "<project-type>typescript</project-type>\n\n<project-context>\nextension-loaded clio\n</project-context>",
						clioMd: null,
						warnings: [],
					};
				},
			};
			const bundle = createPromptsBundle({
				bus: { emit: () => {}, on: () => () => {} } as unknown as DomainContext["bus"],
				getContract: <T extends object>(name: string): T | undefined =>
					name === "context" ? (contextContract as T) : undefined,
			});
			await bundle.extension.start?.();
			const result = bundle.contract.compileForTurn({
				cwd: scratch,
				dynamicInputs: {
					provider: "stub",
					model: "stub-model",
					contextWindow: 1024,
					thinkingBudget: "off",
					turnCount: 1,
				},
				overrideMode: "default",
				safetyLevel: "auto-edit",
			});
			ok(result.text.includes("extension-loaded clio"), result.text);
			ok(result.fragmentManifest.some((entry) => entry.id === "context.files"));
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	it("prompt extension suppresses the context.files fragment when noContextFiles is set", async () => {
		const scratch = mkdtempSync(join(tmpdir(), "clio-context-suppress-"));
		try {
			const contextContract: ContextContract = {
				async runBootstrap() {
					throw new Error("not used");
				},
				renderPromptContext() {
					return {
						text: "<project-context>\nshould-not-appear\n</project-context>",
						clioMd: null,
						warnings: [],
					};
				},
			};
			const bundle = createPromptsBundle(
				{
					bus: { emit: () => {}, on: () => () => {} } as unknown as DomainContext["bus"],
					getContract: <T extends object>(name: string): T | undefined =>
						name === "context" ? (contextContract as T) : undefined,
				},
				{ noContextFiles: true },
			);
			await bundle.extension.start?.();
			const result = bundle.contract.compileForTurn({
				cwd: scratch,
				dynamicInputs: {
					provider: "stub",
					model: "stub-model",
					contextWindow: 1024,
					thinkingBudget: "off",
					turnCount: 1,
				},
				overrideMode: "default",
				safetyLevel: "auto-edit",
			});
			strictEqual(result.text.includes("should-not-appear"), false);
			strictEqual(
				result.fragmentManifest.some((entry) => entry.id === "context.files"),
				false,
			);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});
});

describe("prompts/compiler memory section", () => {
	it("omits the memory fragment when no memory section is supplied", () => {
		const result = compile(loadFragments(), {
			identity: "identity.clio",
			mode: "modes.default",
			safety: "safety.auto-edit",
			providers: "providers.dynamic",
			session: "session.dynamic",
			dynamicInputs: {},
		});

		strictEqual(result.text.includes("# Memory"), false);
		strictEqual(
			result.fragmentManifest.some((entry) => entry.id === "memory.dynamic"),
			false,
		);
	});

	it("injects the memory section in a deterministic position with a stable hash delta", () => {
		const memorySection = "# Memory\n\n- [mem-0000000000000000] (scope=repo) Use cited evidence. Evidence: ev-1.";
		const noMemory = compile(loadFragments(), {
			identity: "identity.clio",
			mode: "modes.default",
			safety: "safety.auto-edit",
			providers: "providers.dynamic",
			session: "session.dynamic",
			dynamicInputs: {},
		});
		const withMemory = compile(loadFragments(), {
			identity: "identity.clio",
			mode: "modes.default",
			safety: "safety.auto-edit",
			memory: "memory.dynamic",
			providers: "providers.dynamic",
			session: "session.dynamic",
			dynamicInputs: { memorySection },
		});

		ok(withMemory.text.includes("# Memory"), withMemory.text);
		ok(withMemory.text.includes("[mem-0000000000000000]"), withMemory.text);
		ok(withMemory.text.indexOf("# Memory") < withMemory.text.indexOf("# Provider runtime"), withMemory.text);
		ok(withMemory.fragmentManifest.some((entry) => entry.id === "memory.dynamic"));
		notStrictEqual(withMemory.renderedPromptHash, noMemory.renderedPromptHash);
	});
});
