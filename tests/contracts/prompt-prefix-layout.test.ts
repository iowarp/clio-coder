/**
 * Issue #249: the compiled prompt is ordered stable prefix first.
 *
 * Every backend Clio targets caches by exact prefix and re-prefills from the
 * earliest changed byte. Through 0.3.8 the `runtime` block sat sixth of eleven
 * sections and the `memory` block tenth, so a moved `Context window: N` or one
 * approved memory record re-prefilled everything behind it. These tests pin
 * the new order, prove the change is a permutation of the old one rather than
 * a rewrite of the text, and drive the manifest bump over a real session.
 */

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	type CompileInputs,
	compile,
	LEGACY_SESSION_PROMPT_SECTION_ORDER,
	SESSION_PROMPT_SECTION_ORDER,
	type SessionPromptInputs,
} from "../../src/domains/prompts/compiler.js";
import type { PromptsContract } from "../../src/domains/prompts/contract.js";
import { loadFragments } from "../../src/domains/prompts/fragment-loader.js";
import type { ProvidersContract, TargetStatus } from "../../src/domains/providers/contract.js";
import { resolveRuntimeTarget } from "../../src/domains/providers/runtime-resolution.js";
import { EMPTY_CAPABILITIES } from "../../src/domains/providers/types/capability-flags.js";
import type { RuntimeDescriptor } from "../../src/domains/providers/types/runtime-descriptor.js";
import type { TargetDescriptor } from "../../src/domains/providers/types/target-descriptor.js";
import { appendContextSnapshot, captureContextSnapshot } from "../../src/domains/session/context-accounting.js";
import type { SessionEntry } from "../../src/domains/session/entries.js";
import {
	appendPromptCompileRecord,
	PROMPT_MANIFEST_VERSION,
	promptManifestVersion,
	readPromptCompileRecords,
} from "../../src/domains/session/prompt-manifest.js";
import type { AgentRuntime } from "../../src/interactive/turn-state.js";
import { createScenarioHarness, type ScenarioHarness } from "../harness/working-set-session.js";

const MODEL = "qwen3.8-27b-dense";
const LOADED_WINDOW = 262_144;
const PROBED_WINDOW = 786_432;

/** Every optional section populated, so a permutation proof has all eleven to permute. */
function fullSessionInputs(): SessionPromptInputs {
	return {
		provider: "mini",
		model: MODEL,
		contextWindow: LOADED_WINDOW,
		providerSupportsTools: true,
		thinkingGuidance: "Think before answering.",
		toolNames: ["bash", "context", "dispatch", "edit", "read"],
		toolPromptHints: [
			{ tool: "dispatch", hint: "Dispatch delegates one bounded task." },
			{ tool: "read", hint: "Read narrow ranges." },
		],
		fleetRoster: "# Fleet\n\n- `coder` writes code.",
		contextFiles: "Project handbook line one.\nProject handbook line two.",
		memorySection: "# Memory\n\nApproved long-term memory records that may apply.\n\n- [m1] (scope=global) A lesson.",
	};
}

function compileFull(order?: CompileInputs["sectionOrder"]) {
	return compile(loadFragments(), {
		identity: "identity.clio",
		operatingContract: "operating.contract",
		safety: "safety.auto-edit",
		sessionInputs: fullSessionInputs(),
		additionalFragments: [
			{
				id: "context.workspace-root",
				relPath: "context/workspace-root.md",
				body: "# Workspace\n\n/tmp/scratch",
				contentHash: "a".repeat(64),
				dynamic: true,
			},
			{
				id: "context.project-rules",
				relPath: "context/project-rules.md",
				body: "# Project rules\n\nAlways run the tests.",
				contentHash: "b".repeat(64),
				dynamic: true,
			},
		],
		...(order ? { sectionOrder: order } : {}),
	});
}

function lineCounts(text: string): Map<string, number> {
	const counts = new Map<string, number>();
	for (const line of text.split("\n")) counts.set(line, (counts.get(line) ?? 0) + 1);
	return counts;
}

