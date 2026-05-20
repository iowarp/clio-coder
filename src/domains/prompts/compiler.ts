import type { ThinkingMechanism } from "../providers/types/local-model-quirks.js";
import type { FragmentTable, LoadedFragment } from "./fragment-loader.js";
import { sha256 } from "./hash.js";

export interface CompileInputs {
	identity: string;
	mode: string;
	safety: string;
	dynamicInputs: DynamicInputs;
	additionalFragments?: ReadonlyArray<RenderedPromptFragment>;
}

export interface DynamicInputs {
	provider?: string | null;
	model?: string | null;
	contextWindow?: number | null;
	thinkingBudget?: string | null;
	thinkingMechanism?: ThinkingMechanism | null;
	thinkingApplied?: "applied" | "ignored-on-off" | "always-on" | "unsupported" | null;
	thinkingNotice?: string | null;
	thinkingGuidance?: string | null;
	familyGuidance?: string | null;
	sessionNotes?: string;
	contextFiles?: string;
	projectType?: string | null;
	agentCatalog?: string;
	agentCatalogStable?: string;
	agentCatalogDelta?: string;
	skillsCatalog?: string;
	memorySection?: string;
	turnCount?: number;
	clioVersion?: string;
	piMonoVersion?: string;
}

export interface FragmentManifestEntry {
	id: string;
	relPath: string;
	contentHash: string;
	dynamic: boolean;
}

export interface PromptSegmentManifestEntry {
	id: string;
	contentHash: string;
	dynamic: boolean;
	tier: PromptTier;
	tokenEstimate: number;
}

export interface RenderedPromptFragment {
	id: string;
	relPath: string;
	body: string;
	contentHash: string;
	dynamic: boolean;
}

export type PromptTier = "static-shell" | "session-shell" | "dynamic-turn";

export interface DynamicPromptFragment {
	id: string;
	body: string;
	contentHash: string;
	tokenEstimate: number;
}

export interface CompileResult {
	/** Full prompt text retained for older callers and reproducibility. */
	text: string;
	/** Stable provider-facing system prompt: static shell + semi-static session shell. */
	systemPrompt: string;
	/** Ordered volatile fragments to send as messages before the real user turn. */
	dynamicPromptFragments: ReadonlyArray<DynamicPromptFragment>;
	renderedPromptHash: string;
	fragmentManifest: ReadonlyArray<FragmentManifestEntry>;
	segmentManifest: ReadonlyArray<PromptSegmentManifestEntry>;
	staticShellHash: string;
	sessionShellHash: string;
	dynamicHash: string;
	staticShellTokenEstimate: number;
	dynamicInputs: Readonly<DynamicInputs>;
}

function lookupFragment(table: FragmentTable, id: string, role: string): LoadedFragment {
	const frag = table.byId.get(id);
	if (!frag) {
		throw new Error(`prompts/compiler: ${role} fragment id "${id}" not found`);
	}
	return frag;
}

function safetyOneLiner(level: string): string {
	switch (level) {
		case "suggest":
			return "describe the work; do not modify files or run effectful commands.";
		case "auto-edit":
			return "edits inside the workspace are allowed; execute-class actions need confirmation.";
		case "full-auto":
			return "edits and local commands are allowed; system_modify and git_destructive remain gated.";
		default:
			return "follow the active safety contract.";
	}
}

function renderSafetySection(safetyFragment: LoadedFragment, level: string): string {
	const oneLine = `Safety: ${level}. ${safetyOneLiner(level)}`;
	const body = safetyFragment.body.trim();
	return body.length > 0 ? `${oneLine}\n\n${body}` : oneLine;
}

function renderRuntimeBlock(inputs: DynamicInputs): string {
	const lines: string[] = ["# Runtime"];
	const provider = inputs.provider ?? "";
	const model = inputs.model ?? "";
	if (provider.length > 0) lines.push(`Provider: ${provider}`);
	if (model.length > 0) lines.push(`Model: ${model}`);
	if (typeof inputs.contextWindow === "number" && inputs.contextWindow > 0) {
		lines.push(`Context window: ${inputs.contextWindow}`);
	}
	if (typeof inputs.thinkingBudget === "string" && inputs.thinkingBudget.length > 0) {
		lines.push(`Thinking level: ${inputs.thinkingBudget}`);
	}
	if (typeof inputs.thinkingMechanism === "string" && inputs.thinkingMechanism.length > 0) {
		lines.push(`Thinking mechanism: ${inputs.thinkingMechanism}`);
	}
	if (typeof inputs.thinkingApplied === "string" && inputs.thinkingApplied.length > 0) {
		lines.push(`Thinking applied: ${inputs.thinkingApplied}`);
	}
	if (typeof inputs.thinkingNotice === "string" && inputs.thinkingNotice.length > 0) {
		lines.push(`Note: ${inputs.thinkingNotice}`);
	}
	const guidance = inputs.thinkingGuidance?.trim();
	if (guidance && guidance.length > 0) {
		lines.push("");
		lines.push(guidance);
	}
	const familyGuidance = inputs.familyGuidance?.trim();
	if (familyGuidance && familyGuidance.length > 0) {
		lines.push("");
		lines.push(familyGuidance);
	}
	return lines.join("\n");
}

