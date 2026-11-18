import { isBuiltinToolName, type ToolName } from "../../core/tool-names.js";
import { extensionToolName } from "./command-schema.js";
import { validateInterview, validateInterviewStep } from "./interview-schema.js";
import type { ExtensionRuntimeDeclarationV2, ExtensionSlot } from "./manifest-v2.js";
import { PINNED_CONTEXT_MAX_BYTES } from "./pinned-context.js";
import type { ExtensionStatus } from "./public-api.js";
import type {
	ExtensionEffect,
	ExtensionEffectKind,
	ExtensionHookPoint,
	ExtensionHookResult,
	ExtensionOutputV2,
	ExtensionToolResult,
	Interview,
	InterviewNext,
	WorkspaceRegion,
} from "./public-api-v2.js";
import { extensionPlainText } from "./runtime-schema.js";
import { RUNTIME_V2_LIMITS } from "./runtime-schema-v2.js";
import type { View } from "./view.js";
import { SURFACE_LIMITS } from "./view-limits.js";
import { validateIslands, validateView } from "./view-schema.js";

/**
 * Where an output came from decides what it may ask for. Only something the
 * operator did (a command, a press) may take the screen or touch the prompt;
 * a background handler asking for those is refused, so an extension cannot
 * pull focus on its own schedule. Whether a panel may open is the host's call
 * at apply time, because only the host knows if one is already up.
 */
export type OutputOrigin = "command" | "action" | "observation" | "tool";

const REGIONS: ReadonlyArray<WorkspaceRegion> = ["header", "board", "rail", "footer"];
const TONES = ["neutral", "positive", "warning", "error"] as const;

/**
 * The middleware applies each effect at fixed points; one returned elsewhere would be dropped silently.
 * `pin_context` applies where the extension's state moves: the operator's prompt, a tool call that ran, and the
 * start of a turn. A before_tool pin would describe a call that may still be refused, and a turn_end pin reaches
 * the model no sooner than the next turn_start, which can set it.
 */
const EFFECTS_AT: Record<ExtensionHookPoint, ReadonlyArray<ExtensionEffectKind>> = {
	prompt_submit: ["rewrite_prompt", "block_prompt", "notify_operator", "pin_context"],
	before_tool: [
		"block_tool",
		"annotate_tool_result",
		"protect_path",
		"require_tool",
		"lock_tools",
		"rewrite_tool_input",
	],
	after_tool: ["annotate_tool_result", "protect_path", "require_tool", "lock_tools", "pin_context"],
	turn_start: ["inject_reminder", "require_tool", "lock_tools", "notify_operator", "pin_context"],
	turn_end: ["inject_reminder", "request_continuation", "notify_operator"],
};