describe("contracts/prompt prefix layout (#249)", () => {
	/**
	 * The pin. A section goes as late as its volatility: anything that reads a
	 * clock, a probe, or a mutable store goes after everything that does not.
	 * `runtime` carries `Context window: N`, which moves when the backend
	 * reloads a model or a co-residency clamp lands, so it is last; `memory` is
	 * rewritten whenever a record is approved, so it sits behind the
	 * session-stable `project-context`. Changing this list re-prefills every
	 * cached prompt on every local backend, so change it on purpose.
	 */
	it("pins the section order", () => {
		deepStrictEqual(
			[...SESSION_PROMPT_SECTION_ORDER],
			[
				"identity",
				"operating-contract",
				"delegation",
				"skills",
				"safety",
				"tool-contract",
				"fleet",
				"retrieval-hints",
				"project-context",
				"memory",
				"runtime",
			],
		);
		const compiled = compileFull();
		const ids = compiled.sections.map((section) => section.id);
		deepStrictEqual(
			ids.slice(0, SESSION_PROMPT_SECTION_ORDER.length),
			[...SESSION_PROMPT_SECTION_ORDER],
			"a fully populated compile lays down every pinned section, in order",
		);
		deepStrictEqual(
			ids.slice(SESSION_PROMPT_SECTION_ORDER.length),
			["context.workspace-root", "context.project-rules"],
			"the operator-editable tail fragments stay behind the pinned sections",
		);
	});

	it("keeps the two orders the same set of sections", () => {
		deepStrictEqual(
			[...LEGACY_SESSION_PROMPT_SECTION_ORDER].sort(),
			[...SESSION_PROMPT_SECTION_ORDER].sort(),
			"the 0.3.8 order holds the same eleven ids, in different places",
		);
		strictEqual(LEGACY_SESSION_PROMPT_SECTION_ORDER[5], "runtime", "0.3.8 put the volatile window sixth of eleven");
		const next = compileFull().sections.map((section) => section.id);
		const legacy = compileFull("legacy-0.3.8").sections.map((section) => section.id);
		deepStrictEqual([...next].sort(), [...legacy].sort(), "no section was added or dropped");
		ok(next.join(",") !== legacy.join(","), "and the order did move");
	});

	/**
	 * The permutation proof. Every line of the compiled prompt survives the
	 * reorder with the same multiplicity, except the one duplicate `# Memory`
	 * header (and the blank line under it) that `renderMemoryBlock` used to
	 * prepend on top of the header the memory renderer already writes. No
	 * section's wording changed.
	 */
	it("changes the compiled output by a permutation plus the duplicate memory header", () => {
		const next = compileFull().systemPrompt;
		const legacy = compileFull("legacy-0.3.8").systemPrompt;
		ok(next !== legacy, "the bytes moved");

		const before = lineCounts(legacy);
		const after = lineCounts(next);
		const removed: string[] = [];
		for (const [line, count] of before) {
			const nowCount = after.get(line) ?? 0;
			ok(nowCount <= count, `line gained an occurrence: ${JSON.stringify(line)}`);
			for (let i = nowCount; i < count; i += 1) removed.push(line);
		}
		for (const line of after.keys()) {
			ok(before.has(line), `line is new text, not a moved line: ${JSON.stringify(line)}`);
		}
		deepStrictEqual(removed.sort(), ["", "# Memory"], "exactly one duplicate header and its blank line came out");

		strictEqual(next.split("# Memory").length - 1, 1, "the compiled prompt carries one Memory header");
		ok(next.includes("Context window: 262144"));
		ok(next.trimEnd().endsWith("Always run the tests."), "project rules stay at the very tail");
	});

	it("puts every volatile section behind every stable one", () => {
		const prompt = compileFull().systemPrompt;
		const at = (needle: string): number => {
			const index = prompt.indexOf(needle);
			ok(index >= 0, `section missing: ${needle}`);
			return index;
		};
		ok(at("# Tool Contract") < at("# Runtime"), "a moved context window no longer re-prefills the tool contract");
		ok(at("# Fleet") < at("# Runtime"));
		ok(at("# Retrieval Hints") < at("# Runtime"));
		ok(at("# Project") < at("# Memory"), "an approved memory record no longer re-prefills project context");
		ok(at("# Memory") < at("# Runtime"));
	});

	it("adds a Memory header only when the section does not already carry one", () => {
		const table = loadFragments();
		const base = {
			identity: "identity.clio",
			operatingContract: "operating.contract",
			safety: "safety.auto-edit",
		} as const;
		const bare = compile(table, {
			...base,
			sessionInputs: { provider: "p", model: "m", memorySection: "- [m1] A lesson." },
		}).systemPrompt;
		ok(bare.includes("# Memory\n\n- [m1] A lesson."), "a bare body still gets a header");
		strictEqual(bare.split("# Memory").length - 1, 1);

		const rendered = compile(table, {
			...base,
			sessionInputs: { provider: "p", model: "m", memorySection: "# Memory\n\n- [m1] A lesson." },
		}).systemPrompt;
		strictEqual(rendered.split("# Memory").length - 1, 1, "a rendered section keeps the one header it wrote");
	});
});

