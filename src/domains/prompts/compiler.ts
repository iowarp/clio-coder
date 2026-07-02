import { ceilChars } from "../session/context-accounting.js";
import type { FragmentTable, LoadedFragment } from "./fragment-loader.js";
import { sha256 } from "./hash.js";

/**
 * Session-prompt compiler. The system prompt is compiled once per session
 * from inputs that are constant for the session's lifetime (identity,
 * operating contract, safety level, provider/model, project context, tool
 * surface). Volatile runtime state (thinking level, send heuristics,
 * per-turn requests) never renders into the prompt: the prompt prefix must
 * stay byte-stable so local prefix caches survive across turns and sessions.
 */

/** One per-tool guidance sentence sourced from the tool registry's metadata. */
export interface ToolPromptHint {
	tool: string;
	hint: string;
}

export interface SessionPromptInputs {
	provider?: string | null;
	model?: string | null;
	contextWindow?: number | null;
	providerSupportsTools?: boolean | null;
	/** Model-stable thinking guidance from local-model quirks (changes only on model change). */
	thinkingGuidance?: string | null;
	/**
	 * Per-tool prompt hints derived once from the frozen surface at compile
	 * time (registry metadata `promptHint`). Rendered into the Tool Contract
	 * sorted by tool name so the compiled text is byte-stable per surface.
	 */
	toolPromptHints?: ReadonlyArray<ToolPromptHint>;
	contextFiles?: string;
	memorySection?: string;
}

export interface CompileInputs {
	identity: string;
	operatingContract: string;
	safety: string;
	sessionInputs: SessionPromptInputs;
	additionalFragments?: ReadonlyArray<RenderedPromptFragment>;
}

export interface FragmentManifestEntry {
	id: string;
	relPath: string;
	contentHash: string;
	dynamic: boolean;
}

export interface RenderedPromptFragment {
	id: string;
	relPath: string;
	body: string;
	contentHash: string;
	dynamic: boolean;
}

export interface PromptSection {
	id: string;
	tokenEstimate: number;
}

export interface CompiledSessionPrompt {
	systemPrompt: string;
	systemPromptHash: string;
	tokenEstimate: number;
	sections: ReadonlyArray<PromptSection>;
	fragmentManifest: ReadonlyArray<FragmentManifestEntry>;
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
		case "read-only":
			return "inspect and answer; mutating calls are auto-denied, so propose changes instead.";
		case "suggest":
			return "every non-read action parks for one-shot operator approval before it runs.";
		case "auto-edit":
			return "workspace edits and recognized commands run; other bash asks for approval.";
		case "full-auto":
			return "act without asking; system_modify still asks and git_destructive is blocked by the safety net.";
		default:
			return "follow the active safety contract.";
	}
}

function renderSafetySection(safetyFragment: LoadedFragment, level: string): string {
	const oneLine = `Autonomy: ${level}. ${safetyOneLiner(level)}`;
	const body = safetyFragment.body.trim();
	return body.length > 0 ? `${oneLine}\n\n${body}` : oneLine;
}

function renderRuntimeBlock(inputs: SessionPromptInputs): string {
	const lines: string[] = ["# Runtime"];
	const provider = inputs.provider ?? "";
	const model = inputs.model ?? "";
	if (provider.length > 0) lines.push(`Provider: ${provider}`);
	if (model.length > 0) lines.push(`Model: ${model}`);
	if (typeof inputs.contextWindow === "number" && inputs.contextWindow > 0) {
		lines.push(`Context window: ${inputs.contextWindow}`);
	}
	const guidance = inputs.thinkingGuidance?.trim();
	if (guidance && guidance.length > 0) {
		lines.push("");
		lines.push(guidance);
	}
	return lines.join("\n");
}