function record(value: unknown, what: string, allowed: readonly string[]): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${what} must be an object`);
	for (const key of Object.keys(value))
		if (!allowed.includes(key)) throw new Error(`${what} has an unknown field '${key}'`);
	return value as Record<string, unknown>;
}
function text(value: unknown, what: string, max: number, allowEmpty = false): string {
	if (typeof value !== "string" || value.length > max || (!allowEmpty && value.length === 0))
		throw new Error(`${what} must be text of at most ${max} characters`);
	return extensionPlainText(value);
}
function oneLine(value: unknown, what: string, max: number): string {
	return text(value, what, max).replaceAll("\n", " ").replaceAll("\t", " ");
}
function view(value: unknown, what: string): View {
	const checked = validateView(value);
	if (!checked.ok) throw new Error(`${what}${checked.path} ${checked.reason}`);
	return checked.view;
}
function needs(declaration: ExtensionRuntimeDeclarationV2, slot: ExtensionSlot): void {
	if (!declaration.ui.includes(slot)) throw new Error(`runtime did not declare ${slot} UI`);
}
function bounded(value: unknown, what: string, maxBytes: number): void {
	if (Buffer.byteLength(JSON.stringify(value) ?? "") > maxBytes) throw new Error(`${what} exceeds ${maxBytes} bytes`);
}
function tone(value: unknown, what: string): (typeof TONES)[number] {
	if (!TONES.includes(value as (typeof TONES)[number])) throw new Error(`${what} must be one of ${TONES.join(", ")}`);
	return value as (typeof TONES)[number];
}

function interview(value: unknown, declaration: ExtensionRuntimeDeclarationV2): Interview {
	needs(declaration, "interview");
	const checked = validateInterview(value);
	if (!checked.ok) throw new Error(`interview${checked.path} ${checked.reason}`);
	return checked.interview;
}

/** Fields any handler may return. `raw` is already known to be a closed object. */
function ambient(raw: Record<string, unknown>, declaration: ExtensionRuntimeDeclarationV2) {
	const output: Omit<ExtensionOutputV2, "text" | "workspace" | "interview" | "prompt"> = {};
	if (raw.status !== undefined) {
		needs(declaration, "status");
		if (raw.status === null) output.status = null;
		else {
			const status = record(raw.status, "status", ["text", "tone"]);
			const parsed: ExtensionStatus = { text: oneLine(status.text, "status.text", SURFACE_LIMITS.statusChars) };
			if (status.tone !== undefined) parsed.tone = tone(status.tone, "status.tone");
			output.status = parsed;
		}
	}
	if (raw.band !== undefined) {
		needs(declaration, "band");
		output.band = raw.band === null ? null : view(raw.band, "band");
	}
	if (raw.card !== undefined) {
		needs(declaration, "card");
		output.card = view(raw.card, "card");
	}
	if (raw.toast !== undefined) {
		needs(declaration, "toast");
		const toast = record(raw.toast, "toast", ["text", "tone"]);
		output.toast = {
			text: oneLine(toast.text, "toast.text", SURFACE_LIMITS.toastChars),
			...(toast.tone !== undefined ? { tone: tone(toast.tone, "toast.tone") } : {}),
		};
	}
	if (raw.panel !== undefined) {
		needs(declaration, "panel");
		const panel = record(raw.panel, "panel", ["title", "meta", "view"]);
		output.panel = {
			title: oneLine(panel.title, "panel.title", 120),
			...(panel.meta !== undefined ? { meta: oneLine(panel.meta, "panel.meta", 120) } : {}),
			view: view(panel.view, "panel.view"),
		};
	}
	if (raw.dock !== undefined) {
		needs(declaration, "dock");
		output.dock = raw.dock === null ? null : view(raw.dock, "dock");
	}
	if (raw.regions !== undefined) {
		const declared = new Set(declaration.workspaces.flatMap((workspace) => workspace.regions));
		const regions = record(raw.regions, "regions", REGIONS);
		const parsed: Partial<Record<WorkspaceRegion, View | null>> = {};
		for (const region of REGIONS) {
			if (regions[region] === undefined) continue;
			if (!declared.has(region)) throw new Error(`no workspace declares the ${region} region`);
			parsed[region] = regions[region] === null ? null : view(regions[region], `regions.${region}`);
		}
		output.regions = parsed;
	}
	if (raw.islands !== undefined) {
		if (!declaration.workspaces.some((workspace) => workspace.regions.includes("islands")))
			throw new Error("no workspace declares islands");
		if (raw.islands === null) output.islands = null;
		else {
			const checked = validateIslands(raw.islands);
			if (!checked.ok) throw new Error(`islands${checked.path} ${checked.reason}`);
			output.islands = checked.islands;
		}
	}
	return output;
}

const AMBIENT_KEYS = ["status", "band", "card", "toast", "panel", "dock", "regions", "islands"] as const;

export function parseExtensionOutputV2(
	value: unknown,
	declaration: ExtensionRuntimeDeclarationV2,
	origin: OutputOrigin,
): ExtensionOutputV2 {
	bounded(value, "runtime output", RUNTIME_V2_LIMITS.outputBytes);
	const raw = record(value, "runtime output", ["text", ...AMBIENT_KEYS, "workspace", "interview", "prompt"]);
	const operator = origin === "command" || origin === "action";
	const output: ExtensionOutputV2 = {
		text: text(raw.text, "text", 32768, true),
		...ambient(raw, declaration),
	};
	if (raw.workspace !== undefined) {
		if (!operator) throw new Error("only a command or an action may enter or leave a workspace");
		const workspace = record(raw.workspace, "workspace", ["enter", "leave"]);
		if (workspace.leave === true && workspace.enter === undefined) output.workspace = { leave: true };
		else {
			const id = text(workspace.enter, "workspace.enter", 40);
			if (workspace.leave !== undefined || !declaration.workspaces.some((entry) => entry.id === id))
				throw new Error(`workspace '${id}' is not declared`);
			output.workspace = { enter: id };
		}
	}
	if (raw.prompt !== undefined) {
		if (!operator) throw new Error("only a command or an action may touch the prompt");
		const prompt = record(raw.prompt, "prompt", ["fill", "submit"]);
		if ((prompt.fill === undefined) === (prompt.submit === undefined))
			throw new Error("prompt takes exactly one of fill or submit");
		output.prompt =
			prompt.fill !== undefined
				? { fill: text(prompt.fill, "prompt.fill", RUNTIME_V2_LIMITS.promptChars) }
				: { submit: text(prompt.submit, "prompt.submit", RUNTIME_V2_LIMITS.promptChars) };
	}
	if (raw.interview !== undefined) {
		if (!operator) throw new Error("only a command, an action or a tool may start an interview");
		output.interview = interview(raw.interview, declaration);
	}
	return output;
}

/**
 * A package requires its own tool only when the manifest promotes it (B2).
 * Promotion is what puts the schema in the request, and only a tool in the
 * request can be the provider's tool choice; an unpromoted one could be asked
 * for in a reminder at best, which is not what a requirement says. Like a
 * rewrite without its content access, the effect is refused, so the author
 * sees it in `extensions test` and the operator in the hook's failure notice.
 * A name outside the package (a builtin, an MCP tool) is the host's to judge.
 */
function requirableTool(
	toolName: string,
	what: string,
	declaration: ExtensionRuntimeDeclarationV2,
	extensionId: string,
): void {
	for (const tool of declaration.tools) {
		const qualified = extensionToolName(extensionId, tool.name);
		// A bare name that is also a builtin keeps meaning the builtin.
		if (toolName === tool.name && !isBuiltinToolName(toolName as ToolName))
			throw new Error(`${what} '${toolName}' is this package's tool ${qualified}; name it in full`);
		if (toolName === qualified && declaration.promote?.includes(tool.name) !== true)
			throw new Error(
				`${what} ${qualified} is not promoted, so no request can require it; list ${tool.name} under runtime.promote`,
			);
	}
}

