import { homedir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import type { DelegationToolGovernance } from "../../core/defaults.js";
import { canonicalizeExistingPath } from "../../core/path-canonical.js";
import { ToolNames } from "../../core/tool-names.js";
import type { DelegationToolCallLogEntry } from "../../domains/dispatch/types.js";
import {
	type AutonomyLevel,
	autonomyDenyRejection,
	DEFAULT_AUTONOMY_LEVEL,
	mapAutonomy,
} from "../../domains/safety/autonomy.js";
import type { SafetyContract, SafetyDecision } from "../../domains/safety/contract.js";
import type {
	AcpPermissionOption,
	AcpRequestPermissionParams,
	AcpRequestPermissionResponse,
	AcpToolCallLocation,
	AcpToolCallUpdate,
} from "./types.js";

interface MediatorInput {
	safety: SafetyContract;
	cwd: string;
	toolGovernance: DelegationToolGovernance;
	/**
	 * Session autonomy level (sd-01 §2.5). Applied after the safety net under
	 * clio-coder-policy governance; `ask` dispositions resolve as non-stall denials
	 * because a delegation has no operator to answer a prompt.
	 */
	autonomy?: AutonomyLevel;
	onPermissionResolved?(event: AcpMediatorPermissionResolvedEvent): void;
}

export interface AcpMediatorPermissionResolvedEvent {
	requestId: string;
	tool: string;
	actionClass: string;
	mode: "deny";
	source: "policy";
	reason: string;
}

interface MappedToolCall {
	tool: string;
	args: Record<string, unknown>;
	evaluations: ReadonlyArray<{ tool: string; args: Record<string, unknown> }>;
	known: boolean;
	displayTool: string;
	validationError?: string;
}

type MutationKind = "edit" | "delete" | "move";

interface ExtractedPaths {
	paths: string[];
	provided: boolean;
	errors: string[];
}

interface MutationTargets {
	paths: string[];
	error?: string;
}

const MUTATION_MARKERS = [
	"content",
	"new_string",
	"old_string",
	"new_str",
	"edits",
	"new_source",
	"replace_all",
	"patch",
	"diff",
] as const;

const SINGLE_MUTATION_PATH_KEYS = [
	"path",
	"file",
	"filename",
	"fileName",
	"file_name",
	"filePath",
	"file_path",
	"notebook_path",
	"target",
	"targetPath",
	"target_path",
	"uri",
] as const;

const MULTI_MUTATION_PATH_KEYS = ["paths", "files", "filePaths", "file_paths", "targets", "targetPaths"] as const;
const MOVE_SOURCE_PATH_KEYS = [
	"source",
	"sourcePath",
	"source_path",
	"src",
	"from",
	"fromPath",
	"from_path",
	"oldPath",
	"old_path",
	"path",
	"file",
	"filePath",
	"file_path",
] as const;
const MOVE_MULTI_SOURCE_PATH_KEYS = ["sources"] as const;
const MOVE_DESTINATION_PATH_KEYS = [
	"destination",
	"destinationPath",
	"destination_path",
	"dest",
	"destPath",
	"dest_path",
	"to",
	"toPath",
	"to_path",
	"newPath",
	"new_path",
	"target",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, ...keys: string[]): string | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim().length > 0) return value.trim();
	}
	return undefined;
}

function optionByKind(options: ReadonlyArray<AcpPermissionOption>, kinds: ReadonlyArray<string>): string | null {
	for (const kind of kinds) {
		const exact = options.find((option) => option.kind === kind);
		if (exact) return exact.optionId;
	}
	for (const option of options) {
		if (kinds.some((kind) => option.kind.startsWith(kind.split("_")[0] ?? kind))) return option.optionId;
	}
	return null;
}

