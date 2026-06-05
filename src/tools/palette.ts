import { type ToolName, ToolNames } from "../core/tool-names.js";
import { MODE_MATRIX, type ModeName } from "../domains/modes/matrix.js";
import { applyToolProfile, type ToolProfileName } from "./profiles.js";

export type ToolPaletteGroup =
	| "orientation"
	| "locate"
	| "inspect"
	| "mutate"
	| "validate"
	| "delegate"
	| "external"
	| "skills"
	| "advise"
	| "escape_hatch";

export type ToolPaletteIntent =
	| "small_talk"
	| "repo_inspection"
	| "coding"
	| "validation"
	| "delegation"
	| "external_research"
	| "skill_work"
	| "advise";

export type ToolPalettePhase = "initial" | "inspection" | "editing" | "post_edit" | "validation" | "advise";

export interface ResolveToolPaletteInput {
	mode: ModeName;
	providerSupportsTools: boolean;
	userText: string;
	availableTools?: ReadonlyArray<ToolName>;
	toolProfile?: ToolProfileName;
	workerAllowedTools?: ReadonlyArray<ToolName>;
	recentToolNames?: ReadonlyArray<ToolName>;
}

export interface ToolPaletteResult {
	activeTools: ReadonlyArray<ToolName>;
	intent: ToolPaletteIntent;
	phase: ToolPalettePhase;
	groups: ReadonlyArray<ToolPaletteGroup>;
	providerSupportsTools: boolean;
	mode: ModeName;
	omittedToolCount: number;
}

export const TOOL_GROUPS: Readonly<Record<ToolPaletteGroup, ReadonlyArray<ToolName>>> = {
	orientation: [ToolNames.WorkspaceContext, ToolNames.GitStatus, ToolNames.EntryPoints],
	locate: [ToolNames.WhereIs, ToolNames.FindSymbol, ToolNames.Find, ToolNames.Glob],
	inspect: [ToolNames.Read, ToolNames.Grep, ToolNames.Ls, ToolNames.GitDiff, ToolNames.GitLog],
	mutate: [ToolNames.Edit, ToolNames.Write],
	validate: [
		ToolNames.RunTests,
		ToolNames.RunLint,
		ToolNames.RunBuild,
		ToolNames.PackageScript,
		ToolNames.ValidateFrontend,
	],
	delegate: [ToolNames.Dispatch, ToolNames.DispatchBatch],
	external: [ToolNames.WebFetch],
	skills: [ToolNames.ReadSkill, ToolNames.CreateSkill],
	advise: [ToolNames.WritePlan, ToolNames.WriteReview],
	escape_hatch: [ToolNames.Bash],
};

const GROUP_ORDER: ReadonlyArray<ToolPaletteGroup> = [
	"orientation",
	"locate",
	"inspect",
	"mutate",
	"validate",
	"delegate",
	"external",
	"skills",
	"advise",
	"escape_hatch",
];

const GREETING_RE = /^(?:hi|hello|hey|yo|sup|thanks|thank you|ok|okay|cool|nice|ping)[.!?\s]*$/i;
const EDIT_RE =
	/\b(?:implement|fix|edit|modify|change|update|add|remove|delete|refactor|rewrite|create|scaffold|patch|repair|wire|migrate)\b/i;
const INSPECT_RE =
	/\b(?:inspect|audit|review|explain|summari[sz]e|understand|find|where|locate|read|show|list|search|grep|status|diff|log|trace|map)\b/i;
const VALIDATE_RE = /\b(?:test|tests|lint|typecheck|build|verify|validation|validate|ci|precommit)\b/i;
const DISPATCH_RE =
	/\b(?:subagents?|sub-agents?|delegate|worker|workers|dispatch|multi-agent|parallel agents?|fleet)\b/i;