function effect(
	value: unknown,
	at: number,
	point: ExtensionHookPoint,
	declaration: ExtensionRuntimeDeclarationV2,
	extensionId: string,
): ExtensionEffect {
	const what = `effects[${at}]`;
	const kind = (value as { kind?: unknown } | null)?.kind;
	if (typeof kind !== "string" || !EFFECTS_AT[point].includes(kind as ExtensionEffectKind))
		throw new Error(`${what} '${String(kind)}' does not apply at ${point}`);
	const max = RUNTIME_V2_LIMITS.effectTextChars;
	switch (kind as ExtensionEffectKind) {
		case "block_tool": {
			const raw = record(value, what, ["kind", "reason"]);
			return { kind: "block_tool", reason: text(raw.reason, `${what}.reason`, max) };
		}
		case "block_prompt": {
			const raw = record(value, what, ["kind", "reason"]);
			return { kind: "block_prompt", reason: text(raw.reason, `${what}.reason`, max) };
		}
		case "annotate_tool_result": {
			const raw = record(value, what, ["kind", "message", "severity"]);
			if (raw.severity !== undefined && raw.severity !== "info" && raw.severity !== "warn")
				throw new Error(`${what}.severity must be info or warn`);
			return {
				kind: "annotate_tool_result",
				message: text(raw.message, `${what}.message`, max),
				...(raw.severity !== undefined ? { severity: raw.severity } : {}),
			};
		}
		case "inject_reminder": {
			const raw = record(value, what, ["kind", "message", "severity", "audience"]);
			const severity = raw.severity;
			// `hard-block` interrupts a turn; an extension gate uses block_tool or block_prompt, which carry a receipt.
			if (severity !== undefined && severity !== "info" && severity !== "advisory" && severity !== "warn")
				throw new Error(`${what}.severity must be info, advisory or warn`);
			if (raw.audience !== undefined && raw.audience !== "model") throw new Error(`${what}.audience must be model`);
			return {
				kind: "inject_reminder",
				message: text(raw.message, `${what}.message`, max),
				...(severity !== undefined ? { severity } : {}),
				...(raw.audience !== undefined ? { audience: "model" } : {}),
			};
		}
		case "require_tool": {
			const raw = record(value, what, ["kind", "toolName"]);
			const toolName = text(raw.toolName, `${what}.toolName`, 64);
			requirableTool(toolName, `${what}.toolName`, declaration, extensionId);
			return { kind: "require_tool", toolName };
		}
		case "lock_tools":
			record(value, what, ["kind"]);
			return { kind: "lock_tools" };
		case "notify_operator": {
			const raw = record(value, what, ["kind", "message", "key"]);
			return {
				kind: "notify_operator",
				message: text(raw.message, `${what}.message`, max),
				key: text(raw.key, `${what}.key`, 80),
			};
		}
		case "protect_path": {
			const raw = record(value, what, ["kind", "path", "reason"]);
			return {
				kind: "protect_path",
				path: text(raw.path, `${what}.path`, 1000),
				reason: text(raw.reason, `${what}.reason`, max),
			};
		}
		case "request_continuation": {
			const raw = record(value, what, ["kind", "message", "note"]);
			return {
				kind: "request_continuation",
				message: text(raw.message, `${what}.message`, max),
				...(raw.note !== undefined ? { note: text(raw.note, `${what}.note`, 200) } : {}),
			};
		}
		case "rewrite_tool_input": {
			if (!declaration.access.includes("tool-args")) throw new Error(`${what} needs access: tool-args`);
			const raw = record(value, what, ["kind", "args", "reason"]);
			const args = raw.args;
			if (args === null || typeof args !== "object" || Array.isArray(args))
				throw new Error(`${what}.args must be an object`);
			bounded(args, `${what}.args`, 64 * 1024);
			return {
				kind: "rewrite_tool_input",
				args: args as Record<string, unknown>,
				reason: text(raw.reason, `${what}.reason`, max),
			};
		}
		case "rewrite_prompt": {
			if (!declaration.access.includes("prompt")) throw new Error(`${what} needs access: prompt`);
			const raw = record(value, what, ["kind", "text", "reason"]);
			return {
				kind: "rewrite_prompt",
				text: text(raw.text, `${what}.text`, RUNTIME_V2_LIMITS.promptChars),
				reason: text(raw.reason, `${what}.reason`, max),
			};
		}
		case "pin_context": {
			const raw = record(value, what, ["kind", "text"]);
			if (typeof raw.text !== "string") throw new Error(`${what}.text must be text`);
			if (Buffer.byteLength(raw.text) > PINNED_CONTEXT_MAX_BYTES)
				throw new Error(`${what}.text exceeds the ${PINNED_CONTEXT_MAX_BYTES}-byte pinned context limit`);
			return { kind: "pin_context", text: extensionPlainText(raw.text) };
		}
	}
}