function renderToolContractBlock(inputs: SessionPromptInputs): string {
	if (inputs.providerSupportsTools === false) {
		return [
			"# Tool Contract",
			"Provider tool calls: unavailable.",
			"This target cannot call tools; answer from the visible user request and compact context only.",
		].join("\n");
	}
	const lines = [
		"# Tool Contract",
		"The attached schemas are the session's complete tool surface; follow each schema exactly.",
		"Call tools only for concrete inspection or changes the task requires. If the user asks for a tool-free answer, simply answer without calling tools.",
		'Prefer context(scope="workspace"), grep, and read for repository orientation instead of assuming source-tree details were preloaded.',
	];
	// One hint per tool, sorted by tool name: deterministic bytes regardless
	// of surface or registration order, and removing a tool from the surface
	// removes its hint with no compiler edit.
	const seen = new Set<string>();
	const hints = [...(inputs.toolPromptHints ?? [])]
		.map((entry) => ({ tool: entry.tool.trim(), hint: entry.hint.trim() }))
		.filter((entry) => entry.tool.length > 0 && entry.hint.length > 0)
		.sort((a, b) => (a.tool < b.tool ? -1 : a.tool > b.tool ? 1 : 0));
	for (const entry of hints) {
		if (seen.has(entry.tool)) continue;
		seen.add(entry.tool);
		lines.push(entry.hint);
	}
	return lines.join("\n");
}

function renderRetrievalHintsBlock(inputs: SessionPromptInputs): string {
	if (inputs.providerSupportsTools === false) {
		return [
			"# Retrieval Hints",
			"Repository details are intentionally compact because this target has no tool channel.",
			"Use only facts present in the current turn and say what file-specific context would be needed for precise code work.",
		].join("\n");
	}
	return [
		"# Retrieval Hints",
		"Compact CLIO.md project instructions may be preloaded above; everything else about the repository must be fetched, not assumed.",
		"For questions about where code, skills, tools, prompts, or harness behavior live, inspect with code_nav, context, grep, or read before answering. Never invent file paths, automatic tool behavior, or mutable repo details from the system prompt.",
	].join("\n");
}

function renderProjectBlock(contextFiles: string | undefined): string {
	const trimmedFiles = contextFiles?.trim() ?? "";
	return trimmedFiles.length === 0 ? "" : `# Project\n\n${trimmedFiles}`;
}

function renderMemoryBlock(memorySection: string | undefined): string {
	const trimmed = memorySection?.trim() ?? "";
	return trimmed.length === 0 ? "" : `# Memory\n\n${trimmed}`;
}

function estimatePromptTokens(text: string): number {
	return ceilChars(text.trim().length);
}

/**
 * Compile the session system prompt. Identity and the operating contract
 * render verbatim from disk fragments; safety renders a one-line directive
 * plus the safety fragment body; everything else renders inline from typed
 * SessionPromptInputs. Output is one string, one sha256, one token estimate,
 * and a flat section breakdown for the /context overlay.
 */
export function compile(table: FragmentTable, inputs: CompileInputs): CompiledSessionPrompt {
	const identity = lookupFragment(table, inputs.identity, "identity");
	const operatingContract = lookupFragment(table, inputs.operatingContract, "operating contract");
	const safety = lookupFragment(table, inputs.safety, "safety");
	const autonomyLevel = safety.id.startsWith("safety.") ? safety.id.slice("safety.".length) : safety.id;
	const session = inputs.sessionInputs;

	const parts: string[] = [];
	const sections: PromptSection[] = [];
	const push = (id: string, body: string): void => {
		const trimmed = body.trim();
		if (trimmed.length === 0) return;
		parts.push(trimmed);
		sections.push({ id, tokenEstimate: estimatePromptTokens(trimmed) });
	};

	push("identity", identity.body);
	push("operating-contract", operatingContract.body);
	push("safety", renderSafetySection(safety, autonomyLevel));
	push("runtime", renderRuntimeBlock(session));
	push("tool-contract", renderToolContractBlock(session));
	push("retrieval-hints", renderRetrievalHintsBlock(session));
	push("memory", renderMemoryBlock(session.memorySection));
	push("project-context", renderProjectBlock(session.contextFiles));
	for (const fragment of inputs.additionalFragments ?? []) {
		push(fragment.id, fragment.body);
	}

	const systemPrompt = parts.join("\n\n");
	const fragmentManifest: FragmentManifestEntry[] = [identity, operatingContract, safety].map((f) => ({
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
		systemPrompt,
		systemPromptHash: sha256(systemPrompt),
		tokenEstimate: estimatePromptTokens(systemPrompt),
		sections,
		fragmentManifest,
	};
}