function renderProjectBlock(contextFiles: string | undefined, projectType: string | null | undefined): string {
	const trimmedFiles = contextFiles?.trim() ?? "";
	const trimmedType = typeof projectType === "string" ? projectType.trim() : "";
	const hasType = trimmedType.length > 0 && trimmedType !== "unknown";
	if (trimmedFiles.length === 0 && !hasType) return "";
	const lines: string[] = ["# Project"];
	if (hasType) {
		lines.push("");
		lines.push(`Language: ${trimmedType}`);
	}
	if (trimmedFiles.length > 0) {
		lines.push("");
		lines.push(trimmedFiles);
	}
	return lines.join("\n");
}

function renderMemoryBlock(memorySection: string | undefined): string {
	const trimmed = memorySection?.trim() ?? "";
	if (trimmed.length === 0) return "";
	return `# Memory\n\n${trimmed}`;
}

function renderAgentCatalogBlock(agentCatalog: string | undefined): string {
	const trimmed = agentCatalog?.trim() ?? "";
	if (trimmed.length === 0) return "";
	return `# Agent Fleet\n\n${trimmed}`;
}

function renderAgentCatalogStableBlock(agentCatalog: string | undefined): string {
	return renderAgentCatalogBlock(agentCatalog);
}

function renderAgentCatalogDeltaBlock(agentCatalog: string | undefined): string {
	const trimmed = agentCatalog?.trim() ?? "";
	if (trimmed.length === 0) return "";
	return `# Agent Fleet Status\n\n${trimmed}`;
}

function renderSkillsCatalogBlock(skillsCatalog: string | undefined): string {
	const trimmed = skillsCatalog?.trim() ?? "";
	if (trimmed.length === 0) return "";
	return trimmed.startsWith("# Skills") ? trimmed : `# Skills\n\n${trimmed}`;
}

function renderSessionBlock(inputs: DynamicInputs): string {
	const sessionNotes = inputs.sessionNotes?.trim() ?? "";
	const turnCount = typeof inputs.turnCount === "number" ? inputs.turnCount : 0;
	if (sessionNotes.length === 0 && turnCount === 0) return "";
	const lines: string[] = ["# Session"];
	if (turnCount > 0) lines.push(`Turn count: ${turnCount}`);
	if (sessionNotes.length > 0) {
		if (turnCount > 0) lines.push("");
		lines.push(sessionNotes);
	}
	return lines.join("\n");
}

function estimatePromptTokens(text: string): number {
	const trimmed = text.trim();
	if (trimmed.length === 0) return 0;
	return Math.ceil(trimmed.length / 4);
}

function pushSegment(
	segments: PromptSegmentManifestEntry[],
	parts: string[],
	id: string,
	body: string,
	dynamic: boolean,
	tier: PromptTier,
): void {
	const trimmed = body.trim();
	if (trimmed.length === 0) return;
	parts.push(trimmed);
	segments.push({
		id,
		contentHash: sha256(trimmed),
		dynamic,
		tier,
		tokenEstimate: estimatePromptTokens(trimmed),
	});
}

/**
 * Compile a Clio prompt from the supplied fragment table and inputs.
 *
 * Identity and the active mode render verbatim from disk fragments. Safety
 * renders a single one-line directive followed by the active mode's safety
 * fragment body. Everything else renders inline from typed DynamicInputs:
 * runtime metadata (provider, model, context window, thinking mechanism,
 * thinking applied/notice/guidance, family guidance), skills catalog, memory,
 * project context, and session state.
 *
 * One reproducibility hash travels with the rendered text: `renderedPromptHash`
 * is sha256 over the final text. Receipts written by older builds remain
 * readable under the same field name.
 */
