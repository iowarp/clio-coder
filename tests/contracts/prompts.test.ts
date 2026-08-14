import { notStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
			'Call context with scope="skills" to list available skills; when one matches the task, suggest the operator run /skill:<name> and never load it uninvited. When the user message carries a skill request, first load that skill via context (scope="skills", name=<skill>) before doing anything else.',
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
		ok(unbound.systemPrompt.includes('first call context (scope="skills")'));
		ok(/Only an explicit\s+operator request activates a skill/.test(unbound.systemPrompt));

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

	it("operating contract carries skill awareness with the operator gate intact", () => {
		const table = loadFragments();
		const result = compile(table, {
			identity: "identity.clio",
			operatingContract: "operating.contract",
			safety: "safety.auto-edit",
			sessionInputs: { provider: "p", model: "m" },
		});
		// The fragment is hard-wrapped; compare against whitespace-normalized text.
		const flat = result.systemPrompt.replace(/\s+/g, " ");
		// The passage tells the agent to check the catalog on skill-shaped tasks
		// and to suggest matches (or a sequence) to the operator.
		ok(flat.includes('context (scope="skills")'));
		ok(flat.includes("/skill:<name>"));
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
		const result = compile(table, {
			identity: "identity.clio",
			operatingContract: "operating.contract",
			safety: "safety.auto-edit",
			sessionInputs: { provider: "p", model: "m" },
		});
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
			sessionInputs: { provider: "p", model: "m" },
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
		ok(result.systemPrompt.includes('Call context with scope="skills" to list available skills'));
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
			'When answering capability-inventory questions, copy the Direct tools line above verbatim rather than recalling the attached schemas, and make no calls; add dispatch(list:true) only if agents or the fleet are requested; add context(scope="skills") only if skills are requested.',
			"Call tools only for concrete inspection or changes the task requires. If the user asks for a tool-free answer, simply answer without calling tools.",
			'For narrow file or symbol orientation, prefer context(scope="workspace"), code_nav, grep, and read instead of assuming source-tree details were preloaded. When dispatch is available, explicit broad repository/codebase exploration uses agent:"auto" before repo-wide reads.',
			'Routing order: use structured observe tools before bash for narrow inspection; when the request has three or more steps, declare a tasks board (action="plan") before the first edit; treat broad reconnaissance as a bounded agent:"auto" handoff, dispatch other bounded parallel or delegated subwork, and synthesize receipts; validate with verify or git diff before final claims.',
			'When a tool call fails or is rejected, do not retry the same shape blindly: re-read the schema, adjust the arguments, or query context(scope="docs") for that tool\'s usage.',
			'List installed skills with context(scope="skills") only when the task is skill-shaped or the operator asks about skills; if one matches, suggest the operator run /skill:<name>, and never load a skill the operator did not request.',
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
		for (const route of [
			"pin the `agent` id from the Fleet section above",
			'agent:"auto" baselines from the task text and is a fallback, not a router',
			"Broad repo/codebase exploration goes to a worker before repo-wide reads",
			"Give each dispatch a concrete handoff and synthesize its receipt",
		]) {
			ok(withDispatch.systemPrompt.includes(route), route);
		}
		const withoutDispatch = compile(table, {
			identity: "identity.clio",
			operatingContract: "operating.contract",
			safety: "safety.auto-edit",
			sessionInputs: { providerSupportsTools: true, toolPromptHints: [] },
		});
		strictEqual(withoutDispatch.systemPrompt.includes(FLEET_ROUTING_GUIDANCE), false);
	});

	it("gates skill listing to skill-shaped tasks and teaches routing order plus failure recovery", () => {
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
		// broad trigger must stay gone.
		strictEqual(prompt.includes("For a multi-step task, list installed skills"), false);
		ok(prompt.includes('List installed skills with context(scope="skills") only when the task is skill-shaped'));
		ok(prompt.includes("never load a skill the operator did not request"));

		// The deterministic routing order and failure recovery are static base
		// lines, present regardless of which hinted tools are on the surface.
		ok(prompt.includes("Routing order: use structured observe tools before bash for narrow inspection"));
		ok(prompt.includes('treat broad reconnaissance as a bounded agent:"auto" handoff'));
		ok(prompt.includes("dispatch other bounded parallel or delegated subwork, and synthesize receipts"));
		ok(prompt.includes("validate with verify or git diff before final claims"));
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
		strictEqual(result.systemPrompt.includes('Call context with scope="skills" to list available skills'), false);
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
		ok(freshText.includes("<wiki>1 pages at .clio/wiki (start: quickstart.md)</wiki>"));
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
				"<wiki>1 pages at .clio/wiki (start: quickstart.md) (stale; run clio context wiki --update)</wiki>",
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
		ok(systemPrompt.includes("inspect with code_nav, context, grep, or read before answering"));
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