function responseFor(decision: "approved" | "denied" | "cancelled", options: ReadonlyArray<AcpPermissionOption>) {
	if (decision === "cancelled") return { outcome: { outcome: "cancelled" as const } };
	const optionId =
		decision === "approved"
			? optionByKind(options, ["allow_once", "allow_always"])
			: optionByKind(options, ["reject_once", "reject_always"]);
	if (!optionId) return { outcome: { outcome: "cancelled" as const } };
	return { outcome: { outcome: "selected" as const, optionId } };
}

function commandArgs(rawInput: Record<string, unknown>, cwd: string): Record<string, unknown> {
	const command = stringField(rawInput, "command", "cmd", "shell", "input", "description") ?? "";
	return { command, cwd };
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
	return Object.hasOwn(record, key);
}

function canonicalMutationPath(value: unknown, cwd: string): { path?: string; error?: string } {
	if (typeof value !== "string") return { error: "path must be a string" };
	const trimmed = value.trim();
	if (trimmed.length === 0) return { error: "path must not be empty" };
	if (trimmed.includes("\0")) return { error: "path must not contain NUL" };

	let expanded = trimmed;
	if (trimmed === "~") expanded = homedir();
	else if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) expanded = path.join(homedir(), trimmed.slice(2));
	else if (trimmed.startsWith("~")) return { error: "named home-directory paths are not supported" };

	const windowsAbsolute = /^[A-Za-z]:[\\/]/.test(expanded) || expanded.startsWith("\\\\");
	if (windowsAbsolute && path.sep !== "\\") {
		return { error: "Windows paths cannot be evaluated on this host" };
	}
	if (!windowsAbsolute && /^[A-Za-z][A-Za-z\d+.-]*:/.test(expanded)) {
		if (!expanded.toLowerCase().startsWith("file:")) return { error: "path must be a filesystem path" };
		try {
			expanded = fileURLToPath(expanded);
		} catch {
			return { error: "file URL is malformed" };
		}
	}
	const absolute = path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(cwd, expanded);
	return { path: canonicalizeExistingPath(absolute) };
}

function appendUnique(target: string[], value: string): void {
	if (!target.includes(value)) target.push(value);
}

function samePathSet(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
	return left.length === right.length && left.every((candidate) => right.includes(candidate));
}

function extractPathFields(
	rawInput: Record<string, unknown>,
	singleKeys: ReadonlyArray<string>,
	multiKeys: ReadonlyArray<string>,
	cwd: string,
	label: string,
): ExtractedPaths {
	const fieldSets: string[][] = [];
	const errors: string[] = [];
	let provided = false;
	for (const key of singleKeys) {
		if (!hasOwn(rawInput, key)) continue;
		provided = true;
		const canonical = canonicalMutationPath(rawInput[key], cwd);
		if (canonical.path !== undefined) fieldSets.push([canonical.path]);
		else errors.push(`${label}.${key} ${canonical.error ?? "is malformed"}`);
	}
	for (const key of multiKeys) {
		if (!hasOwn(rawInput, key)) continue;
		provided = true;
		const value = rawInput[key];
		if (!Array.isArray(value) || value.length === 0) {
			errors.push(`${label}.${key} must be a non-empty array of paths`);
			continue;
		}
		const paths: string[] = [];
		for (const candidate of value) {
			const canonical = canonicalMutationPath(candidate, cwd);
			if (canonical.path !== undefined) appendUnique(paths, canonical.path);
			else errors.push(`${label}.${key} contains a path that ${canonical.error ?? "is malformed"}`);
		}
		if (paths.length > 0) fieldSets.push(paths);
	}

	const paths = fieldSets[0] ?? [];
	if (fieldSets.some((fieldSet) => !samePathSet(paths, fieldSet))) {
		errors.push(`${label} contains conflicting mutation targets`);
		for (const fieldSet of fieldSets) {
			for (const candidate of fieldSet) appendUnique(paths, candidate);
		}
	}
	return { paths, provided, errors };
}

