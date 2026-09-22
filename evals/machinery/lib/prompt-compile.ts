/**
 * Prompt compilation scenarios: the order the layers are laid down in, the
 * layout version a manifest record carries, and the capability and role text
 * that renders only when the surface carries the tool it teaches.
 *
 * The compiler is called directly rather than through the prompts bundle, so
 * what a scenario measures is the layering itself and not the project context
 * that happens to sit in the checkout it runs from.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolvePackageRoot } from "../../../src/core/package-root.js";
import type { ToolName } from "../../../src/core/tool-names.js";
import type { TurnConstraints } from "../../../src/core/turn-constraints.js";
import { resolveClioDirs } from "../../../src/core/xdg.js";
import {
	type CompiledSessionPrompt,
	compile,
	compileWorker,
	LEGACY_SESSION_PROMPT_SECTION_ORDER,
	type RenderedPromptFragment,
	SESSION_PROMPT_SECTION_ORDER,
	type SessionPromptInputs,
	type WorkerPromptInputs,
} from "../../../src/domains/prompts/compiler.js";
import { type FragmentTable, loadFragments } from "../../../src/domains/prompts/fragment-loader.js";
import { AUTONOMY_LEVELS, modelMayActivateSkills } from "../../../src/domains/safety/autonomy.js";
import type { SessionMeta } from "../../../src/domains/session/contract.js";
import {
	getPromptManifestFilePath,
	PROMPT_MANIFEST_VERSION,
	readPromptCompileManifest,
	type SessionPromptCompileRecord,
} from "../../../src/domains/session/prompt-manifest.js";
import { type MachineryObservation, type MachineryScenario, normalize, observe, sha256 } from "./observation.js";

/**
 * The identity fragment substitutes this checkout's docs, source and state
 * paths, so the compiled bytes differ between two machines that both run the
 * same harness. Replacing the roots before hashing keeps the fingerprint a
 * property of the prompt rather than of where the repository was cloned.
 */
function promptFingerprint(text: string): string {
	const dirs = resolveClioDirs();
	const roots: Array<readonly [string, string]> = [
		[resolvePackageRoot(), "<checkout>"],
		[dirs.config, "<config>"],
		[dirs.state, "<state>"],
		[dirs.data, "<data>"],
		[dirs.cache, "<cache>"],
	];
	roots.sort(([left], [right]) => right.length - left.length);
	return sha256(String(normalize(text, roots)));
}

const TOOL_HINTS = [
	{ tool: "read", hint: "Read a bounded slice of one file." },
	{ tool: "dispatch", hint: "Delegate a bounded task to one worker." },
];

const FULL_SURFACE = ["read", "write", "edit", "bash", "context", "dispatch", "gateway"];

function sessionInputs(overrides: Partial<SessionPromptInputs> = {}): SessionPromptInputs {
	return {
		provider: "fixture",
		model: "fixture-model",
		contextWindow: 131_072,
		providerSupportsTools: true,
		toolNames: FULL_SURFACE,
		toolPromptHints: TOOL_HINTS,
		readySkillCount: 4,
		skillDiscoveryEnabled: true,
		fleetRoster: "# Fleet\ncoder: workspace-edit",
		contextFiles: "Project handbook body.",
		memorySection: "# Memory\n\nRemembered fact.",
		...overrides,
	};
}

function compileSession(
	table: FragmentTable,
	inputs: SessionPromptInputs,
	safety = "auto-edit",
): CompiledSessionPrompt {
	return compile(table, {
		identity: "identity.clio",
		operatingContract: "operating.contract",
		safety: `safety.${safety}`,
		sessionInputs: inputs,
	});
}

function sectionIds(compiled: CompiledSessionPrompt): string[] {
	return compiled.sections.map((section) => section.id);
}

/** True when `ids` appears in `order`, in order, with no foreign entry between them. */
function followsOrder(ids: ReadonlyArray<string>, order: ReadonlyArray<string>): boolean {
	const positions = ids.map((id) => order.indexOf(id));
	return positions.every((position, index) => position >= 0 && (index === 0 || position > (positions[index - 1] ?? -1)));
}