export function compile(table: FragmentTable, inputs: CompileInputs): CompileResult {
	const identity = lookupFragment(table, inputs.identity, "identity");
	const mode = lookupFragment(table, inputs.mode, "mode");
	const safety = lookupFragment(table, inputs.safety, "safety");

	const safetyLevel = safety.id.startsWith("safety.") ? safety.id.slice("safety.".length) : safety.id;
	const parts: string[] = [];
	const segmentManifest: PromptSegmentManifestEntry[] = [];
	pushSegment(segmentManifest, parts, "identity", identity.body, false, "static-shell");
	pushSegment(segmentManifest, parts, "mode", mode.body, false, "static-shell");
	pushSegment(segmentManifest, parts, "safety", renderSafetySection(safety, safetyLevel), false, "static-shell");
	pushSegment(segmentManifest, parts, "runtime", renderRuntimeBlock(inputs.dynamicInputs), true, "session-shell");
	const stableAgentCatalog = renderAgentCatalogStableBlock(
		inputs.dynamicInputs.agentCatalogStable ?? inputs.dynamicInputs.agentCatalog,
	);
	pushSegment(segmentManifest, parts, "tools-and-agents", stableAgentCatalog, true, "session-shell");
	const volatileAgentCatalog = renderAgentCatalogDeltaBlock(inputs.dynamicInputs.agentCatalogDelta);
	pushSegment(segmentManifest, parts, "agent-fleet-deltas", volatileAgentCatalog, true, "dynamic-turn");
	const skillsCatalog = renderSkillsCatalogBlock(inputs.dynamicInputs.skillsCatalog);
	pushSegment(segmentManifest, parts, "skills-catalog", skillsCatalog, true, "session-shell");
	const memory = renderMemoryBlock(inputs.dynamicInputs.memorySection);
	pushSegment(segmentManifest, parts, "memory", memory, true, "dynamic-turn");
	const project = renderProjectBlock(inputs.dynamicInputs.contextFiles, inputs.dynamicInputs.projectType);
	pushSegment(segmentManifest, parts, "project-context", project, true, "dynamic-turn");
	const session = renderSessionBlock(inputs.dynamicInputs);
	pushSegment(segmentManifest, parts, "history-summary", session, true, "dynamic-turn");
	for (const fragment of inputs.additionalFragments ?? []) {
		pushSegment(segmentManifest, parts, fragment.id, fragment.body, fragment.dynamic, "session-shell");
	}

	const text = parts.join("\n\n");
	const renderedPromptHash = sha256(text);
	const staticShellParts = segmentManifest
		.map((segment, index) => ({ segment, body: parts[index] ?? "" }))
		.filter((entry) => entry.segment.tier === "static-shell")
		.map((entry) => entry.body);
	const sessionShellParts = segmentManifest
		.map((segment, index) => ({ segment, body: parts[index] ?? "" }))
		.filter((entry) => entry.segment.tier === "static-shell" || entry.segment.tier === "session-shell")
		.map((entry) => entry.body);
	const dynamicFragments = segmentManifest
		.map((segment, index) => ({ segment, body: parts[index] ?? "" }))
		.filter((entry) => entry.segment.tier === "dynamic-turn")
		.map(
			({ segment, body }): DynamicPromptFragment => ({
				id: segment.id,
				body,
				contentHash: segment.contentHash,
				tokenEstimate: segment.tokenEstimate,
			}),
		);
	const staticShellText = staticShellParts.join("\n\n");
	const systemPrompt = sessionShellParts.join("\n\n");
	const dynamicText = dynamicFragments.map((fragment) => fragment.body).join("\n\n");
	const staticShellHash = sha256(staticShellText);
	const sessionShellHash = sha256(systemPrompt);
	const dynamicHash = sha256(dynamicText);
	const staticShellTokenEstimate = estimatePromptTokens(staticShellText);

	const manifestFragments: LoadedFragment[] = [identity, mode, safety];
	const fragmentManifest: FragmentManifestEntry[] = manifestFragments.map((f) => ({
		id: f.id,
		relPath: f.relPath,
		contentHash: f.contentHash,
		dynamic: f.dynamic,
	}));
	for (const fragment of inputs.additionalFragments ?? []) {
		fragmentManifest.push({
			id: fragment.id,
			relPath: fragment.relPath,
			contentHash: fragment.contentHash,
			dynamic: fragment.dynamic,
		});
	}

	return {
		text,
		systemPrompt,
		dynamicPromptFragments: dynamicFragments,
		renderedPromptHash,
		fragmentManifest,
		segmentManifest,
		staticShellHash,
		sessionShellHash,
		dynamicHash,
		staticShellTokenEstimate,
		dynamicInputs: { ...inputs.dynamicInputs },
	};
}