function extractRawMutationPaths(rawInput: Record<string, unknown>, kind: MutationKind, cwd: string): ExtractedPaths {
	if (kind !== "move") {
		return extractPathFields(rawInput, SINGLE_MUTATION_PATH_KEYS, MULTI_MUTATION_PATH_KEYS, cwd, "rawInput");
	}

	const sources = extractPathFields(
		rawInput,
		MOVE_SOURCE_PATH_KEYS,
		MOVE_MULTI_SOURCE_PATH_KEYS,
		cwd,
		"rawInput source",
	);
	const destinations = extractPathFields(rawInput, MOVE_DESTINATION_PATH_KEYS, [], cwd, "rawInput destination");
	const complete = extractPathFields(rawInput, [], MULTI_MUTATION_PATH_KEYS, cwd, "rawInput");
	const rolePaths = [...sources.paths];
	for (const candidate of destinations.paths) appendUnique(rolePaths, candidate);
	const errors = [...sources.errors, ...destinations.errors, ...complete.errors];
	if (complete.provided && rolePaths.length > 0 && !samePathSet(complete.paths, rolePaths)) {
		errors.push("rawInput contains conflicting move targets");
	}
	const paths = complete.paths.length > 0 ? [...complete.paths] : rolePaths;
	for (const candidate of rolePaths) appendUnique(paths, candidate);
	return {
		paths,
		provided: sources.provided || destinations.provided || complete.provided,
		errors,
	};
}

function extractLocationPaths(locations: unknown, cwd: string): ExtractedPaths {
	if (locations === undefined) return { paths: [], provided: false, errors: [] };
	if (!Array.isArray(locations) || locations.length === 0) {
		return { paths: [], provided: true, errors: ["locations must be a non-empty array"] };
	}
	const paths: string[] = [];
	const errors: string[] = [];
	for (const value of locations) {
		if (!isRecord(value)) {
			errors.push("locations contains a non-object entry");
			continue;
		}
		const location = value as Partial<AcpToolCallLocation>;
		if (
			location.line !== undefined &&
			location.line !== null &&
			(!Number.isInteger(location.line) || location.line < 0)
		) {
			errors.push("locations contains an invalid line number");
		}
		const canonical = canonicalMutationPath(location.path, cwd);
		if (canonical.path !== undefined) appendUnique(paths, canonical.path);
		else errors.push(`locations contains a path that ${canonical.error ?? "is malformed"}`);
	}
	return { paths, provided: true, errors };
}

function mutationTargets(toolCall: AcpToolCallUpdate | undefined, kind: MutationKind, cwd: string): MutationTargets {
	const rawInput = isRecord(toolCall?.rawInput) ? toolCall.rawInput : {};
	const raw = extractRawMutationPaths(rawInput, kind, cwd);
	const locations = extractLocationPaths(toolCall?.locations, cwd);
	const errors = [...raw.errors, ...locations.errors];
	if (toolCall?.rawInput !== undefined && !isRecord(toolCall.rawInput)) {
		errors.push("rawInput must be an object");
	}
	if (raw.provided && locations.provided && !samePathSet(raw.paths, locations.paths)) {
		errors.push("rawInput and locations contain conflicting mutation targets");
	}

	const paths = locations.paths.length > 0 ? [...locations.paths] : [...raw.paths];
	for (const candidate of raw.paths) appendUnique(paths, candidate);
	if (paths.length === 0) errors.push("mutation target is missing");
	if (kind === "move" && paths.length < 2) errors.push("move requires at least two distinct mutation targets");
	return {
		paths,
		...(errors.length > 0 ? { error: [...new Set(errors)].join("; ") } : {}),
	};
}

function canonicalTargetArgs(paths: ReadonlyArray<string>): Record<string, unknown> {
	if (paths.length === 1) return { path: paths[0] };
	return { paths: [...paths] };
}

function mutationKind(kind: string, rawTool: string | undefined, mutationShape: boolean): MutationKind | null {
	if (kind === "delete") return "delete";
	if (kind === "move") return "move";
	if (kind === "edit" || rawTool === ToolNames.Write || rawTool === ToolNames.Edit) return "edit";
	// A declared benign kind/tool must never override a raw mutation shape.
	// Map it as a mutation first; metadata conflict validation below then denies
	// the contradictory request after evaluating its real canonical targets.
	return mutationShape ? "edit" : null;
}