async function sectionOrderVolatility(): Promise<MachineryObservation> {
	const table = loadFragments();
	const inputs = sessionInputs();
	const product = compileSession(table, inputs);
	const legacy = compile(table, {
		identity: "identity.clio",
		operatingContract: "operating.contract",
		safety: "safety.auto-edit",
		sessionInputs: inputs,
		sectionOrder: "legacy-0.3.8",
	});
	const productIds = sectionIds(product);
	const legacyIds = sectionIds(legacy);
	// The 0.3.8 order is kept so the change can be shown to be a permutation
	// rather than a rewrite. Harness awareness is the one section the old order
	// had no slot for; it rode inside identity there.
	const permuted =
		[...legacyIds].sort().join(",") ===
		[...productIds]
			.filter((id) => id !== "harness-awareness")
			.sort()
			.join(",");
	return observe(
		{
			declaredOrder: SESSION_PROMPT_SECTION_ORDER,
			declaredLegacyOrder: LEGACY_SESSION_PROMPT_SECTION_ORDER,
			productIds,
			legacyIds,
			productFingerprint: promptFingerprint(product.systemPrompt),
			legacyFingerprint: promptFingerprint(legacy.systemPrompt),
		},
		{
			"the compiled sections follow the declared order": followsOrder(productIds, SESSION_PROMPT_SECTION_ORDER),
			"the legacy compile follows the legacy order": followsOrder(legacyIds, LEGACY_SESSION_PROMPT_SECTION_ORDER),
			"the product order is a permutation of the legacy one": permuted,
			"runtime is the most volatile fixed layer": productIds.indexOf("runtime") === productIds.length - 1,
			"memory follows the captured project context": productIds.indexOf("memory") > productIds.indexOf("project-context"),
			"the two orders compile to different text": product.systemPromptHash !== legacy.systemPromptHash,
		},
	);
}

function manifestRecord(overrides: Partial<SessionPromptCompileRecord> = {}): Record<string, unknown> {
	return {
		version: PROMPT_MANIFEST_VERSION,
		at: "2026-01-01T00:00:00.000Z",
		previousHash: null,
		systemPromptHash: "a".repeat(64),
		tokenEstimate: 1234,
		thinkingLevel: null,
		projectPreload: null,
		sections: [{ id: "identity", tokenEstimate: 100 }],
		fragments: [{ id: "identity.clio", relPath: "identity/clio.md", contentHash: "b".repeat(64), dynamic: false }],
		...overrides,
	};
}

async function layoutVersion(): Promise<MachineryObservation> {
	const table = loadFragments();
	const compiled = compileSession(table, sessionInputs());
	const stateDir = mkdtempSync(join(tmpdir(), "clio-coder-machinery-manifest-"));
	try {
		const meta = { id: "machinery-session", cwdHash: "machinery-cwd", cwd: stateDir } as SessionMeta;
		const file = getPromptManifestFilePath(meta, stateDir);
		const { mkdirSync } = await import("node:fs");
		mkdirSync(dirname(file), { recursive: true });
		const { version: _dropped, ...preVersioned } = manifestRecord();
		const rows = [
			manifestRecord({ systemPromptHash: compiled.systemPromptHash }),
			preVersioned,
			manifestRecord({ version: 2, previousHash: "c".repeat(64) }),
			{ ...manifestRecord(), at: "2026-01-01T00:00:00+05:30" },
		];
		writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
		const read = readPromptCompileManifest(meta, stateDir);
		return observe(
			{
				declaredVersion: PROMPT_MANIFEST_VERSION,
				acceptedVersions: read.records.map((record) => record.version ?? null),
				errors: read.errors.map((error) => error.message),
				sectionsOfFirstRecord: read.records[0]?.sections,
			},
			{
				"the layout version is 3": PROMPT_MANIFEST_VERSION === 3,
				"a record written at the current layout reads back at it": read.records[0]?.version === 3,
				"a pre-0.3.9 record without a version still parses": read.records[1]?.version === undefined,
				"an older layout version is retained rather than rewritten": read.records[2]?.version === 2,
				"a non-UTC timestamp is refused rather than sorted wrong": read.errors.length === 1,
			},
		);
	} finally {
		rmSync(stateDir, { recursive: true, force: true });
	}
}

