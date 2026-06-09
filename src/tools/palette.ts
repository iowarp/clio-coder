import { type ToolName, ToolNames } from "../core/tool-names.js";
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
	| "artifact"
	| "escape_hatch";

export type ToolPaletteIntent =
	| "small_talk"
	| "repo_inspection"
	| "coding"
	| "validation"
	| "delegation"
	| "external_research"
	| "skill_work";

export type ToolPalettePhase = "initial" | "inspection" | "editing" | "post_edit" | "validation";

export interface ResolveToolPaletteInput {
	providerSupportsTools: boolean;
	userText: string;
	availableTools?: ReadonlyArray<ToolName>;
	toolProfile?: ToolProfileName;
	workerAllowedTools?: ReadonlyArray<ToolName>;
	recentToolNames?: ReadonlyArray<ToolName>;
}

export interface ToolPaletteResult {
	activeTools: ReadonlyArray<ToolName>;
	/**
	 * Every tool this target could call this session after profile and worker
	 * constraints, regardless of whether the current turn activated its schema.
	 * Drives the always-present Tool Catalog so the model stays aware of its
	 * full surface even when no schema is attached this turn.
	 */
	availableTools: ReadonlyArray<ToolName>;
	intent: ToolPaletteIntent;
	phase: ToolPalettePhase;
	groups: ReadonlyArray<ToolPaletteGroup>;
	providerSupportsTools: boolean;
	posture: "operating";
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
	artifact: [ToolNames.WritePlan, ToolNames.WriteReview],
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
	"artifact",
	"escape_hatch",
];

/** One-line purpose per group, rendered in the always-present Tool Catalog. */
const GROUP_PURPOSE: Readonly<Record<ToolPaletteGroup, string>> = {
	orientation: "workspace snapshot, git status, entry points",
	locate: "find files and symbols",
	inspect: "read, grep, list, git diff/log",
	mutate: "edit and write files",
	validate: "run tests, lint, build, package scripts",
	delegate: "dispatch bounded fleet sub-agents",
	external: "fetch web content",
	skills: "load or author reusable SKILL.md playbooks",
	artifact: "write PLAN.md / REVIEW.md artifacts",
	escape_hatch: "raw shell via bash",
};

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
const CREATE_SKILL_RE = /\b(?:create|write|add|new|scaffold)\s+(?:a\s+)?skills?\b|\bcreate_skill\b/i;
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

function classifyIntent(text: string): ToolPaletteIntent {
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
	if (VALIDATE_RE.test(text)) return "validation";
	if (hasRecentEdit(recentTools)) return "post_edit";
	if (intent === "coding" || intent === "skill_work") return "editing";
	if (intent === "small_talk") return "initial";
	return "inspection";
}

function requestedGroups(intent: ToolPaletteIntent, phase: ToolPalettePhase, text: string): ToolPaletteGroup[] {
	if (intent === "small_talk") return [];
	const groups: ToolPaletteGroup[] = ["orientation", "locate", "inspect"];
	if (intent === "coding" || intent === "skill_work") groups.push("mutate");
	if (intent === "validation" || phase === "post_edit" || phase === "validation") groups.push("validate");
	if (intent === "delegation" || DISPATCH_RE.test(text)) groups.push("delegate");
	if (intent === "external_research" || EXTERNAL_RE.test(text)) groups.push("external");
	if (intent === "skill_work" || SKILL_RE.test(text)) groups.push("skills");
	if (/\b(?:plan|review|PLAN\.md|REVIEW\.md)\b/i.test(text)) groups.push("artifact");
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

/**
 * Render a compact, names-only catalog of the tools available this session,
 * grouped by purpose. This is cheap (one line per non-empty group) and stable
 * across turns, so it lives in the prefix-cacheable session shell and keeps the
 * model aware of its full surface even on turns where no tool schema is
 * attached. Schemas remain progressively disclosed via the active palette.
 */
export function renderToolCatalog(availableTools: ReadonlyArray<ToolName>): string {
	const available = new Set(availableTools);
	const lines: string[] = [];
	for (const group of GROUP_ORDER) {
		const tools = TOOL_GROUPS[group].filter((tool) => available.has(tool));
		if (tools.length === 0) continue;
		lines.push(`- ${group} (${GROUP_PURPOSE[group]}): ${tools.join(", ")}`);
	}
	return lines.join("\n");
}

export function resolveToolPalette(input: ResolveToolPaletteInput): ToolPaletteResult {
	const modeTools = input.availableTools ?? [];
	const profileTools = applyToolProfile(modeTools, input.toolProfile);
	const constrained = input.workerAllowedTools
		? profileTools.filter((tool) => input.workerAllowedTools?.includes(tool))
		: profileTools;
	const candidates = unique(constrained);
	const intent = classifyIntent(input.userText);
	const phase = resolvePhase(intent, input.userText, input.recentToolNames);
	if (!input.providerSupportsTools) {
		return {
			activeTools: [],
			availableTools: [],
			intent,
			phase,
			groups: [],
			providerSupportsTools: false,
			posture: "operating",
			omittedToolCount: candidates.length,
		};
	}
	const groups = requestedGroups(intent, phase, input.userText);
	const requested = new Set(expandGroups(groups, input.userText));
	const activeTools = candidates.filter((tool) => requested.has(tool));
	return {
		activeTools,
		availableTools: candidates,
		intent,
		phase,
		groups,
		providerSupportsTools: true,
		posture: "operating",
		omittedToolCount: Math.max(0, candidates.length - activeTools.length),
	};
}