/** A target that probes the server's whole KV pool and says nothing about what is open. */
function probeOnlyProviders(): ProvidersContract {
	const runtime: RuntimeDescriptor = {
		id: "llamacpp",
		displayName: "llama.cpp",
		kind: "http",
		tier: "local-native",
		apiFamily: "openai-completions",
		auth: "none",
		defaultCapabilities: { ...EMPTY_CAPABILITIES, chat: true, tools: true, maxTokens: 4096 },
		synthesizeModel: () => ({ id: MODEL, provider: "llamacpp" }) as never,
	};
	const target: TargetDescriptor = {
		id: "mini",
		runtime: "llamacpp",
		url: "http://192.168.86.141:8080",
		defaultModel: MODEL,
	};
	const status: TargetStatus = {
		target,
		runtime,
		available: true,
		reason: "ready",
		health: { status: "healthy", lastCheckAt: null, lastError: null, latencyMs: 4 },
		capabilities: { ...EMPTY_CAPABILITIES, chat: true, tools: true, contextWindow: PROBED_WINDOW },
		probeModelCapabilities: { [MODEL]: { contextWindow: PROBED_WINDOW } },
		probeModelId: MODEL,
		discoveredModels: [MODEL],
		discoveredModelsSource: "probe",
		discoveredModelStates: null,
	} as never;
	return {
		list: () => [status],
		getTarget: (id: string) => (id === "mini" ? target : null),
		getRuntime: (id: string) => (id === "llamacpp" ? runtime : null),
		getDetectedReasoning: () => null,
		knowledgeBase: null,
	} as never;
}

/** The real compiler behind the contract the turn context calls. */
function compilingPrompts(): PromptsContract {
	const table = loadFragments();
	return {
		async compileSessionPrompt(input) {
			return compile(table, {
				identity: "identity.clio",
				operatingContract: "operating.contract",
				safety: `safety.${input.autonomy ?? "auto-edit"}`,
				sessionInputs: input.sessionInputs,
			});
		},
		async compileWorkerPrompt() {
			throw new Error("not used");
		},
		reload() {},
	} as PromptsContract;
}

interface PromptRecompiledData {
	previousHash: string | null;
	hash: string;
	tokenEstimate: number;
}

function promptRecompiledEntries(entries: ReadonlyArray<SessionEntry>): PromptRecompiledData[] {
	return entries
		.filter((entry): entry is Extract<SessionEntry, { kind: "custom" }> => entry.kind === "custom")
		.filter((entry) => entry.customType === "promptRecompiled")
		.map((entry) => entry.data as PromptRecompiledData);
}

/** The harness runtime holds a plain details object; scenarios set the window on it. */
function setWindowDetails(
	runtime: AgentRuntime,
	details: { effectiveContextWindow: number; loadedContextWindow: number | null; contextWindowSource: string },
): void {
	Object.assign(runtime.runtimeResolution.contextWindowDetails, details);
}