function mutationMetadataConflict(
	kind: string,
	rawTool: string | undefined,
	mutation: MutationKind,
	mutationShape: boolean,
): string | undefined {
	const kindIsMutation = kind === "edit" || kind === "delete" || kind === "move";
	const toolIsMutation = rawTool === ToolNames.Write || rawTool === ToolNames.Edit;
	const rawToolIsKnown =
		rawTool !== undefined && Object.values(ToolNames).includes(rawTool as (typeof ToolNames)[keyof typeof ToolNames]);
	if (kindIsMutation && rawToolIsKnown && !toolIsMutation) {
		return `mutating ACP kind ${kind} conflicts with raw tool ${rawTool}`;
	}
	if (toolIsMutation && kind.length > 0 && !kindIsMutation) {
		return `mutating raw tool ${rawTool} conflicts with ACP kind ${kind}`;
	}
	if (mutation !== "edit" && toolIsMutation) {
		return `ACP ${mutation} kind conflicts with raw edit tool ${rawTool}`;
	}
	if (mutationShape && kind.length > 0 && !kindIsMutation) {
		return `raw mutation shape conflicts with ACP kind ${kind}`;
	}
	if (mutationShape && rawToolIsKnown && !toolIsMutation) {
		return `raw mutation shape conflicts with raw tool ${rawTool}`;
	}
	return undefined;
}

function hasRawMutationTarget(rawInput: Record<string, unknown>, hasLocations: boolean): boolean {
	return (
		hasLocations ||
		SINGLE_MUTATION_PATH_KEYS.some((key) => hasOwn(rawInput, key)) ||
		MULTI_MUTATION_PATH_KEYS.some((key) => hasOwn(rawInput, key)) ||
		MOVE_SOURCE_PATH_KEYS.some((key) => hasOwn(rawInput, key)) ||
		MOVE_DESTINATION_PATH_KEYS.some((key) => hasOwn(rawInput, key))
	);
}

function commandMetadataConflict(kind: string, rawTool: string | undefined): string | undefined {
	const rawToolIsKnown =
		rawTool !== undefined && Object.values(ToolNames).includes(rawTool as (typeof ToolNames)[keyof typeof ToolNames]);
	if (kind.length > 0 && kind !== "execute") return `raw command shape conflicts with ACP kind ${kind}`;
	if (rawToolIsKnown && rawTool !== ToolNames.Bash) return `raw command shape conflicts with raw tool ${rawTool}`;
	return undefined;
}

function mapMutationToolCall(
	toolCall: AcpToolCallUpdate | undefined,
	kind: MutationKind,
	displayTool: string,
	cwd: string,
	metadataError: string | undefined,
): MappedToolCall {
	const targets = mutationTargets(toolCall, kind, cwd);
	const args = canonicalTargetArgs(targets.paths);
	return {
		tool: ToolNames.Edit,
		args,
		evaluations: targets.paths.map((target) => ({ tool: ToolNames.Edit, args: { path: target } })),
		known: true,
		displayTool,
		...(metadataError !== undefined || targets.error !== undefined
			? {
					validationError: [metadataError, targets.error].filter((value): value is string => value !== undefined).join("; "),
				}
			: {}),
	};
}