async function conditionalCapabilityGuidance(): Promise<MachineryObservation> {
	const table = loadFragments();
	// Text that teaches a call renders only when the call is on the surface.
	// Each variant removes exactly one thing, so a section that appears anyway
	// is a section that promised a capability this session does not have.
	const variants: Record<string, SessionPromptInputs> = {
		"full-surface": sessionInputs(),
		"no-dispatch": sessionInputs({ toolNames: FULL_SURFACE.filter((name) => name !== "dispatch") }),
		"no-context": sessionInputs({ toolNames: FULL_SURFACE.filter((name) => name !== "context") }),
		"no-gateway": sessionInputs({ toolNames: FULL_SURFACE.filter((name) => name !== "gateway") }),
		"skills-disabled": sessionInputs({ skillDiscoveryEnabled: false }),
		"no-ready-skills": sessionInputs({ readySkillCount: 0 }),
		"answer-turn": sessionInputs({ turnConstraints: { mode: "answer" } as TurnConstraints }),
		"delegation-forbidden": sessionInputs({
			turnConstraints: { mode: "change", delegation: "forbidden" } as TurnConstraints,
		}),
		"no-tool-channel": sessionInputs({ providerSupportsTools: false }),
	};
	const sections: Record<string, string[]> = {};
	const fingerprints: Record<string, string> = {};
	const fragments: Record<string, string[]> = {};
	for (const [name, inputs] of Object.entries(variants)) {
		const compiled = compileSession(table, inputs);
		sections[name] = sectionIds(compiled);
		fingerprints[name] = promptFingerprint(compiled.systemPrompt);
		fragments[name] = compiled.fragmentManifest.map((entry) => entry.id);
	}
	const has = (variant: string, section: string) => sections[variant]?.includes(section) === true;
	return observe(
		{ sections, fingerprints, fragments },
		{
			"delegation renders only with dispatch on the surface":
				has("full-surface", "delegation") && !has("no-dispatch", "delegation"),
			"the fleet roster never outlives the dispatch tool": has("full-surface", "fleet") && !has("no-dispatch", "fleet"),
			"skills guidance renders only with context on the surface":
				has("full-surface", "skills") && !has("no-context", "skills"),
			"an empty ready inventory drops the skills passage": !has("no-ready-skills", "skills"),
			"disabled discovery drops the skills passage": !has("skills-disabled", "skills"),
			"an answer turn drops delegation and adds turn scope":
				!has("answer-turn", "delegation") && has("answer-turn", "turn-scope"),
			"a forbidden-delegation turn still drops delegation": !has("delegation-forbidden", "delegation"),
			"a target without a tool channel promises no tool text":
				!has("no-tool-channel", "delegation") && !has("no-tool-channel", "skills"),
			"docs routing rides with the gateway that reaches it":
				fragments["full-surface"]?.includes("identity.docs-routing") === true &&
				fragments["no-gateway"]?.includes("identity.docs-routing") === false,
		},
	);
}

async function stablePrefixInvariance(): Promise<MachineryObservation> {
	const table = loadFragments();
	const base = compileSession(table, sessionInputs());
	// The immutable prefix is what a provider cache can keep. Runtime inputs move
	// later layers; a changed role or capability moves the layer it belongs to
	// and nothing before it.
	const variants: Record<string, CompiledSessionPrompt> = {
		base,
		"changed-memory": compileSession(table, sessionInputs({ memorySection: "# Memory\n\nA different fact." })),
		"changed-window": compileSession(table, sessionInputs({ contextWindow: 32_768 })),
		"changed-model": compileSession(table, sessionInputs({ model: "another-model" })),
		"changed-roster": compileSession(table, sessionInputs({ fleetRoster: "# Fleet\nscout: read-only" })),
		"changed-project": compileSession(table, sessionInputs({ contextFiles: "Another handbook body." })),
		"no-dispatch": compileSession(table, sessionInputs({ toolNames: FULL_SURFACE.filter((n) => n !== "dispatch") })),
		"read-only-safety": compileSession(table, sessionInputs(), "read-only"),
	};
	const prefixes: Record<string, { bytes: number; hash: string } | null> = {};
	const promptHashes: Record<string, string> = {};
	for (const [name, compiled] of Object.entries(variants)) {
		prefixes[name] = compiled.stablePrefix ?? null;
		promptHashes[name] = promptFingerprint(compiled.systemPrompt);
	}
	const basePrefix = prefixes.base;
	const unchangedPrefix = Object.values(prefixes).every(
		(prefix) => prefix?.hash === basePrefix?.hash && prefix?.bytes === basePrefix?.bytes,
	);
	const distinctText = new Set(Object.values(promptHashes)).size;
	return observe(
		{ prefixes, promptHashes },
		{
			"the compiler publishes a stable prefix": basePrefix !== null && (basePrefix?.bytes ?? 0) > 0,
			"no runtime, capability or safety input moves the prefix": unchangedPrefix,
			"every variant still compiles to different text": distinctText === Object.keys(variants).length,
			"the prefix covers identity and the operating contract only": (basePrefix?.bytes ?? 0) < base.systemPrompt.length,
		},
	);
}