describe("contracts/prompt manifest bump on a resumed 0.3.8 session (#249)", () => {
	it("writes one promptRecompiled entry carrying the previous and the new hash", async () => {
		const harness: ScenarioHarness = await createScenarioHarness({
			prefix: "prefix-layout-bump",
			prompts: compilingPrompts(),
		});
		try {
			const meta = harness.session.current();
			ok(meta);

			// What 0.3.8 left behind: a manifest record with no version field and
			// no window provenance, describing the prompt this session last served.
			const legacyHash = "c".repeat(64);
			appendPromptCompileRecord(meta, {
				at: "2026-08-20T00:00:00.000Z",
				previousHash: null,
				systemPromptHash: legacyHash,
				tokenEstimate: 4096,
				thinkingLevel: "off",
				projectPreload: null,
				sections: [
					{ id: "identity", tokenEstimate: 100 },
					{ id: "runtime", tokenEstimate: 20 },
					{ id: "tool-contract", tokenEstimate: 200 },
					{ id: "memory", tokenEstimate: 30 },
					{ id: "project-context", tokenEstimate: 40 },
				],
				fragments: [],
			} as never);
			const before = readPromptCompileRecords(meta);
			strictEqual(before.length, 1, "the 0.3.8 record still parses");
			strictEqual(promptManifestVersion(before[0] as never), 1);

			setWindowDetails(harness.runtime, {
				effectiveContextWindow: LOADED_WINDOW,
				loadedContextWindow: LOADED_WINDOW,
				contextWindowSource: "loaded",
			});

			const first = await harness.context.ensureSessionPrompt(harness.runtime);
			ok(first);
			harness.context.logPromptCompileIfPending();
			// A second submit reuses the cached prompt byte-for-byte, and a third
			// after a cache invalidation recompiles to the same text: neither may
			// add a second entry.
			await harness.context.ensureSessionPrompt(harness.runtime);
			harness.context.invalidateSessionPromptCache();
			await harness.context.ensureSessionPrompt(harness.runtime);
			harness.context.logPromptCompileIfPending();

			const recompiled = promptRecompiledEntries(harness.entries());
			strictEqual(recompiled.length, 1, "exactly one promptRecompiled entry for the upgrade");
			const data = recompiled[0];
			ok(data);
			// A non-null previousHash is also the gate brief 01 (#247) reads: its
			// `logPromptCompileIfPending` stamps the `prompt_recompiled`
			// expected-cold reason only when the entry names a prompt it replaced.
			// Before this change a resumed session reported null there, so the one
			// turn the stamp exists to explain was the one turn it could not fire
			// on. The stamp assertion itself lands when #247 merges.
			strictEqual(data.previousHash, legacyHash, "the entry names the 0.3.8 prompt it replaced");
			strictEqual(data.hash, first.systemPromptHash, "and the prompt now served");

			const records = readPromptCompileRecords(meta);
			strictEqual(records.length, 2, "one manifest record for the recompile");
			const latest = records[1];
			ok(latest);
			strictEqual(promptManifestVersion(latest), PROMPT_MANIFEST_VERSION);
			strictEqual(latest.systemPromptHash, first.systemPromptHash);
			strictEqual(latest.previousHash, legacyHash);
			deepStrictEqual(
				latest.sections.map((section) => section.id),
				[...SESSION_PROMPT_SECTION_ORDER].filter((id) => latest.sections.some((section) => section.id === id)),
				"the record's sections are in the pinned order",
			);
			strictEqual(latest.sections[latest.sections.length - 1]?.id, "runtime");
		} finally {
			await harness.dispose();
		}
	});

	it("states the session's loaded window, not the probe, in the Runtime block", async () => {
		const harness: ScenarioHarness = await createScenarioHarness({
			prefix: "prefix-layout-window",
			prompts: compilingPrompts(),
		});
		try {
			const meta = harness.session.current();
			ok(meta);

			// The previous process recorded what the backend had open (#227).
			appendContextSnapshot(
				meta,
				captureContextSnapshot({
					sessionId: meta.id,
					turnId: "t1",
					providerId: "mini",
					runtimeId: "llamacpp",
					modelId: MODEL,
					conversationMessages: [],
					activeToolSchemas: [],
					desiredContextWindow: PROBED_WINDOW,
					effectiveContextWindow: LOADED_WINDOW,
					contextWindowSource: "loaded",
					compactionThreshold: 0.8,
				}),
			);

			const providers = probeOnlyProviders();
			const probed = resolveRuntimeTarget(providers, { targetId: "mini", wireModelId: MODEL, use: "orchestrator" });
			ok(probed.ok);
			strictEqual(probed.target.contextWindowDetails.effectiveContextWindow, PROBED_WINDOW);

			const resumed = resolveRuntimeTarget(providers, {
				targetId: "mini",
				wireModelId: MODEL,
				use: "orchestrator",
				knownLoadedContextWindow: harness.context.rememberedLoadedContextWindow("mini", MODEL),
			});
			ok(resumed.ok);
			strictEqual(resumed.target.contextWindowDetails.contextWindowSource, "loaded");
			strictEqual(resumed.target.contextWindowDetails.effectiveContextWindow, LOADED_WINDOW);

			harness.runtime.runtimeResolution.contextWindowDetails = resumed.target.contextWindowDetails;
			const compiled = await harness.context.ensureSessionPrompt(harness.runtime);
			ok(compiled);
			ok(
				compiled.systemPrompt.includes(`Context window: ${LOADED_WINDOW}`),
				"N is the window the ledger recorded as loaded",
			);
			strictEqual(compiled.systemPrompt.includes(`Context window: ${PROBED_WINDOW}`), false);

			harness.context.logPromptCompileIfPending();
			const records = readPromptCompileRecords(meta);
			strictEqual(records.length, 1);
			strictEqual(records[0]?.contextWindow, LOADED_WINDOW);
			strictEqual(records[0]?.contextWindowSource, "loaded", "the record explains where N came from");
		} finally {
			await harness.dispose();
		}
	});

	it("records a probe as a probe, and prefers a known loaded window over one", async () => {
		const harness: ScenarioHarness = await createScenarioHarness({
			prefix: "prefix-layout-probe",
			prompts: compilingPrompts(),
		});
		try {
			const meta = harness.session.current();
			ok(meta);

			// First compile of a fresh session: nothing has said what is loaded, so
			// N is the resolved figure and the record says the source was a probe.
			setWindowDetails(harness.runtime, {
				effectiveContextWindow: PROBED_WINDOW,
				loadedContextWindow: null,
				contextWindowSource: "probe",
			});
			const probed = await harness.context.ensureSessionPrompt(harness.runtime);
			ok(probed);
			ok(probed.systemPrompt.includes(`Context window: ${PROBED_WINDOW}`));
			harness.context.logPromptCompileIfPending();
			strictEqual(readPromptCompileRecords(meta)[0]?.contextWindowSource, "probe");

			// Discovery then reports the open window while the probe figure is still
			// in the details. The loaded value outranks it.
			setWindowDetails(harness.runtime, {
				effectiveContextWindow: PROBED_WINDOW,
				loadedContextWindow: LOADED_WINDOW,
				contextWindowSource: "probe",
			});
			harness.context.invalidateSessionPromptCache();
			const loaded = await harness.context.ensureSessionPrompt(harness.runtime);
			ok(loaded);
			ok(loaded.systemPrompt.includes(`Context window: ${LOADED_WINDOW}`));
			harness.context.logPromptCompileIfPending();
			const records = readPromptCompileRecords(meta);
			strictEqual(records.length, 2);
			strictEqual(records[1]?.contextWindowSource, "loaded");
			strictEqual(records[1]?.previousHash, probed.systemPromptHash);
		} finally {
			await harness.dispose();
		}
	});
});
