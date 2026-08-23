import { deepStrictEqual, notStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { DomainContext, DomainContract } from "../../src/core/domain-loader.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import { resolvePackageRoot } from "../../src/core/package-root.js";
import {
	buildCodewiki,
	ContextDomainModule,
	computeFingerprint,
	listWikiPages,
	renderPromptContext,
	serializeClioMd,
	wikiDir,
	writeClioState,
	writeCodewiki,
	writeWikiMeta,
} from "../../src/domains/context/index.js";
import type { DispatchContract } from "../../src/domains/dispatch/contract.js";
import {
	compile,
	compileWorker as compileWorkerRaw,
	FLEET_ROUTING_GUIDANCE,
	FLEET_ROUTING_GUIDANCE_MAX_BYTES,
	type RenderedPromptFragment,
	type WorkerPromptInputs,
} from "../../src/domains/prompts/compiler.js";
import { createPromptsBundle } from "../../src/domains/prompts/extension.js";
import type { FragmentTable } from "../../src/domains/prompts/fragment-loader.js";
import { loadFragments } from "../../src/domains/prompts/fragment-loader.js";
import { canonicalJson, sha256 } from "../../src/domains/prompts/hash.js";
import { createPromptsDomainModule, PromptsManifest } from "../../src/domains/prompts/index.js";
import { createContextTool } from "../../src/tools/context/index.js";
import { createDispatchTool } from "../../src/tools/dispatch.js";
import { SPOT_CHECK_GUIDANCE } from "../../src/tools/worker-evidence.js";

const scratchRoots: string[] = [];

function compileWorker(
	table: FragmentTable,
	inputs: Omit<WorkerPromptInputs, "hasCanonicalContext" | "hasBoundSkills" | "onPermission"> &
		Partial<Pick<WorkerPromptInputs, "hasCanonicalContext" | "hasBoundSkills" | "onPermission">>,
) {
	return compileWorkerRaw(table, {
		...inputs,
		hasCanonicalContext: inputs.hasCanonicalContext ?? inputs.toolNames.includes("context"),
		hasBoundSkills: inputs.hasBoundSkills ?? false,
		onPermission: inputs.onPermission ?? "deny",
	});
}

describe("contracts/prompts domain dependencies", () => {
	it("drops the context dependency only when project context files are suppressed", () => {
		ok(PromptsManifest.dependsOn.includes("context"));
		ok(createPromptsDomainModule().manifest.dependsOn.includes("context"));
		strictEqual(createPromptsDomainModule({ noContextFiles: true }).manifest.dependsOn.includes("context"), false);
	});
});

// Wrapped in its own describe so the top-level beforeEach/afterEach below
// scope to this file's suites, not the whole process, under
// --experimental-test-isolation=none (every file shares one root test
// context there, so an unscoped top-level hook runs around every test in
// every file).
describe("contracts/prompts", () => {
	afterEach(() => {
		for (const root of scratchRoots.splice(0)) {
			rmSync(root, { recursive: true, force: true });
		}
	});

	/**
	 * Golden copies of the registry-owned prompt hints (bootstrap TOOL_METADATA).
	 * tools.test.ts asserts the registry carries these exact strings; this file
	 * asserts the compiler renders them byte-exactly. A drift in either place is
	 * a deliberate prompt-text change and needs a CHANGELOG note.
	 */
	const TOOL_HINTS = {
		ask_user: {
			tool: "ask_user",
			hint:
				'Use ask_user only when blocked on a decision the request does not answer; never ask about anything the operator already stated. One question per round in interview workflows, up to four tightly related questions otherwise, recommended option first. Finish with action="complete" and a compact decisions array before final prose. If cancelled, continue with defaults and do not ask again.',
		},
		code_nav: {
			tool: "code_nav",
			hint: "Use code_nav for indexed code navigation (modes: symbol, path, entries, outline, deps, dependents, wiki).",
		},
		context: {
			tool: "context",
			hint:
				'Call context with scope="skills" to list installed and marketplace skills; when one matches the task, or the operator names a skill or asks how one works, suggest the operator run /skill <name> (a marketplace skill is offered for install) and never load it uninvited. When the user message carries a skill request, first load that skill via context (scope="skills", name=<skill>) before doing anything else.',
		},
		dispatch: {
			tool: "dispatch",
			hint:
				"Call dispatch with list:true only when the operator asks about agents, workers, or the fleet; never use it to inventory direct tools.",
		},
		tasks: {
			tool: "tasks",
			hint:
				'When a request contains three or more distinct steps, declare the board before your first edit: tasks action="plan" with a title and the task list. ' +
				'Mark one task active with "start" before working it, close it with "done" plus an evidence note ' +
				'(what proves it works), and use "block" with a reason instead of silently stalling.',
		},
	} as const;

	function workerPersona(
		body = "# Persona\n\nInspect the requested boundary and report the result.",
	): RenderedPromptFragment {
		return {
			id: "persona.test-worker",
			relPath: "inline/test-worker",
			body,
			contentHash: sha256(body),
			dynamic: false,
		};
	}

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
			join(cwd, "CLIO-CODER.md"),
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

	function writePromptWiki(cwd: string, gitHead: string): void {
		mkdirSync(wikiDir(cwd), { recursive: true });
		writeFileSync(join(wikiDir(cwd), "quickstart.md"), "# Quickstart\n\nStart with `src/index.ts`.\n", "utf8");
		writeWikiMeta(cwd, {
			version: 1,
			updatedAt: "2026-07-04T00:00:00.000Z",
			gitHead,
			model: "test-model",
			contentHash: "0".repeat(64),
			pages: listWikiPages(cwd),
		});
	}

	function git(cwd: string, args: ReadonlyArray<string>): string {
		const child = spawnSync("git", [...args], { cwd, encoding: "utf8" });
		if (child.error) throw child.error;
		if (child.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${child.stderr}`);
		return child.stdout.trim();
	}

	function initGitRepo(cwd: string): string {
		git(cwd, ["init"]);
		git(cwd, ["config", "user.email", "clio-test@example.com"]);
		git(cwd, ["config", "user.name", "Clio Test"]);
		git(cwd, ["add", "."]);
		git(cwd, ["commit", "-m", "initial"]);
		return git(cwd, ["rev-parse", "--verify", "HEAD"]);
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
					toolPromptHints: [TOOL_HINTS.context],
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
					toolPromptHints: [TOOL_HINTS.context],
				},
			});
		} finally {
			await promptsBundle.extension.stop?.();
		}
	}

	async function compileWorkerPromptWithFixture(cwd: string, workingContextPaths: ReadonlyArray<string>) {
		const bus = createSafeEventBus();
		const contracts = new Map<string, DomainContract>();
		const domainContext: DomainContext = {
			bus,
			getContract<T extends DomainContract>(name: string): T | undefined {
				return contracts.get(name) as T | undefined;
			},
		};
		const promptsBundle = createPromptsBundle(domainContext);
		await promptsBundle.extension.start();
		try {
			return await promptsBundle.contract.compileWorkerPrompt({
				cwd,
				workingContextPaths,
				autonomy: "auto-edit",
				providerSupportsTools: true,
				toolNames: ["read", "edit"],
				toolPromptHints: [
					{ tool: "read", hint: "Read admitted files precisely." },
					{ tool: "edit", hint: "Edit files precisely." },
				],
				hasCanonicalContext: false,
				hasBoundSkills: false,
				onPermission: "deny",
				persona: workerPersona(),
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

	describe("contracts/prompts fragment loader", () => {
		it("loads wiki.page and wiki.plan through the same loader as every other fragment (#92)", () => {
			// Before this, fragment-loader.ts's walk() explicitly skipped any
			// directory named "wiki", and prompts/fragments/wiki/{page,plan}.md
			// were read by a hand-rolled readFileSync in context/wiki/prompts.ts
			// with no id, no version, no content hash, and no hot reload. They now
			// carry the same frontmatter contract as everything under fragments/.
			const table = loadFragments();
			for (const id of ["wiki.page", "wiki.plan"] as const) {
				const fragment = table.byId.get(id);
				ok(fragment, `${id} must be registered`);
				strictEqual(fragment.id, id);
				strictEqual(fragment.version, 1);
				ok(fragment.description.trim().length > 0);
				strictEqual(fragment.dynamic, false);
				ok(/^[0-9a-f]{64}$/.test(fragment.contentHash), "contentHash must be a real sha256 hex digest");
				ok(fragment.relPath.startsWith("wiki/"));
			}
		});

		it("wiki fragment bodies still carry the unsubstituted {{token}} placeholders context/wiki/prompts.ts binds per dispatch", () => {
			// The loader has no template-substitution feature of its own (the same
			// division identity.self-awareness uses for its own {TOKEN}
			// placeholders in compiler.ts): it hands back the raw body, and the
			// consumer substitutes. A loader-side change here would silently break
			// context/wiki/prompts.ts's readWikiFragment with no type error, since
			// both sides only agree through this string contract.
			const table = loadFragments();
			const page = table.byId.get("wiki.page");
			ok(page);
			ok(page.body.includes("{{pagePath}}"));
			ok(page.body.includes("{{pageRelPath}}"));
			ok(page.body.includes("{{pageTitle}}"));
			const plan = table.byId.get("wiki.plan");
			ok(plan);
			ok(plan.body.includes("{{planPath}}"));
		});

		it("walk() no longer special-cases a directory named wiki: every fragments/**/*.md file loads", () => {
			const table = loadFragments();
			ok(
				table.byId.size >= 14,
				`expected at least 14 fragments (12 pre-#92 plus wiki.page and wiki.plan), got ${table.byId.size}`,
			);
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

		it("loads identity.self-awareness with valid structure and budget", () => {
			const table = loadFragments();
			const selfAwareness = table.byId.get("identity.self-awareness");
			ok(selfAwareness, "identity.self-awareness must be registered");
			strictEqual(selfAwareness.version, 1);
			strictEqual(selfAwareness.dynamic, false);
			deepStrictEqual(
				[...selfAwareness.body.matchAll(/\{(CLIO_[A-Z_]+)\}/gu)].map((match) => match[1]).sort(),
				["CLIO_CODEWIKI_PATH", "CLIO_DOCS_PATH", "CLIO_SRC_PATH"],
				"the static fragment exposes exactly the three compiler-owned path slots",
			);
			const documentationRoutes = selfAwareness.body.match(/docs\/[a-z0-9-]+\.md/gu) ?? [];
			ok(documentationRoutes.length >= 2, "the harness fragment points to bundled documentation pages");
			ok(selfAwareness.body.includes("Documentation routes, code decides"));
			ok(selfAwareness.body.includes("~/.config/clio-coder/settings.yaml"));
		});

		// The doc-existence check for the docs/*.md paths named in
		// identity.self-awareness lives in scripts/check-hygiene.ts (the "prompts"
		// rule): it reads the checkout and the pack manifest off disk and asserts
		// on their structure, not on anything this file compiles.
	});

	describe("contracts/prompts compiler logic", () => {
		it("orchestrator prompt contains resolved absolute docs path and self-awareness routing", () => {
			const table = loadFragments();
			const result = compile(table, {
				identity: "identity.clio",
				operatingContract: "operating.contract",
				safety: "safety.auto-edit",
				sessionInputs: { provider: "p", model: "m" },
			});
			const packageRoot = resolvePackageRoot();
			for (const resolvedPath of [
				join(packageRoot, "docs"),
				join(packageRoot, "src"),
				join(packageRoot, "dist", "assets", "codewiki.json"),
			]) {
				ok(result.systemPrompt.includes(resolvedPath), `compiled self-awareness contains ${resolvedPath}`);
			}
			strictEqual(/\{CLIO_[A-Z_]+\}/u.test(result.systemPrompt), false, "no compiler-owned path slot survives");
			ok(result.systemPrompt.includes("~/.config/clio-coder/settings.yaml"));
			ok(result.fragmentManifest.some((f) => f.id === "identity.self-awareness"));
		});

		it('routes questions about Clio herself through context(scope="docs") as a directive, only when context is attached', () => {
			// The 42-row doc routing table that used to live in identity.self-awareness
			// is gone; the corpus is reachable through one context call, and every
			// search response lists every bundled doc. The replacement must read as
			// something to do, not something that is true: a passive "docs exist"
			// note is what once sent the model grepping the workspace for a skill.
			const table = loadFragments();
			const routing = table.byId.get("identity.docs-routing");
			ok(routing, "identity.docs-routing must be registered");
			ok(
				routing.body.includes(
					'call context (scope="docs", query=<the question>) before answering and before any grep, find, or read',
				),
			);
			ok(routing.body.includes("not in the working tree"));
			strictEqual(/Documentation routing:|-> docs\//.test(table.byId.get("identity.self-awareness")?.body ?? ""), false);
			const withContext = compile(table, {
				identity: "identity.clio",
				operatingContract: "operating.contract",
				safety: "safety.auto-edit",
				sessionInputs: { provider: "p", model: "m", toolNames: ["context", "read"] },
			});
			ok(withContext.systemPrompt.includes(routing.body.trim()));
			ok(withContext.fragmentManifest.some((f) => f.id === "identity.docs-routing"));
			// Directive sits inside the identity section, right after the paths it
			// tells the model to read from.
			ok(
				withContext.systemPrompt.indexOf("Installed documentation:") <
					withContext.systemPrompt.indexOf("# Clio documentation routing"),
			);
			ok(
				withContext.systemPrompt.indexOf("# Clio documentation routing") <
					withContext.systemPrompt.indexOf("# Operating Contract"),
			);
			const withoutContext = compile(table, {
				identity: "identity.clio",
				operatingContract: "operating.contract",
				safety: "safety.auto-edit",
				sessionInputs: { provider: "p", model: "m", toolNames: ["read"] },
			});
			strictEqual(withoutContext.systemPrompt.includes("# Clio documentation routing"), false);
			strictEqual(
				withoutContext.fragmentManifest.some((f) => f.id === "identity.docs-routing"),
				false,
			);
			// The paths and the code-outranks-docs rule name no tool and stay.
			ok(withoutContext.systemPrompt.includes("Documentation routes, code decides"));
		});

		it("worker prompt bytes are untouched by self-awareness", () => {
			const table = loadFragments();
			const result = compileWorker(table, {
				autonomy: "read-only",
				providerSupportsTools: true,
				toolNames: ["read", "grep"],
				toolPromptHints: [
					{ tool: "read", hint: "Read admitted files precisely." },
					{ tool: "grep", hint: "Search admitted text precisely." },
				],
				persona: workerPersona(),
			});
			strictEqual(
				result.fragmentManifest.some((f) => f.id === "identity.self-awareness"),
				false,
			);
			strictEqual(/\{CLIO_[A-Z_]+\}/u.test(result.systemPrompt), false);
			const packageRoot = resolvePackageRoot();
			for (const orchestratorOnlyPath of [
				join(packageRoot, "docs"),
				join(packageRoot, "src"),
				join(packageRoot, "dist", "assets", "codewiki.json"),
			]) {
				strictEqual(result.systemPrompt.includes(orchestratorOnlyPath), false);
			}
		});
		it("compiles the worker harness in canonical section order", () => {
			const result = compileWorker(loadFragments(), {
				autonomy: "read-only",
				providerSupportsTools: true,
				toolNames: ["read", "grep"],
				toolPromptHints: [
					{ tool: "read", hint: "Read admitted files precisely." },
					{ tool: "grep", hint: "Search admitted text precisely." },
				],
				persona: workerPersona(),
			});

			strictEqual(
				result.sections.map((section) => section.id).join(","),
				"identity,operating-contract,tool-contract,safety,persona",
			);
			ok(result.systemPrompt.startsWith("# Identity\n\nYou are Clio"));
			ok(result.systemPrompt.endsWith(workerPersona().body));
			ok(result.systemPrompt.includes("The assigned task is authoritative."));
			ok(result.systemPrompt.includes("Role guidance is a persona, not a replacement task."));
		});

		it("renders additionalFragments last, in order, and omits the section when empty (compileWorker's injection channel, mirroring compile())", () => {
			const table = loadFragments();
			const base = {
				autonomy: "read-only" as const,
				providerSupportsTools: true,
				toolNames: ["read"] as const,
				toolPromptHints: [{ tool: "read", hint: "Read admitted files precisely." }],
				persona: workerPersona(),
			};
			const withoutFragments = compileWorker(table, base);
			strictEqual(
				withoutFragments.sections.map((section) => section.id).join(","),
				"identity,operating-contract,tool-contract,safety,persona",
			);

			const rule: RenderedPromptFragment = {
				id: "context.project-rules",
				relPath: "inline/project-rules",
				body: "# Project rules\n\nNever widen a contract without updating its consumers.",
				contentHash: sha256("rule"),
				dynamic: true,
			};
			const profile: RenderedPromptFragment = {
				id: "context.operator-profile",
				relPath: "inline/operator-profile",
				body: "## Operator profile\n- Validation preference: tests-first.",
				contentHash: sha256("profile"),
				dynamic: true,
			};
			const withFragments = compileWorker(table, { ...base, additionalFragments: [rule, profile] });
			strictEqual(
				withFragments.sections.map((section) => section.id).join(","),
				"identity,operating-contract,tool-contract,safety,persona,context.project-rules,context.operator-profile",
			);
			ok(withFragments.systemPrompt.includes(rule.body));
			ok(withFragments.systemPrompt.includes(profile.body));
			ok(withFragments.systemPrompt.indexOf(rule.body) > withFragments.systemPrompt.indexOf(workerPersona().body));
			ok(withFragments.fragmentManifest.some((f) => f.id === "context.project-rules"));
			ok(withFragments.fragmentManifest.some((f) => f.id === "context.operator-profile"));
			// No additionalFragments and an empty array both drop the section
			// entirely rather than leaving a blank one: absence stays silent, the
			// same rule push() already applies to every other worker section.
			const withEmptyArray = compileWorker(table, { ...base, additionalFragments: [] });
			strictEqual(withEmptyArray.systemPrompt, withoutFragments.systemPrompt);
			strictEqual(withEmptyArray.systemPromptHash, withoutFragments.systemPromptHash);
		});

		it("normalizes worker toolkit ordering and duplicates deterministically", () => {
			const table = loadFragments();
			const persona = workerPersona();
			const first = compileWorker(table, {
				autonomy: "auto-edit",
				providerSupportsTools: true,
				toolNames: ["read", "grep", "read"],
				toolPromptHints: [
					{ tool: "read", hint: "Read admitted files precisely." },
					{ tool: "grep", hint: "Search admitted text precisely." },
					{ tool: "read", hint: "Read admitted files precisely." },
				],
				persona,
			});
			const second = compileWorker(table, {
				autonomy: "auto-edit",
				providerSupportsTools: true,
				toolNames: ["grep", "read"],
				toolPromptHints: [
					{ tool: "grep", hint: "Search admitted text precisely." },
					{ tool: "read", hint: "Read admitted files precisely." },
				],
				persona,
			});

			strictEqual(first.systemPrompt, second.systemPrompt);
			strictEqual(first.systemPromptHash, second.systemPromptHash);
			strictEqual(first.systemPrompt.match(/Read admitted files precisely\./g)?.length, 1);
		});

		it("changes worker hashes for stable policy inputs and rejects volatile personas", () => {
			const table = loadFragments();
			const baselineInputs = {
				autonomy: "read-only" as const,
				providerSupportsTools: true,
				toolNames: ["read"] as const,
				toolPromptHints: [{ tool: "read", hint: "Read admitted files precisely." }],
				persona: workerPersona(),
			};
			const baseline = compileWorker(table, baselineInputs);
			const changedAutonomy = compileWorker(table, { ...baselineInputs, autonomy: "auto-edit" });
			const changedTools = compileWorker(table, {
				...baselineInputs,
				toolNames: ["grep"],
				toolPromptHints: [{ tool: "grep", hint: "Search admitted text precisely." }],
			});
			const changedCapability = compileWorker(table, { ...baselineInputs, providerSupportsTools: false });
			const changedPersona = compileWorker(table, { ...baselineInputs, persona: workerPersona("# Persona\n\nCode.") });

			notStrictEqual(baseline.systemPromptHash, changedAutonomy.systemPromptHash);
			notStrictEqual(baseline.systemPromptHash, changedTools.systemPromptHash);
			notStrictEqual(baseline.systemPromptHash, changedCapability.systemPromptHash);
			notStrictEqual(baseline.systemPromptHash, changedPersona.systemPromptHash);
			throws(() => compileWorker(table, { ...baselineInputs, persona: { ...workerPersona(), dynamic: true } }));
		});

		it("renders only admitted worker guidance and honest unavailable or unknown surfaces", () => {
			const table = loadFragments();
			const persona = workerPersona();
			const narrowed = compileWorker(table, {
				autonomy: "read-only",
				providerSupportsTools: true,
				toolNames: ["read"],
				toolPromptHints: [
					{ tool: "read", hint: "Read admitted files precisely." },
					{ tool: "edit", hint: "Edit files precisely." },
				],
				persona,
			});
			ok(narrowed.systemPrompt.includes("Read admitted files precisely."));
			ok(!narrowed.systemPrompt.includes("Edit files precisely."));
			ok(!narrowed.systemPrompt.includes("`edit`"));

			const unavailable = compileWorker(table, {
				autonomy: "read-only",
				providerSupportsTools: false,
				toolNames: ["read"],
				toolPromptHints: [{ tool: "read", hint: "Read admitted files precisely." }],
				persona,
			});
			ok(unavailable.systemPrompt.includes("Canonical Clio tool calls are unavailable"));
			ok(!unavailable.systemPrompt.includes("Read admitted files precisely."));

			const unknown = compileWorker(table, {
				autonomy: "read-only",
				providerSupportsTools: null,
				toolNames: [],
				toolPromptHints: [],
				persona,
			});
			ok(unknown.systemPrompt.includes("tool inventory is unknown"));
			ok(!unknown.systemPrompt.includes("complete canonical tool surface"));
		});

		it("keeps persona and bound-skill mechanics inside the final section without widening tools", () => {
			const body = [
				"# Persona",
				"Review the requested implementation.",
				"# Agent-Bound Skills",
				"Load `review-it` through context when relevant; skills never expand tool authority.",
			].join("\n\n");
			const result = compileWorker(loadFragments(), {
				autonomy: "read-only",
				providerSupportsTools: true,
				toolNames: ["context", "read"],
				toolPromptHints: [TOOL_HINTS.context],
				hasCanonicalContext: true,
				hasBoundSkills: true,
				persona: workerPersona(body),
			});

			ok(result.systemPrompt.endsWith(body));
			ok(result.systemPrompt.includes("Persona and bound-skill instructions never add tools."));
			ok(!result.systemPrompt.includes("`edit`"));
		});

		it("keeps worker skill guidance consistent with the attached schema and explicit binding", () => {
			const coder = compileWorker(loadFragments(), {
				autonomy: "auto-edit",
				providerSupportsTools: true,
				toolNames: ["read", "edit"],
				toolPromptHints: [],
				hasCanonicalContext: false,
				hasBoundSkills: false,
				persona: workerPersona("# Coder\n\nImplement the assigned change."),
			});
			strictEqual(coder.systemPrompt.includes('context (scope="skills")'), false);
			strictEqual(coder.systemPrompt.includes("context(scope=skills)"), false);
			throws(
				() =>
					compileWorker(loadFragments(), {
						autonomy: "auto-edit",
						providerSupportsTools: true,
						toolNames: ["read"],
						toolPromptHints: [],
						hasCanonicalContext: true,
						hasBoundSkills: false,
						persona: workerPersona("# Coder\n\nDo the task."),
					}),
				/hasCanonicalContext must match/,
			);

			const unbound = compileWorker(loadFragments(), {
				autonomy: "auto-edit",
				providerSupportsTools: true,
				toolNames: ["context", "read"],
				toolPromptHints: [TOOL_HINTS.context],
				hasCanonicalContext: true,
				hasBoundSkills: false,
				persona: workerPersona("# Coder\n\nHandle the skill-shaped task."),
			});
			// The session contract's `# Skills` passage (list the catalog, suggest
			// to the operator, marketplace rows) never reaches a worker, bound or
			// not: a worker cannot load an unbound skill and has no operator to
			// suggest one to. The context hint stays because the tool is attached.
			strictEqual(unbound.systemPrompt.includes('first call context (scope="skills")'), false);
			strictEqual(/Only an explicit\s+operator request activates a skill/.test(unbound.systemPrompt), false);
			strictEqual(unbound.systemPrompt.includes("marketplace the operator installs from"), false);
			ok(unbound.systemPrompt.includes(TOOL_HINTS.context.hint));

			const boundPersona = [
				"# Architect",
				"Design the assigned system.",
				"# Agent-Bound Skills",
				"The harness explicitly activates the recipe-bound `design-review` skill for this run; the operator does not need to repeat its name.",
				'Load it through canonical `context` (scope="skills", name="design-review"); binding never widens tool authority.',
			].join("\n\n");
			const architect = compileWorker(loadFragments(), {
				autonomy: "read-only",
				providerSupportsTools: true,
				toolNames: ["context", "read"],
				toolPromptHints: [TOOL_HINTS.context],
				hasCanonicalContext: true,
				hasBoundSkills: true,
				persona: workerPersona(boundPersona),
			});
			ok(architect.systemPrompt.endsWith(boundPersona));
			ok(architect.systemPrompt.includes("explicitly activates"));
			ok(architect.systemPrompt.includes("does not need to repeat"));
			strictEqual(/Only an explicit\s+operator request activates a skill/.test(architect.systemPrompt), false);
		});

		it("renders suggest approval routing honestly and keeps reviewer-style read-only policy consistent", () => {
			for (const onPermission of ["escalate", "deny", "fail"] as const) {
				const suggest = compileWorker(loadFragments(), {
					autonomy: "suggest",
					providerSupportsTools: true,
					toolNames: ["read", "edit"],
					toolPromptHints: [],
					hasCanonicalContext: false,
					hasBoundSkills: false,
					onPermission,
					persona: workerPersona("# Coder\n\nSuggest a change."),
				});
				if (onPermission === "escalate") ok(suggest.systemPrompt.includes("bounded operator decision"));
				if (onPermission === "deny") ok(suggest.systemPrompt.includes("denied immediately"));
				if (onPermission === "fail") ok(suggest.systemPrompt.includes("fails and ends the worker run"));

				const readOnly = compileWorker(loadFragments(), {
					autonomy: "read-only",
					providerSupportsTools: true,
					toolNames: ["read"],
					toolPromptHints: [],
					hasCanonicalContext: false,
					hasBoundSkills: false,
					onPermission,
					persona: workerPersona("# Reviewer\n\nReview without changes."),
				});
				ok(readOnly.systemPrompt.includes("Every mutating call is denied"));
				strictEqual(readOnly.systemPrompt.includes("bounded operator decision"), false);
			}
		});

		it("worker safety is the level fragment itself: one source, action-class vocabulary, no tool names", () => {
			// Before this, the worker's safety section was a hand-written copy of
			// the four levels living in a switch in compiler.ts, and the copy
			// drifted: its full-auto branch said "Writes, dispatches, and ordinary
			// commands run" for workers none of which admit dispatch. Now both
			// renderers read the same fragment body, so nothing can drift, and the
			// fragments name action classes rather than tools, so nothing can be
			// false for a surface that lacks a tool.
			const table = loadFragments();
			for (const level of ["read-only", "suggest", "auto-edit", "full-auto"] as const) {
				const fragment = table.byId.get(`safety.${level}`);
				ok(fragment, `safety.${level} must be registered`);
				strictEqual(fragment.body.includes("dispatch"), false, `safety.${level} names dispatch`);
				ok(fragment.body.includes("git_destructive actions are blocked by the safety net at every autonomy level."));
				const worker = compileWorker(table, {
					autonomy: level,
					providerSupportsTools: true,
					toolNames: ["read", "edit", "bash"],
					toolPromptHints: [],
					hasCanonicalContext: false,
					hasBoundSkills: false,
					onPermission: "deny",
					persona: workerPersona("# Coder\n\nDo the task."),
				});
				ok(worker.systemPrompt.includes(fragment.body.trim()), `worker at ${level} must read the fragment body`);
				// A worker whose surface lacks dispatch is never told about it: not
				// in identity, contract, tool contract, safety, or the assigned-task
				// contract (#91's class, not just its instance).
				strictEqual(worker.systemPrompt.includes("dispatch"), false, `worker at ${level} mentions dispatch`);
				const session = compile(table, {
					identity: "identity.clio",
					operatingContract: "operating.contract",
					safety: `safety.${level}`,
					sessionInputs: { provider: "p", model: "m" },
				});
				ok(session.systemPrompt.includes(fragment.body.trim()), `session at ${level} must read the fragment body`);
			}
			// The auto-edit level states the engine's rule, not the older
			// approximation: an all-recognized `&&` chain runs (policy-engine.ts
			// recognizeCommandChain); pipes, `;`, redirects, and a chain with an
			// unrecognized step are the unrecognized forms.
			const autoEdit = table.byId.get("safety.auto-edit");
			ok(autoEdit);
			ok(autoEdit.body.includes("a `&&` chain whose every step is recognized runs too"));
			ok(autoEdit.body.includes("a `&&` chain with an unrecognized step all count as unrecognized"));
			strictEqual(autoEdit.body.includes("Commands with pipes, `&&`, or redirects count as unrecognized"), false);
			ok(autoEdit.body.includes("`.clio-coder/safety.yaml`"));
		});

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

		it("skills passage carries skill awareness with the operator gate intact, only when context is on the surface", () => {
			const table = loadFragments();
			// Role text is gated on the surface: the Skills passage teaches calling
			// context(scope="skills"), so it renders only when `context` is attached.
			const without = compile(table, {
				identity: "identity.clio",
				operatingContract: "operating.contract",
				safety: "safety.auto-edit",
				sessionInputs: { provider: "p", model: "m" },
			});
			strictEqual(without.systemPrompt.includes("# Skills"), false);
			strictEqual(
				without.sections.some((section) => section.id === "skills"),
				false,
			);
			strictEqual(
				without.fragmentManifest.some((f) => f.id === "operating.skills"),
				false,
			);
			const result = compile(table, {
				identity: "identity.clio",
				operatingContract: "operating.contract",
				safety: "safety.auto-edit",
				sessionInputs: { provider: "p", model: "m", toolNames: ["context"] },
			});
			ok(result.sections.some((section) => section.id === "skills"));
			ok(result.fragmentManifest.some((f) => f.id === "operating.skills"));
			// The fragment is hard-wrapped; compare against whitespace-normalized text.
			const flat = result.systemPrompt.replace(/\s+/g, " ");
			// The passage tells the agent to check the catalog on skill-shaped tasks
			// and to suggest matches (or a sequence) to the operator.
			ok(flat.includes('context (scope="skills")'));
			ok(flat.includes("/skill <name>"));
			ok(flat.includes("when skills compose"));
			// The gate: only the operator activates skills; no self-loading.
			ok(flat.includes("Only an explicit operator request activates a skill"));
			ok(flat.includes("never load one on your own"));
			// Routine tasks stay suggestion-free (false-positive guard).
			ok(flat.includes("proceed normally and suggest nothing"));
			// Guidance stays generic: no skill catalog is compiled into the prompt.
			strictEqual(flat.includes("grill-me"), false);
			strictEqual(flat.includes("experiment-protocol"), false);
		});

		it("operating contract qualifies delegated evidence and requires parent spot-checks", () => {
			const table = loadFragments();
			// Delegation is role text gated on the surface: without `dispatch` the
			// whole passage is absent, the same way the Fleet block already is.
			const without = compile(table, {
				identity: "identity.clio",
				operatingContract: "operating.contract",
				safety: "safety.auto-edit",
				sessionInputs: { provider: "p", model: "m" },
			});
			strictEqual(without.systemPrompt.includes("# Delegation"), false);
			strictEqual(without.systemPrompt.includes("A sealed run receipt"), false);
			strictEqual(
				without.fragmentManifest.some((f) => f.id === "operating.delegation"),
				false,
			);
			const result = compile(table, {
				identity: "identity.clio",
				operatingContract: "operating.contract",
				safety: "safety.auto-edit",
				sessionInputs: { provider: "p", model: "m", toolNames: ["dispatch"] },
			});
			ok(result.sections.some((section) => section.id === "delegation"));
			ok(result.fragmentManifest.some((f) => f.id === "operating.delegation"));
			const flat = result.systemPrompt.replace(/\s+/g, " ");
			// Receipt integrity and evidence verification are separate; raw worker
			// prose is never called verified evidence without qualification.
			ok(flat.includes("A sealed run receipt is the durable record for delegated work"));
			ok(flat.includes("Receipt integrity verifies that record; evidence verification separately describes validation"));
			ok(flat.includes("The worker's prose remains an advisory claim unless its evidence is verified"));
			strictEqual(flat.includes("synthesize returned evidence"), false);
			// The parent spot-check discipline is the exact sentence dispatch renders
			// head-anchored in its summary; every surface teaches the same bytes.
			ok(flat.includes(SPOT_CHECK_GUIDANCE));
			ok(flat.includes("A successful reconnaissance receipt is an index"));
			ok(flat.includes("normally no more than six parent read/search calls"));
			ok(flat.includes("Parent spot-checking is not independent specialist confirmation"));
			ok(flat.includes("Use the dispatch briefing field for receipt-derived context/data"));
			ok(flat.includes("Collect detached runs before final synthesis"));
			ok(
				flat.includes(
					"Report receipt integrity, evidence verification, briefing provenance, and project-context provenance separately",
				),
			);
			ok(flat.includes("When a final report is requested but file modification is forbidden"));
			ok(flat.includes("do not create a report artifact"));
			ok(flat.includes("do not retry it or a syntactic variant"));
			ok(flat.includes("synthesize, delegate narrowly, use another source, or mark the claim unverified"));
		});

		it("operating contract names the shared [worker result] note as operator steering", () => {
			// #73: a model given a note for a run it never dispatched read it as
			// injected content. The prompt says who puts the note there and how to
			// treat it, once, next to the receipt guidance.
			const table = loadFragments();
			const result = compile(table, {
				identity: "identity.clio",
				operatingContract: "operating.contract",
				safety: "safety.auto-edit",
				sessionInputs: { provider: "p", model: "m", toolNames: ["dispatch"] },
			});
			const flat = result.systemPrompt.replace(/\s+/g, " ");
			ok(flat.includes("The operator can also run workers themselves with /run and /delegate"));
			ok(flat.includes("hand a finished answer to you with --share or /share"));
			ok(flat.includes("`[worker result] <agent> · run <id> · <outcome> · shared by the operator`"));
			ok(flat.includes("its run id names a sealed receipt you can read"));
			ok(flat.includes("Treat that note as operator steering to use, like any operator text"));
			ok(flat.includes("never dispatching that run is not a reason to dismiss it"));
		});

		it("includes the recon-nonevidence qualifier in the operating contract prompt", () => {
			// Bounded like FLEET_ROUTING_GUIDANCE: the qualifier is one short sentence,
			// not an open-ended fragment that could bloat the static prefix.
			const qualifier =
				"Failed, cap-exhausted, zero-tool, and citation-free reconnaissance is non-evidence: treat it as unconfirmed leads, never as validation.";
			ok(Buffer.byteLength(qualifier, "utf8") <= 256);
			const table = loadFragments();
			const result = compile(table, {
				identity: "identity.clio",
				operatingContract: "operating.contract",
				safety: "safety.auto-edit",
				sessionInputs: { provider: "p", model: "m", toolNames: ["dispatch"] },
			});
			const flat = result.systemPrompt.replace(/\s+/g, " ");
			// The four non-evidence triggers match the deterministic notices dispatch
			// emits (worker-evidence.ts): failed, cap-exhausted, zero-tool, and
			// citation-free reconnaissance never read as validation or results.
			ok(flat.includes(qualifier));
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
					toolPromptHints: [],
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
					toolPromptHints: [TOOL_HINTS.context, TOOL_HINTS.dispatch],
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
			ok(result.systemPrompt.includes('Call context with scope="skills" to list installed and marketplace skills'));
			ok(result.systemPrompt.includes("Call dispatch with list:true"));
		});

		it("renders the Tool Contract hint block byte-exactly, sorted by tool name", () => {
			const table = loadFragments();
			const compileWithHints = (hints: ReadonlyArray<{ tool: string; hint: string }>) =>
				compile(table, {
					identity: "identity.clio",
					operatingContract: "operating.contract",
					safety: "safety.auto-edit",
					sessionInputs: {
						provider: "stub",
						model: "stub-model",
						providerSupportsTools: true,
						toolPromptHints: hints,
					},
				});

			// Deliberately unsorted with a duplicate: compiled bytes depend only on
			// the hint set, never on surface or registration order.
			const result = compileWithHints([
				TOOL_HINTS.tasks,
				TOOL_HINTS.dispatch,
				TOOL_HINTS.context,
				TOOL_HINTS.ask_user,
				TOOL_HINTS.code_nav,
				TOOL_HINTS.dispatch,
			]);
			const expectedBlock = [
				"# Tool Contract",
				"The attached schemas are the session's complete direct-tool surface; follow each schema exactly.",
				"Harness model: direct tools are attached schemas; fleet agents are workers behind dispatch; skills are operator-activated workflows reached through context. Keep these capability sets distinct.",
				'When answering capability-inventory questions, copy the Direct tools line above verbatim rather than recalling the attached schemas, and make no calls; add dispatch(list:true) only if agents or the fleet are requested; add context(scope="skills") only if skills are requested (it lists installed and marketplace skills).',
				"Call tools only for concrete inspection or changes the task requires. If the user asks for a tool-free answer, simply answer without calling tools.",
				'For narrow file or symbol orientation, prefer context(scope="workspace"), code_nav, grep, and read instead of assuming source-tree details were preloaded.',
				"Validate with verify or git diff before final claims.",
				'When a tool call fails or is rejected, do not retry the same shape blindly: re-read the schema, adjust the arguments, or query context(scope="docs") for that tool\'s usage.',
				FLEET_ROUTING_GUIDANCE,
				TOOL_HINTS.ask_user.hint,
				TOOL_HINTS.code_nav.hint,
				TOOL_HINTS.context.hint,
				TOOL_HINTS.dispatch.hint,
				TOOL_HINTS.tasks.hint,
			].join("\n");
			ok(
				result.systemPrompt.includes(expectedBlock),
				"Tool Contract block must render base lines then hints sorted by tool name",
			);

			const reordered = compileWithHints([
				TOOL_HINTS.ask_user,
				TOOL_HINTS.code_nav,
				TOOL_HINTS.context,
				TOOL_HINTS.dispatch,
				TOOL_HINTS.tasks,
			]);
			strictEqual(reordered.systemPrompt, result.systemPrompt);
			strictEqual(reordered.systemPromptHash, result.systemPromptHash);
		});

		it("renders a compact, sorted direct-tool inventory without conflating harness capabilities", () => {
			const result = compile(loadFragments(), {
				identity: "identity.clio",
				operatingContract: "operating.contract",
				safety: "safety.auto-edit",
				sessionInputs: {
					providerSupportsTools: true,
					toolNames: ["read", "dispatch", "context", "read"],
					toolPromptHints: [TOOL_HINTS.context, TOOL_HINTS.dispatch],
				},
			});

			ok(result.systemPrompt.includes("Direct tools: `context`, `dispatch`, `read`."));
			ok(result.systemPrompt.includes("Keep these capability sets distinct."));
			ok(result.systemPrompt.includes("copy the Direct tools line above verbatim"));
			ok(result.systemPrompt.includes("never use it to inventory direct tools"));
		});

		it("renders bounded fleet routing guidance only when dispatch is on the surface", () => {
			ok(Buffer.byteLength(FLEET_ROUTING_GUIDANCE, "utf8") <= FLEET_ROUTING_GUIDANCE_MAX_BYTES);
			const table = loadFragments();
			const withDispatch = compile(table, {
				identity: "identity.clio",
				operatingContract: "operating.contract",
				safety: "safety.auto-edit",
				sessionInputs: { providerSupportsTools: true, toolPromptHints: [TOOL_HINTS.dispatch] },
			});
			ok(withDispatch.systemPrompt.includes(FLEET_ROUTING_GUIDANCE));
			// The routing sentence carries only what nothing else does: the pin
			// rule. Broad exploration and handoff/receipt discipline live in
			// operating.delegation, stated once.
			for (const route of [
				"pin the `agent` id from the Fleet section",
				'agent:"auto" baselines from the task text and is a fallback, not a router',
			]) {
				ok(withDispatch.systemPrompt.includes(route), route);
			}
			strictEqual(withDispatch.systemPrompt.includes("Broad repo/codebase exploration goes to a worker"), false);
			const withoutDispatch = compile(table, {
				identity: "identity.clio",
				operatingContract: "operating.contract",
				safety: "safety.auto-edit",
				sessionInputs: { providerSupportsTools: true, toolPromptHints: [] },
			});
			strictEqual(withoutDispatch.systemPrompt.includes(FLEET_ROUTING_GUIDANCE), false);
		});

		it("states each routing rule once: the tool contract keeps validation and failure recovery, not restatements", () => {
			const table = loadFragments();
			const result = compile(table, {
				identity: "identity.clio",
				operatingContract: "operating.contract",
				safety: "safety.auto-edit",
				sessionInputs: {
					provider: "stub",
					model: "stub-model",
					providerSupportsTools: true,
					toolPromptHints: [],
				},
			});
			const prompt = result.systemPrompt;

			// Ordinary multi-step coding never spends a skill-listing call; the old
			// broad trigger must stay gone, and so must the tool contract's own
			// paraphrase of the Skills passage: skills guidance renders once, from
			// operating.skills, only when `context` is on the surface.
			strictEqual(prompt.includes("For a multi-step task, list installed skills"), false);
			strictEqual(prompt.includes("List installed and installable skills"), false);
			strictEqual(prompt.includes("# Skills"), false);

			// Delegation is not restated in the tool contract or the retrieval
			// hints either: the "broad exploration goes to a worker" rule lives in
			// operating.delegation and nowhere else, so two phrasings can never
			// disagree again about agent:"auto" versus a pinned id.
			strictEqual(prompt.includes("Routing order:"), false);
			strictEqual(prompt.includes('agent:"auto"'), false);
			strictEqual(prompt.includes("reconnaissance worker"), false);
			// Validation and failure recovery are static base lines, present
			// regardless of which hinted tools are on the surface.
			ok(prompt.includes("Validate with verify or git diff before final claims."));
			ok(prompt.includes("do not retry the same shape blindly"));
			ok(prompt.includes('query context(scope="docs")'));
		});

		it("omits the catalog one-liners when context and dispatch are not in the session surface", () => {
			const table = loadFragments();
			const result = compile(table, {
				identity: "identity.clio",
				operatingContract: "operating.contract",
				safety: "safety.auto-edit",
				sessionInputs: {
					provider: "stub",
					model: "stub-model",
					providerSupportsTools: true,
					toolPromptHints: [],
				},
			});

			// The registry-owned hint lines are absent with their tools. The operating
			// contract's static skill-awareness passage and the Tool Contract's static
			// base lines still render; only the per-tool "Call context with ..." /
			// "Call dispatch with ..." hints are surface-dependent.
			strictEqual(
				result.systemPrompt.includes('Call context with scope="skills" to list installed and marketplace skills'),
				false,
			);
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
					toolPromptHints: [TOOL_HINTS.dispatch, TOOL_HINTS.context, TOOL_HINTS.ask_user],
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
					toolPromptHints: [TOOL_HINTS.context, TOOL_HINTS.ask_user],
				},
			});
			ok(active.systemPrompt.includes("first load that skill via context"));
			ok(active.systemPrompt.includes("Use ask_user only when blocked on a decision the request does not answer"));
			ok(active.systemPrompt.includes("If cancelled, continue with defaults"));

			const inactive = compile(table, {
				identity: "identity.clio",
				operatingContract: "operating.contract",
				safety: "safety.auto-edit",
				sessionInputs: {
					provider: "stub",
					model: "stub-model",
					providerSupportsTools: true,
					toolPromptHints: [TOOL_HINTS.context],
				},
			});
			strictEqual(inactive.systemPrompt.includes("Use ask_user for operator interviews"), false);
		});

		it("states the absolute workspace root so no tool argument has to guess it", async () => {
			const cwd = scratchProject();
			const result = await compileProjectPrompt(cwd);
			// A model that is never told the root invents one. An observed run passed
			// the container convention /workspace to bash and had the call blocked.
			ok(result.systemPrompt.includes(`Absolute workspace root: ${cwd}`));
			ok(result.systemPrompt.includes("Do not invent a root such as /workspace"));
		});

		it("summarizes project context across missing, CLIO-only, fresh codewiki, and stale codewiki states", async () => {
			const empty = scratchProject();
			let result = await compileProjectPrompt(empty);
			strictEqual(result.systemPrompt.includes("CLIO-CODER.md: available"), false);
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
			writeCodewiki(freshWiki, await buildCodewiki({ cwd: freshWiki, language: "typescript", generatedAt }));
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
			mkdirSync(join(staleWiki, ".clio-coder"), { recursive: true });
			writeFileSync(
				join(staleWiki, ".clio-coder", "codewiki.json"),
				JSON.stringify({
					version: 1,
					generatedAt,
					language: "typescript",
					entries: [{ path: "src/index.ts", exports: ["legacySymbol"], imports: [], role: "entry point" }],
				}),
				"utf8",
			);
			result = await compileProjectPrompt(staleWiki);
			ok(existsSync(join(staleWiki, ".clio-coder", "codewiki.json")));
			strictEqual(result.systemPrompt.includes("Codewiki: available"), false);
			strictEqual(result.systemPrompt.includes("legacySymbol"), false);
		});

		it("renders wiki prompt markers for fresh, stale, and absent wiki states", async () => {
			const generatedAt = "2026-05-01T00:00:00.000Z";
			const absent = scratchProject();
			writeCodewiki(absent, await buildCodewiki({ cwd: absent, language: "typescript", generatedAt }));
			writeClioState(absent, {
				version: 1,
				projectType: "typescript",
				fingerprint: computeFingerprint(absent),
				lastSessionAt: generatedAt,
				lastIndexedAt: generatedAt,
			});
			strictEqual(renderPromptContext(absent).text.includes("<wiki>"), false);

			const fresh = scratchProject();
			writeCodewiki(fresh, await buildCodewiki({ cwd: fresh, language: "typescript", generatedAt }));
			writeClioState(fresh, {
				version: 1,
				projectType: "typescript",
				fingerprint: computeFingerprint(fresh),
				lastSessionAt: generatedAt,
				lastIndexedAt: generatedAt,
			});
			const freshHead = initGitRepo(fresh);
			writePromptWiki(fresh, freshHead);
			const freshText = renderPromptContext(fresh).text;
			ok(freshText.includes("<codewiki>available; use code_nav</codewiki>"));
			ok(freshText.includes("<wiki>1 pages at .clio-coder/wiki (start: quickstart.md)</wiki>"));
			ok(freshText.indexOf("<codewiki>") < freshText.indexOf("<wiki>"));

			const stale = scratchProject();
			writeCodewiki(stale, await buildCodewiki({ cwd: stale, language: "typescript", generatedAt }));
			writeClioState(stale, {
				version: 1,
				projectType: "typescript",
				fingerprint: computeFingerprint(stale),
				lastSessionAt: generatedAt,
				lastIndexedAt: generatedAt,
			});
			const staleHead = initGitRepo(stale);
			writePromptWiki(stale, staleHead);
			writeFileSync(join(stale, "src", "extra.ts"), "export const extra = true;\n", "utf8");
			git(stale, ["add", "src/extra.ts"]);
			git(stale, ["commit", "-m", "add extra"]);
			ok(
				renderPromptContext(stale).text.includes(
					"<wiki>1 pages at .clio-coder/wiki (start: quickstart.md) (stale; run clio-coder context wiki --update)</wiki>",
				),
			);
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
					toolPromptHints: [TOOL_HINTS.context],
				};
				const first = await promptsBundle.contract.compileSessionPrompt({ cwd, sessionInputs });
				ok(first.systemPrompt.includes("Keep prompt context compact."));

				// Same inputs compile to the byte-identical prompt: the session
				// prompt is deterministic, so recompiles without underlying change
				// keep the provider prefix cache intact.
				const second = await promptsBundle.contract.compileSessionPrompt({ cwd, sessionInputs });
				strictEqual(second.systemPrompt, first.systemPrompt);
				strictEqual(second.systemPromptHash, first.systemPromptHash);

				// A changed CLIO-CODER.md is reflected in the next compile (the chat-loop
				// decides when to recompile; the compiler never caches stale context).
				writeFileSync(
					join(cwd, "CLIO-CODER.md"),
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
			ok(systemPrompt.includes("everything else about the repository must be fetched, not assumed"));
			ok(systemPrompt.includes("Never invent file paths, automatic tool behavior, or mutable repo details"));
			// The narrow-orientation tool list is stated once, in the Tool Contract.
			ok(systemPrompt.includes('prefer context(scope="workspace"), code_nav, grep, and read'));
			strictEqual(systemPrompt.includes("inspect with code_nav, context, grep, or read before answering"), false);
		});

		it("activates path-scoped project rules from prompt working paths", async () => {
			const cwd = scratchProject();
			mkdirSync(join(cwd, ".clio-coder", "rules"), { recursive: true });
			writeFileSync(join(cwd, ".clio-coder", "rules", "always.md"), "# Always\nKeep generated files small.\n", "utf8");
			writeFileSync(
				join(cwd, ".clio-coder", "rules", "typescript.md"),
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

		it("a worker whose working context touches an active rule's path receives that rule (issue #96)", async () => {
			// The concrete failure named in #96: an operator writes a rule scoped
			// to src/domains/**, the orchestrator dispatches a worker to edit a file
			// under that path, and the worker used to never hear about the rule at
			// all because compileWorker had no additionalFragments channel.
			const cwd = scratchProject();
			mkdirSync(join(cwd, ".clio-coder", "rules"), { recursive: true });
			writeFileSync(join(cwd, ".clio-coder", "rules", "always.md"), "# Always\nKeep generated files small.\n", "utf8");
			writeFileSync(
				join(cwd, ".clio-coder", "rules", "typescript.md"),
				"---\npaths:\n  - 'src/**/*.ts'\n---\n# TypeScript\nPrefer explicit exports for fixture modules.\n",
				"utf8",
			);

			const withoutWorkingPath = await compileWorkerPromptWithFixture(cwd, []);
			ok(withoutWorkingPath.systemPrompt.includes("Keep generated files small."));
			ok(!withoutWorkingPath.systemPrompt.includes("Prefer explicit exports for fixture modules."));

			const withWorkingPath = await compileWorkerPromptWithFixture(cwd, [join(cwd, "src", "index.ts")]);
			ok(withWorkingPath.systemPrompt.includes("Keep generated files small."));
			ok(withWorkingPath.systemPrompt.includes("Prefer explicit exports for fixture modules."));
			ok(withWorkingPath.fragmentManifest.some((f) => f.id === "context.project-rules"));
			// The channel is additionalFragments, appended after the persona, the
			// same section compileWorker already uses for every other addition.
			ok(
				withWorkingPath.systemPrompt.indexOf("Prefer explicit exports for fixture modules.") >
					withWorkingPath.systemPrompt.indexOf(workerPersona().body),
			);
			// #104: the receipt provenance dispatch reads is this same return
			// value, not a re-derivation, so it must name the always-on rule and
			// stay silent on the one that never matched.
			deepStrictEqual(withoutWorkingPath.rulesApplied, ["always.md"]);
			deepStrictEqual(withWorkingPath.rulesApplied, ["always.md", "typescript.md"]);
		});

		it("the operator profile reaches a worker unconditionally: it is small, capped, and governs how the worker should do the task (validation preference, commit style, local-only paths), not just how the orchestrator talks to the operator", async () => {
			const cwd = scratchProject();
			mkdirSync(join(cwd, ".clio-coder"), { recursive: true });
			writeFileSync(
				join(cwd, ".clio-coder", "profile.yaml"),
				"responsePosture: concise\nvalidationPreference: tests-first\ncommitMessageStyle: conventional\nlocalOnlyPaths:\n  - secrets/\n",
				"utf8",
			);

			const compiled = await compileWorkerPromptWithFixture(cwd, []);
			ok(compiled.systemPrompt.includes("## Operator profile"));
			ok(compiled.systemPrompt.includes("Validation preference: tests-first."));
			ok(compiled.systemPrompt.includes("Keep local-only (do not push or share): secrets/."));
			ok(compiled.fragmentManifest.some((f) => f.id === "context.operator-profile"));
			strictEqual(compiled.operatorProfileApplied, true);
		});

		it("a worker with no active rule and no operator profile carries neither section (no byte cost when nothing fires)", async () => {
			const cwd = scratchProject();
			const compiled = await compileWorkerPromptWithFixture(cwd, []);
			strictEqual(compiled.systemPrompt.includes("# Project rules"), false);
			strictEqual(compiled.systemPrompt.includes("## Operator profile"), false);
			strictEqual(
				compiled.fragmentManifest.some((f) => f.id === "context.project-rules" || f.id === "context.operator-profile"),
				false,
			);
			// #104: no rules and no profile means the provenance is explicit
			// emptiness, not an absent field a receipt reader could mistake for
			// "unknown".
			deepStrictEqual(compiled.rulesApplied, []);
			strictEqual(compiled.operatorProfileApplied, false);
		});

		it("context is not described as automatic; the snapshot is an explicit call", () => {
			const spec = createContextTool();
			ok(spec.description.includes("scope=workspace"));
			strictEqual(spec.description.toLowerCase().includes("automatic"), false);
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
				planAgentSelection: () => {
					throw new Error("unexpected agent plan selection");
				},
				snapshot: () => ({
					generatedAt: new Date().toISOString(),
					running: [],
					retrying: [],
					totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, runtimeSeconds: 0 },
				}),
				drain: async () => {},
			};
			const spec = createDispatchTool({ getAgentSpecs: () => [], dispatch });
			strictEqual(spec.description.includes("handoff"), false);
		});
	});
});