function mapPathBearingToolCall(
	toolCall: AcpToolCallUpdate | undefined,
	tool: string,
	displayTool: string,
	cwd: string,
	targetRequired: boolean,
): MappedToolCall {
	const rawInput = isRecord(toolCall?.rawInput) ? toolCall.rawInput : {};
	const raw = extractPathFields(rawInput, SINGLE_MUTATION_PATH_KEYS, MULTI_MUTATION_PATH_KEYS, cwd, "rawInput");
	const locations = extractLocationPaths(toolCall?.locations, cwd);
	const errors = [...raw.errors, ...locations.errors];
	if (toolCall?.rawInput !== undefined && !isRecord(toolCall.rawInput)) errors.push("rawInput must be an object");
	if (raw.provided && locations.provided && !samePathSet(raw.paths, locations.paths)) {
		errors.push("rawInput and locations contain conflicting path targets");
	}
	const paths = locations.paths.length > 0 ? [...locations.paths] : [...raw.paths];
	for (const candidate of raw.paths) appendUnique(paths, candidate);
	if (targetRequired && paths.length === 0) errors.push("path target is missing");

	const baseArgs = tool === ToolNames.Grep ? { ...rawInput } : {};
	const args =
		paths.length === 0
			? baseArgs
			: paths.length === 1
				? { ...baseArgs, path: paths[0] }
				: { ...baseArgs, paths: [...paths] };
	const evaluations =
		paths.length > 0
			? paths.map((target) => ({ tool, args: { ...baseArgs, path: target } }))
			: [{ tool, args: baseArgs }];
	return {
		tool,
		args,
		evaluations,
		known: true,
		displayTool,
		...(errors.length > 0 ? { validationError: [...new Set(errors)].join("; ") } : {}),
	};
}

function mapToolCall(toolCall: AcpToolCallUpdate | undefined, cwd: string): MappedToolCall {
	const kind = typeof toolCall?.kind === "string" ? toolCall.kind.toLowerCase() : "";
	const rawInput = isRecord(toolCall?.rawInput) ? toolCall.rawInput : {};
	const rawTool = stringField(rawInput, "tool", "toolName", "tool_name", "name");
	const title = typeof toolCall?.title === "string" ? toolCall.title : undefined;
	const displayTool = rawTool ?? kind ?? title ?? "unknown";
	const mutationShape =
		MUTATION_MARKERS.some((key) => hasOwn(rawInput, key)) &&
		hasRawMutationTarget(rawInput, toolCall?.locations !== undefined);
	const commandShape = stringField(rawInput, "command", "cmd", "shell") !== undefined;
	const mappedMutation = mutationKind(kind, rawTool, mutationShape);
	if (mappedMutation !== null) {
		return mapMutationToolCall(
			toolCall,
			mappedMutation,
			displayTool,
			cwd,
			[
				mutationMetadataConflict(kind, rawTool, mappedMutation, mutationShape),
				commandShape ? "raw input contains both command and mutation shapes" : undefined,
			]
				.filter((value): value is string => value !== undefined)
				.join("; ") || undefined,
		);
	}
	if (rawTool === ToolNames.Bash || kind === "execute" || commandShape) {
		const args = commandArgs(rawInput, cwd);
		const validationError = commandShape ? commandMetadataConflict(kind, rawTool) : undefined;
		return {
			tool: ToolNames.Bash,
			args,
			evaluations: [{ tool: ToolNames.Bash, args }],
			known: true,
			displayTool,
			...(validationError !== undefined ? { validationError } : {}),
		};
	}
	if (kind === "fetch" && stringField(rawInput, "url") !== undefined && toolCall?.locations === undefined) {
		const args = { url: stringField(rawInput, "url") };
		return {
			tool: ToolNames.WebFetch,
			args,
			evaluations: [{ tool: ToolNames.WebFetch, args }],
			known: true,
			displayTool,
		};
	}
	if (rawTool === ToolNames.Read || kind === "read" || kind === "fetch") {
		return mapPathBearingToolCall(toolCall, ToolNames.Read, displayTool, cwd, true);
	}
	if (rawTool === ToolNames.Grep || kind === "search") {
		return mapPathBearingToolCall(toolCall, ToolNames.Grep, displayTool, cwd, false);
	}
	if (rawTool && Object.values(ToolNames).includes(rawTool as (typeof ToolNames)[keyof typeof ToolNames])) {
		return { tool: rawTool, args: rawInput, evaluations: [{ tool: rawTool, args: rawInput }], known: true, displayTool };
	}
	// Fallback: some ACP agents (notably @zed-industries/claude-code-acp) send a
	// permission request carrying only rawInput + title, omitting both `kind` and
	// the tool name. Infer the clio tool from the rawInput shape so the dangerous
	// classes (shell, writes, edits) are still classified and gated instead of
	// being blanket-denied as an unknown tool.
	if (stringField(rawInput, "command", "cmd", "shell")) {
		const args = commandArgs(rawInput, cwd);
		return { tool: ToolNames.Bash, args, evaluations: [{ tool: ToolNames.Bash, args }], known: true, displayTool };
	}
	const inferredPattern = stringField(rawInput, "pattern");
	if (inferredPattern) {
		const args = { pattern: inferredPattern };
		return { tool: ToolNames.Grep, args, evaluations: [{ tool: ToolNames.Grep, args }], known: true, displayTool };
	}
	const inferredPath = stringField(rawInput, "file_path", "filePath", "path", "notebook_path");
	if (inferredPath) {
		const mutates =
			"content" in rawInput ||
			"new_string" in rawInput ||
			"old_string" in rawInput ||
			"new_str" in rawInput ||
			"edits" in rawInput ||
			"new_source" in rawInput ||
			"replace_all" in rawInput;
		if (mutates) {
			return mapMutationToolCall(toolCall, "edit", displayTool, cwd, undefined);
		}
		const args = { path: inferredPath };
		return { tool: ToolNames.Read, args, evaluations: [{ tool: ToolNames.Read, args }], known: true, displayTool };
	}
	const inferredUrl = stringField(rawInput, "url");
	if (inferredUrl) {
		const args = { url: inferredUrl };
		return {
			tool: ToolNames.WebFetch,
			args,
			evaluations: [{ tool: ToolNames.WebFetch, args }],
			known: true,
			displayTool,
		};
	}
	return { tool: displayTool, args: rawInput, evaluations: [], known: false, displayTool };
}