const EXTERNAL_RE = /\b(?:web|http|https|url|fetch|browse|internet|online|external research|latest|current|today)\b/i;
const SKILL_RE = /\b(?:skill|skills|SKILL\.md)\b/i;
const CREATE_SKILL_RE = /\b(?:create|write|add|new|scaffold|install|update)\s+(?:a\s+)?skills?\b|\bcreate_skill\b/i;
const SHELL_RE = /\b(?:bash|shell|terminal|command line|cli command|run command|execute command)\b/i;
const AVOID_SHELL_RE =
	/\b(?:(?:do\s+not|don't)\s+(?:use\s+)?|(?:without|no)\s+(?:using\s+)?)\b(?:bash|shell|terminal|command line|cli command|run command|execute command)\b/i;
const TOOL_META_RE =
	/\b(?:what|which)\s+(?:tools?|tool\s+calls?)\b|\b(?:list|show|describe)\s+(?:all\s+)?(?:the\s+)?(?:tools?l?(?!-)|tool\s+calls?)\b|\btools?\s+(?:do|can)\s+you\s+(?:have|use|access)\b|\btool\s+(?:access|surface|palette)\b/i;
const NO_TOOL_RE =
	/\b(?:do\s+not|don't)\s+use\s+(?:tools?|tool\s+calls?)\b|\b(?:without|no)\s+(?:tools|tool\s+calls?)\b|\bno\s+tool\s+(?:use|calls?)\b/i;
const WORK_CONTEXT_RE =
	/\b(?:repo(?:sitory)?|workspace|project|code|source|files?|director(?:y|ies)|src\/|tests?\/|package\.json|[\w.-]+\.(?:ts|tsx|js|jsx|json|md|css|html|py|rs|go|c|cpp|h|hpp|toml|ya?ml))\b/i;

function unique(tools: Iterable<ToolName>): ToolName[] {
	const seen = new Set<ToolName>();
	const out: ToolName[] = [];
	for (const tool of tools) {
		if (seen.has(tool)) continue;
		seen.add(tool);
		out.push(tool);
	}
	return out;
}

function classifyIntent(text: string, mode: ModeName): ToolPaletteIntent {
	const trimmed = text.trim();
	const asksNoTools = NO_TOOL_RE.test(trimmed);
	const asksToolMeta = TOOL_META_RE.test(trimmed);
	const asksDispatch = DISPATCH_RE.test(trimmed);
	const asksSkill = SKILL_RE.test(trimmed);
	const asksExternal = EXTERNAL_RE.test(trimmed);
	const asksEdit = EDIT_RE.test(trimmed);
	const asksValidation = VALIDATE_RE.test(trimmed);
	const asksInspection = INSPECT_RE.test(trimmed);
	const hasWorkIntent =
		asksDispatch ||
		asksSkill ||
		asksExternal ||
		asksEdit ||
		asksValidation ||
		(asksInspection && (!asksToolMeta || WORK_CONTEXT_RE.test(trimmed)));
	if (mode === "advise") return "advise";
	if (trimmed.length === 0 || GREETING_RE.test(trimmed)) return "small_talk";
	if (asksNoTools) return "small_talk";
	if (asksToolMeta && !hasWorkIntent) return "small_talk";
	if (asksDispatch) return "delegation";
	if (asksSkill) return "skill_work";
	if (asksExternal) return "external_research";
	if (asksEdit) return "coding";
	if (asksValidation) return "validation";
	if (asksInspection) return "repo_inspection";
	return "repo_inspection";
}

function hasRecentEdit(tools: ReadonlyArray<ToolName> | undefined): boolean {
	return tools?.some((tool) => tool === ToolNames.Edit || tool === ToolNames.Write) ?? false;
}

function resolvePhase(
	intent: ToolPaletteIntent,
	text: string,
	recentTools: ReadonlyArray<ToolName> | undefined,
): ToolPalettePhase {
	if (intent === "advise") return "advise";
	if (VALIDATE_RE.test(text)) return "validation";
	if (hasRecentEdit(recentTools)) return "post_edit";
	if (intent === "coding" || intent === "skill_work") return "editing";
	if (intent === "small_talk") return "initial";
	return "inspection";
}

function requestedGroups(intent: ToolPaletteIntent, phase: ToolPalettePhase, text: string): ToolPaletteGroup[] {
	if (intent === "small_talk") return [];
	const groups: ToolPaletteGroup[] = ["orientation", "locate", "inspect"];
	if (intent === "advise") groups.push("advise");
	if (intent === "coding" || intent === "skill_work") groups.push("mutate");
	if (intent === "validation" || phase === "post_edit" || phase === "validation") groups.push("validate");
	if (intent === "delegation" || DISPATCH_RE.test(text)) groups.push("delegate");
	if (intent === "external_research" || EXTERNAL_RE.test(text)) groups.push("external");
	if (intent === "skill_work" || SKILL_RE.test(text)) groups.push("skills");
	if (SHELL_RE.test(text) && !AVOID_SHELL_RE.test(text)) groups.push("escape_hatch");
	return uniqueGroups(groups);
}

function uniqueGroups(groups: Iterable<ToolPaletteGroup>): ToolPaletteGroup[] {
	const seen = new Set<ToolPaletteGroup>();
	const out: ToolPaletteGroup[] = [];
	for (const group of groups) {
		if (seen.has(group)) continue;
		seen.add(group);
		out.push(group);
	}
	return out.sort((a, b) => GROUP_ORDER.indexOf(a) - GROUP_ORDER.indexOf(b));
}

function expandGroups(groups: ReadonlyArray<ToolPaletteGroup>, text: string): ToolName[] {
	const tools: ToolName[] = [];
	for (const group of groups) {
		for (const tool of TOOL_GROUPS[group]) {
			if (tool === ToolNames.CreateSkill && !CREATE_SKILL_RE.test(text)) continue;
			tools.push(tool);
		}
	}
	return unique(tools);
}

export function resolveToolPalette(input: ResolveToolPaletteInput): ToolPaletteResult {
	const modeTools = input.availableTools ?? Array.from(MODE_MATRIX[input.mode].tools);
	const profileTools = applyToolProfile(modeTools, input.toolProfile);
	const constrained = input.workerAllowedTools
		? profileTools.filter((tool) => input.workerAllowedTools?.includes(tool))
		: profileTools;
	const candidates = unique(constrained.filter((tool) => MODE_MATRIX[input.mode].tools.has(tool)));
	const intent = classifyIntent(input.userText, input.mode);
	const phase = resolvePhase(intent, input.userText, input.recentToolNames);
	if (!input.providerSupportsTools) {
		return {
			activeTools: [],
			intent,
			phase,
			groups: [],
			providerSupportsTools: false,
			mode: input.mode,
			omittedToolCount: candidates.length,
		};
	}
	const groups = requestedGroups(intent, phase, input.userText);
	const requested = new Set(expandGroups(groups, input.userText));
	const activeTools = candidates.filter((tool) => requested.has(tool));
	return {
		activeTools,
		intent,
		phase,
		groups,
		providerSupportsTools: true,
		mode: input.mode,
		omittedToolCount: Math.max(0, candidates.length - activeTools.length),
	};
}