export function parseExtensionHookResult(
	value: unknown,
	declaration: ExtensionRuntimeDeclarationV2,
	point: ExtensionHookPoint,
	extensionId: string,
): ExtensionHookResult {
	if (value === null || value === undefined) return {};
	bounded(value, "hook result", RUNTIME_V2_LIMITS.outputBytes);
	const raw = record(value, "hook result", ["effects", "ui"]);
	const result: ExtensionHookResult = {};
	if (raw.effects !== undefined) {
		if (!Array.isArray(raw.effects) || raw.effects.length > RUNTIME_V2_LIMITS.effects)
			throw new Error(`effects allows at most ${RUNTIME_V2_LIMITS.effects} entries`);
		result.effects = raw.effects.map((entry, at) => effect(entry, at, point, declaration, extensionId));
		// One block per extension: two values in one answer would leave which one stands to effect order.
		if (result.effects.filter((entry) => entry.kind === "pin_context").length > 1)
			throw new Error("effects may set pin_context at most once");
	}
	if (raw.ui !== undefined) result.ui = ambient(record(raw.ui, "ui", AMBIENT_KEYS), declaration);
	return result;
}

export function parseExtensionToolResult(
	value: unknown,
	declaration: ExtensionRuntimeDeclarationV2,
): ExtensionToolResult {
	bounded(value, "tool result", RUNTIME_V2_LIMITS.outputBytes);
	const raw = record(value, "tool result", ["text", "summary", "data", "isError", "pipelineDone", "card", "interview"]);
	if (typeof raw.text !== "string" || Buffer.byteLength(raw.text) > RUNTIME_V2_LIMITS.toolTextBytes)
		throw new Error(`tool result text must be at most ${RUNTIME_V2_LIMITS.toolTextBytes} bytes`);
	const result: ExtensionToolResult = { text: extensionPlainText(raw.text) };
	if (raw.summary !== undefined) {
		if (
			typeof raw.summary !== "string" ||
			raw.summary.trim().length === 0 ||
			Buffer.byteLength(raw.summary) > RUNTIME_V2_LIMITS.toolSummaryBytes
		)
			throw new Error(`tool result summary must be non-empty text of at most ${RUNTIME_V2_LIMITS.toolSummaryBytes} bytes`);
		result.summary = extensionPlainText(raw.summary);
	}
	if (raw.data !== undefined) result.data = raw.data;
	if (raw.isError !== undefined) {
		if (typeof raw.isError !== "boolean") throw new Error("tool result isError must be true or false");
		result.isError = raw.isError;
	}
	if (raw.pipelineDone !== undefined) {
		if (typeof raw.pipelineDone !== "boolean") throw new Error("tool result pipelineDone must be true or false");
		result.pipelineDone = raw.pipelineDone;
	}
	if (raw.card !== undefined) {
		needs(declaration, "card");
		result.card = view(raw.card, "card");
	}
	if (raw.interview !== undefined) result.interview = interview(raw.interview, declaration);
	return result;
}

/** An interview handler either asks the next step or finishes with what a command could return. */
export function parseInterviewNext(value: unknown, declaration: ExtensionRuntimeDeclarationV2): InterviewNext {
	bounded(value, "interview answer", RUNTIME_V2_LIMITS.outputBytes);
	if ((value as { done?: unknown } | null)?.done === true) {
		const { done: _done, pipelineDone, ...rest } = value as Record<string, unknown>;
		if (pipelineDone !== undefined && typeof pipelineDone !== "boolean")
			throw new Error("interview pipelineDone must be true or false");
		return {
			done: true,
			...parseExtensionOutputV2(rest, declaration, "action"),
			...(pipelineDone === undefined ? {} : { pipelineDone }),
		};
	}
	const raw = record(value, "interview answer", ["step", "total"]);
	const checked = validateInterviewStep(raw.step);
	if (!checked.ok) throw new Error(`interview step${checked.path} ${checked.reason}`);
	if (raw.total !== undefined && (!Number.isInteger(raw.total) || Number(raw.total) < 1 || Number(raw.total) > 99))
		throw new Error("interview total must be 1-99");
	return { step: checked.step, ...(raw.total !== undefined ? { total: Number(raw.total) } : {}) };
}