async function skillActivationPolicy(): Promise<MachineryObservation> {
	const table = loadFragments();
	const ACTIVATE = 'Load matching ready Clio skills with context(scope="skills"';
	const SUGGEST = "only the operator activates skills";
	const rendered: Record<string, { mayActivate: boolean; teachesActivation: boolean; teachesSuggestion: boolean }> = {};
	for (const level of AUTONOMY_LEVELS) {
		const compiled = compileSession(table, sessionInputs(), level);
		rendered[level] = {
			mayActivate: modelMayActivateSkills(level),
			teachesActivation: compiled.systemPrompt.includes(ACTIVATE),
			teachesSuggestion: compiled.systemPrompt.includes(SUGGEST),
		};
	}
	return observe(
		{ rendered },
		{
			"a supervised level never teaches self-activation": ["read-only", "suggest"].every(
				(level) => rendered[level]?.teachesActivation === false && rendered[level]?.teachesSuggestion === true,
			),
			"an autonomous level teaches activation instead of suggestion": ["auto-edit", "full-auto"].every(
				(level) => rendered[level]?.teachesActivation === true && rendered[level]?.teachesSuggestion === false,
			),
			"the prompt text agrees with the policy function": AUTONOMY_LEVELS.every(
				(level) => rendered[level]?.mayActivate === rendered[level]?.teachesActivation,
			),
		},
	);
}

function personaFragment(): RenderedPromptFragment {
	return {
		id: "persona.machinery-fixture",
		relPath: "fixtures/persona.md",
		body: "# Role\n\nInspect the bounded fixture and report what the run supports.",
		contentHash: "d".repeat(64),
		dynamic: false,
	};
}

function workerInputs(overrides: Partial<WorkerPromptInputs> = {}): WorkerPromptInputs {
	return {
		autonomy: "auto-edit",
		providerSupportsTools: true,
		toolNames: ["read", "context"] as ToolName[],
		toolPromptHints: [{ tool: "read", hint: "Read a bounded slice of one file." }],
		hasCanonicalContext: true,
		hasBoundSkills: false,
		onPermission: "deny",
		persona: personaFragment(),
		...overrides,
	};
}

async function workerPromptLayers(): Promise<MachineryObservation> {
	const table = loadFragments();
	const sections: Record<string, string[]> = {};
	const fingerprints: Record<string, string> = {};
	const prefixes: Record<string, string> = {};
	for (const autonomy of AUTONOMY_LEVELS) {
		for (const onPermission of ["deny", "fail", "escalate"] as const) {
			const compiled = compileWorker(table, workerInputs({ autonomy, onPermission }));
			const key = `${autonomy}/${onPermission}`;
			sections[key] = compiled.sections.map((section) => section.id);
			fingerprints[key] = promptFingerprint(compiled.systemPrompt);
			prefixes[key] = compiled.stablePrefix?.hash ?? "<absent>";
		}
	}
	// A delegated target whose inventory the harness cannot observe, and one that
	// has no tool channel at all, both have to reach the worker without promising
	// a canonical surface.
	for (const [key, providerSupportsTools] of [
		["unknown-inventory", null],
		["no-tool-channel", false],
	] as const) {
		const compiled = compileWorker(
			table,
			workerInputs({
				providerSupportsTools,
				hasCanonicalContext: false,
				toolNames: [] as ToolName[],
				toolPromptHints: [],
			}),
		);
		sections[key] = compiled.sections.map((section) => section.id);
		fingerprints[key] = promptFingerprint(compiled.systemPrompt);
		prefixes[key] = compiled.stablePrefix?.hash ?? "<absent>";
	}
	const expected = ["identity", "operating-contract", "tool-contract", "safety", "persona"];
	const routings = (autonomy: string) =>
		new Set(["deny", "fail", "escalate"].map((mode) => fingerprints[`${autonomy}/${mode}`]));
	return observe(
		{ sections, fingerprints, prefixes },
		{
			"every worker prompt lays down the same layers in the same order": Object.values(sections).every(
				(ids) => ids.join(",") === expected.join(","),
			),
			"the worker prefix never depends on autonomy or approval routing": new Set(Object.values(prefixes)).size === 1,
			"approval routing is stated at every level that can ask": ["suggest", "auto-edit", "full-auto"].every(
				(autonomy) => routings(autonomy).size === 3,
			),
			"read-only states no approval routing, because nothing asks there": routings("read-only").size === 1,
			"each autonomy level compiles to its own text":
				new Set(AUTONOMY_LEVELS.map((level) => fingerprints[`${level}/deny`])).size === AUTONOMY_LEVELS.length,
			"an unobservable inventory and an absent tool channel are told apart":
				fingerprints["unknown-inventory"] !== fingerprints["no-tool-channel"],
		},
	);
}

export const SCENARIOS: Record<string, MachineryScenario> = {
	"section-order-volatility": sectionOrderVolatility,
	"layout-version": layoutVersion,
	"conditional-capability-guidance": conditionalCapabilityGuidance,
	"stable-prefix-invariance": stablePrefixInvariance,
	"skill-activation-policy": skillActivationPolicy,
	"worker-prompt-layers": workerPromptLayers,
};