function logSafety(decision: SafetyDecision | undefined): DelegationToolCallLogEntry["safetyDecision"] | undefined {
	if (!decision) return undefined;
	const out: NonNullable<DelegationToolCallLogEntry["safetyDecision"]> = {
		kind: decision.kind,
	};
	const policy = decision.policy;
	if (policy?.reasonCode !== undefined) out.reasonCode = policy.reasonCode;
	if (policy?.policySource !== undefined) out.policySource = policy.policySource;
	if (policy?.ruleId !== undefined) out.ruleId = policy.ruleId;
	return out;
}

export class AcpToolMediator {
	private requested = 0;
	private approved = 0;
	private denied = 0;
	private readonly log: DelegationToolCallLogEntry[] = [];

	constructor(private readonly input: MediatorInput) {}

	async handle(params: unknown): Promise<AcpRequestPermissionResponse> {
		const startedAt = performance.now();
		this.requested += 1;
		const parsed = isRecord(params) ? (params as AcpRequestPermissionParams) : {};
		const options = Array.isArray(parsed.options) ? parsed.options : [];
		const toolCall = isRecord(parsed.toolCall) ? (parsed.toolCall as AcpToolCallUpdate) : undefined;
		const mapped = mapToolCall(toolCall, this.input.cwd);
		let decision: "approved" | "denied" | "cancelled" = "denied";
		let reason: string | undefined;
		let safetyDecision: SafetyDecision | undefined;

		if (mapped.validationError !== undefined) {
			if (this.input.toolGovernance === "clio-coder-policy") {
				const invalidSafetyDecisions = mapped.evaluations.map((evaluation) =>
					this.input.safety.evaluate({ tool: evaluation.tool, args: evaluation.args }),
				);
				safetyDecision =
					invalidSafetyDecisions.find((candidate) => candidate.kind === "block") ??
					invalidSafetyDecisions.find((candidate) => candidate.kind === "ask") ??
					invalidSafetyDecisions[0];
			}
			decision = "denied";
			reason = `invalid ACP mutation targets: ${mapped.validationError}`;
		} else if (this.input.toolGovernance === "agent-managed") {
			decision = "approved";
			reason = "agent-managed governance";
		} else if (this.input.toolGovernance === "deny-all") {
			decision = "denied";
			reason = "deny-all governance";
		} else if (!mapped.known) {
			decision = "denied";
			reason = `unknown ACP tool: ${mapped.displayTool}`;
		} else {
			const safetyDecisions = mapped.evaluations.map((evaluation) =>
				this.input.safety.evaluate({ tool: evaluation.tool, args: evaluation.args }),
			);
			const blocking = safetyDecisions.find((candidate) => candidate.kind === "block");
			const asking = safetyDecisions.find((candidate) => candidate.kind === "ask");
			safetyDecision = blocking ?? asking ?? safetyDecisions[0];
			if (blocking !== undefined) {
				decision = "denied";
				reason = blocking.policy?.reasonCode ?? blocking.kind;
			} else if (asking !== undefined) {
				decision = "denied";
				reason = "permission_required: denied by non-stall policy (no interactive operator in delegation context)";
			} else if (safetyDecisions.length > 0) {
				// The net passed; the autonomy mapping decides (sd-01 §2.2). An
				// "ask" disposition resolves as a non-stall denial, exactly like a
				// net confirm rail below: a delegation has no operator to answer.
				const level = this.input.autonomy ?? DEFAULT_AUTONOMY_LEVEL;
				const dispositions = safetyDecisions.map((candidate) => ({
					candidate,
					disposition: mapAutonomy(level, candidate.classification.actionClass, {
						executeRecognized: candidate.policy?.execRecognition !== "unrecognized",
					}),
				}));
				const deniedDisposition = dispositions.find((candidate) => candidate.disposition === "deny");
				const askDisposition = dispositions.find((candidate) => candidate.disposition === "ask");
				if (deniedDisposition !== undefined) {
					safetyDecision = deniedDisposition.candidate;
					decision = "denied";
					reason = autonomyDenyRejection(level, mapped.tool, deniedDisposition.candidate.classification.actionClass).short;
				} else if (askDisposition !== undefined) {
					safetyDecision = askDisposition.candidate;
					decision = "denied";
					reason = `permission_required: autonomy ${level} requires approval for ${askDisposition.candidate.classification.actionClass}; denied by non-stall policy (no interactive operator in delegation context)`;
				} else {
					decision = "approved";
					reason = safetyDecision?.policy?.reasonCode ?? "allowed";
				}
			} else {
				decision = "denied";
				reason = "ACP tool produced no policy-evaluable arguments";
			}
		}

		if (decision === "approved") this.approved += 1;
		else this.denied += 1;
		const loggedSafety = logSafety(safetyDecision);
		const callId = toolCall?.toolCallId ?? `permission-${this.requested}`;
		this.log.push({
			callId,
			tool: mapped.tool,
			arguments: { ...mapped.args },
			decision,
			...(reason !== undefined ? { reason } : {}),
			...(loggedSafety !== undefined ? { safetyDecision: loggedSafety } : {}),
			durationMs: Math.round(performance.now() - startedAt),
			timestamp: new Date().toISOString(),
		});
		if (decision === "denied" && reason?.startsWith("permission_required:")) {
			this.input.onPermissionResolved?.({
				requestId: callId,
				tool: mapped.tool,
				actionClass: safetyDecision?.classification.actionClass ?? "unknown",
				mode: "deny",
				source: "policy",
				reason,
			});
		}
		return responseFor(decision, options);
	}

	snapshot(): {
		toolCallsRequested: number;
		toolCallsApproved: number;
		toolCallsDenied: number;
		toolCallLog: DelegationToolCallLogEntry[];
	} {
		return {
			toolCallsRequested: this.requested,
			toolCallsApproved: this.approved,
			toolCallsDenied: this.denied,
			toolCallLog: [...this.log],
		};
	}
}
