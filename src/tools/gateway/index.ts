import { Type } from "typebox";
import { isMcpToolName, type ToolName, ToolNames } from "../../core/tool-names.js";
import type { ActionClass } from "../../domains/safety/action-classifier.js";
import { StringEnum, validateEngineToolArguments } from "../../engine/ai.js";
import { wireParameterSchema } from "../agent-tools.js";
import type { ToolSurface } from "../lazy-tool.js";
import {
	commitObservationReservation,
	finalizeObservation,
	observationBudgetExhausted,
	releaseObservation,
	reserveObservation,
} from "../observation.js";
import {
	nestedBlockedResult,
	nestedExecutedResult,
	type ToolInvokeOptions,
	type ToolRegistry,
	type ToolResult,
	type ToolSpec,
} from "../registry.js";
import { type GatewayCapabilityKind, gatewayCapabilityKind, toolSpecPlacement } from "../surface.js";
import { GATEWAY_FIND_SELF_CAP_BYTES } from "./caps.js";
import type { McpCapabilitySource, McpServerListing } from "./mcp-capabilities.js";

export { GATEWAY_FIND_SELF_CAP_BYTES } from "./caps.js";
export {
	createMcpCapabilitySource,
	type McpCapabilitySource,
	type McpCapabilitySourceOptions,
	type McpCloseReport,
	type McpListing,
	type McpServerListing,
	type McpTeardownReport,
	mcpTrustRemedy,
} from "./mcp-capabilities.js";

/**
 * The gateway: one stable find/describe/call schema through which the model
 * reaches every secondary capability. A call is not a new authority path: the
 * gateway resolves the capability and invokes it through the registry under
 * the capability's own name, so the safety net, the skill surface, the
 * autonomy mapping, parking for approval, before/after hooks, result shaping,
 * and the audit row all happen exactly as for a direct call. The result is
 * the capability's result with `details.capability` stamped on it, and a
 * refused capability refuses the gateway call with the same verdict.
 */

export const GATEWAY_OPS = ["find", "describe", "call"] as const;
export type GatewayOp = (typeof GATEWAY_OPS)[number];

/** Entries a find listing returns before it says `truncated` and asks for a narrower query. */
export const GATEWAY_FIND_MAX_ENTRIES = 300;

export interface GatewayCapabilityEntry {
	name: string;
	kind: GatewayCapabilityKind;
	/** The first sentence of the capability's description. */
	description: string;
	actionClass: ActionClass;
}

export interface GatewayToolDeps {
	registry: ToolRegistry;
	/** Local MCP servers, present on the session registry only. */
	mcp?: McpCapabilitySource;
}

const DESCRIPTION =
	'Reach secondary capabilities on demand. op="find" lists them as JSON {name, kind: builtin|extension|mcp, description, actionClass} (query filters by name or description); op="describe" returns one capability\'s full description, JSON parameter schema, and authority notes; op="call" runs one with args under the same admission as a direct tool: its own action class, approval, and evidence apply and the result is the capability\'s result. Capabilities: artifact (terminal plan/review/report documents), web_read (GET-only web reading), web_fetch (full HTTP requests), git (read-only status/diff/log), evidence, credential_present, clio_docs, clio_library, data (CSV/TSV, JSON, JSONL inspection), installed extension commands, and trusted local MCP servers.';

export const gatewayToolSurface = {
	name: ToolNames.Gateway,
	description: DESCRIPTION,
	parameters: Type.Object({
		op: StringEnum(GATEWAY_OPS, { description: "find, describe, or call." }),
		capability: Type.Optional(Type.String({ description: "describe and call: the capability name from find." })),
		query: Type.Optional(Type.String({ description: "find: case-insensitive filter over names and descriptions." })),
		args: Type.Optional(
			Type.Record(Type.String(), Type.Unknown(), {
				description: "call: the capability's arguments, matching its describe schema.",
			}),
		),
	}),
	baseActionClass: "read",
	executionMode: "sequential",
} satisfies ToolSurface;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Accept the weak-model shapes: `args` as a JSON string, `name`/`tool` for
 * `capability`, and a missing `op` inferred from what else was given.
 */
function prepareGatewayArguments(args: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = { ...args };
	if (typeof out.capability !== "string") {
		const alias = out.name ?? out.tool;
		if (typeof alias === "string") out.capability = alias;
	}
	if (typeof out.args === "string") {
		try {
			const parsed: unknown = JSON.parse(out.args);
			if (isRecord(parsed)) out.args = parsed;
		} catch {
			// The body reports the unparseable string.
		}
	}
	if (typeof out.op !== "string") {
		if (typeof out.capability === "string" && out.args !== undefined) out.op = "call";
		else if (typeof out.capability === "string") out.op = "describe";
		else out.op = "find";
	}
	return out;
}

function firstSentence(text: string): string {
	const line = text.split("\n")[0]?.trim() ?? "";
	const match = /^(.*?[.!?])(?:\s|$)/u.exec(line);
	return (match?.[1] ?? line).slice(0, 240);
}

function autonomyNote(actionClass: ActionClass): string {
	switch (actionClass) {
		case "read":
			return "Read class: runs at every autonomy level.";
		case "write":
			return "Write class: parks for operator approval at suggest, runs at auto-edit and full-auto, and is denied at read-only.";
		case "execute":
			return "Execute class: an unrecognized command asks at auto-edit, runs at full-auto, and is denied at read-only.";
		case "dispatch":
			return "Dispatch class: plan-scale calls ask below full-auto; denied at read-only.";
		case "unknown":
			return "No action class was declared: every call asks for approval and read-only denies it.";
		default:
			return `Action class ${actionClass}.`;
	}
}

export function createGatewayTool(deps: GatewayToolDeps): ToolSpec {
	const { registry } = deps;

	const allowedSet = (options: ToolInvokeOptions | undefined): ReadonlySet<string> | null =>
		options?.allowedTools ? new Set<string>(options.allowedTools) : null;

	const resolveCapability = async (
		name: string,
		options: ToolInvokeOptions | undefined,
	): Promise<{ spec: ToolSpec } | { spec: null; message: string }> => {
		let spec = registry.get(name as ToolName);
		if (spec === undefined && isMcpToolName(name) && deps.mcp) {
			const ensured = await deps.mcp.ensure(name, options?.signal ? { signal: options.signal } : {});
			if (ensured.spec === null)
				return { spec: null, message: `gateway: ${ensured.reason ?? `unknown capability ${name}`}` };
			spec = ensured.spec;
		}
		if (spec === undefined) {
			return {
				spec: null,
				message: `gateway: unknown capability "${name}"; run gateway(op="find") to list the capabilities this session offers`,
			};
		}
		if (toolSpecPlacement(spec) === "direct") {
			return {
				spec: null,
				message: `gateway: "${name}" is a direct tool with an attached schema; call it directly, not through the gateway`,
			};
		}
		return { spec };
	};

	const outsideSurface = (name: string, allowed: ReadonlySet<string>): ToolResult => ({
		kind: "error",
		message: `gateway: capability "${name}" is not on this run's admitted tool surface (${[...allowed].sort().join(", ")}); the recipe did not declare it, so the gateway refuses to call it`,
	});

	const runFind = async (args: Record<string, unknown>, options: ToolInvokeOptions | undefined): Promise<ToolResult> => {
		const query = typeof args.query === "string" ? args.query.trim().toLowerCase() : "";
		const allowed = allowedSet(options);
		const reservation = reserveObservation(GATEWAY_FIND_SELF_CAP_BYTES, options);
		if (reservation.exhausted) {
			return observationBudgetExhausted({
				tool: ToolNames.Gateway,
				unit: "entries",
				reservation,
				subject: query.length > 0 ? `find query=${query}` : "find",
				hint: "Continue in a follow-up turn.",
			});
		}
		commitObservationReservation(reservation);
		try {
			// Trusted MCP servers connect here, lazily, and register their tools
			// before the registry listing below is taken. Untrusted and stale
			// servers are described with their remedy and never launched.
			let servers: McpServerListing[] = [];
			let diagnostics: string[] = [];
			if (deps.mcp && allowed === null) {
				const listing = await deps.mcp.list(options?.signal ? { signal: options.signal } : {});
				servers = listing.servers;
				diagnostics = listing.diagnostics;
			}
			const entries: GatewayCapabilityEntry[] = registry
				.listGateway()
				.filter((spec) => allowed === null || allowed.has(spec.name))
				.map((spec) => ({
					name: spec.name,
					kind: gatewayCapabilityKind(spec.name),
					description: firstSentence(spec.description),
					actionClass: spec.baseActionClass,
				}))
				.filter(
					(entry) =>
						query.length === 0 || entry.name.toLowerCase().includes(query) || entry.description.toLowerCase().includes(query),
				)
				.sort((left, right) => left.name.localeCompare(right.name));
			const total = entries.length;
			const shown = entries.slice(0, GATEWAY_FIND_MAX_ENTRIES);
			const truncated = shown.length < total;
			const payload = {
				capabilities: shown,
				count: shown.length,
				total,
				...(servers.length > 0 ? { servers } : {}),
				...(diagnostics.length > 0 ? { diagnostics } : {}),
				...(truncated ? { note: "listing truncated; narrow it with query" } : {}),
			};
			return finalizeObservation({
				tool: ToolNames.Gateway,
				unit: "entries",
				format: "json",
				output: JSON.stringify(payload),
				shownCount: shown.length,
				totalCount: total,
				truncated,
				...(truncated ? { next: "query=<narrower terms>" } : {}),
				details: { op: "find", count: shown.length, total, servers: servers.length },
				reservation,
				...(options ? { options } : {}),
			});
		} catch (error) {
			releaseObservation(reservation);
			return { kind: "error", message: `gateway: find failed: ${error instanceof Error ? error.message : String(error)}` };
		}
	};

	const runDescribe = async (
		args: Record<string, unknown>,
		options: ToolInvokeOptions | undefined,
	): Promise<ToolResult> => {
		const name = typeof args.capability === "string" ? args.capability.trim() : "";
		if (name.length === 0) return { kind: "error", message: 'gateway: op="describe" requires capability' };
		const allowed = allowedSet(options);
		if (allowed !== null && !allowed.has(name)) return outsideSurface(name, allowed);
		const resolved = await resolveCapability(name, options);
		if (resolved.spec === null) return { kind: "error", message: resolved.message };
		const spec = resolved.spec;
		const kind = gatewayCapabilityKind(spec.name);
		const authority = [
			`Runs through the same admission as a direct call, under its own name and action class (${spec.baseActionClass}); the approval overlay, audit row, and ledger record name ${spec.name}, not the gateway.`,
			autonomyNote(spec.baseActionClass),
		];
		if (spec.name === ToolNames.WebFetch) {
			authority.push(
				"A non-GET method or a body is an outward action and asks at suggest and auto-edit; use web_read when a plain GET is enough.",
			);
		}
		if (spec.name === ToolNames.Artifact) {
			authority.push("Terminal: writing the artifact completes the turn, so close the task board before calling it.");
		}
		if (kind === "extension") {
			authority.push(
				`Harness extension${spec.sourceInfo?.extension ? ` ${spec.sourceInfo.extension.contentDigest.slice(0, 12)}` : ""}: an installed command run with JSON input on the workspace; its argv is classified like a bash command, and running it does not sandbox it.`,
			);
		}
		const mcpNote = kind === "mcp" ? deps.mcp?.authorityNote(spec.name) : null;
		if (mcpNote) authority.push(mcpNote);
		const payload = {
			name: spec.name,
			kind,
			description: spec.description,
			parameters: wireParameterSchema(spec.parameters),
			actionClass: spec.baseActionClass,
			executionMode: spec.executionMode ?? "sequential",
			authority,
		};
		return { kind: "ok", output: JSON.stringify(payload), details: { op: "describe", described: spec.name } };
	};

	const runCall = async (args: Record<string, unknown>, options: ToolInvokeOptions | undefined): Promise<ToolResult> => {
		const name = typeof args.capability === "string" ? args.capability.trim() : "";
		if (name.length === 0) return { kind: "error", message: 'gateway: op="call" requires capability' };
		const allowed = allowedSet(options);
		if (allowed !== null && !allowed.has(name)) return outsideSurface(name, allowed);
		const resolved = await resolveCapability(name, options);
		if (resolved.spec === null) return { kind: "error", message: resolved.message };
		const spec = resolved.spec;
		if (args.args !== undefined && !isRecord(args.args)) {
			return { kind: "error", message: `gateway: args for ${spec.name} must be a JSON object` };
		}
		const rawArgs: Record<string, unknown> = isRecord(args.args) ? args.args : {};
		// The same coercion pi-ai applies to a direct call's arguments before
		// execute, so "5" reaches a number field as 5 either way.
		let validated: Record<string, unknown>;
		try {
			validated = validateEngineToolArguments(
				{ name: spec.name, description: spec.description, parameters: spec.parameters },
				{ type: "toolCall", id: options?.toolCallId ?? "", name: spec.name, arguments: rawArgs },
			) as Record<string, unknown>;
		} catch (error) {
			return {
				kind: "error",
				message: `gateway: ${spec.name} arguments rejected: ${error instanceof Error ? error.message : String(error)}. Use gateway(op="describe", capability="${spec.name}") for the schema.`,
			};
		}
		// The nested call keeps the outer options (signal, ids, skill policy,
		// progress, park accounting) minus any one-shot approval, which was
		// granted to the gateway call and must not travel to the capability.
		const { approval: _approval, ...outer } = options ?? {};
		const verdict = await registry.invoke({ tool: spec.name, args: validated }, { ...outer, nested: true });
		if (verdict.kind === "not_visible") return { kind: "error", message: `gateway: ${verdict.reason}` };
		if (verdict.kind === "blocked") return nestedBlockedResult(verdict);
		return nestedExecutedResult(
			{ ...verdict.result, details: { ...verdict.result.details, capability: spec.name } },
			verdict.decision,
		);
	};

	return {
		...gatewayToolSurface,
		prepareArguments: prepareGatewayArguments,
		async run(rawArgs, options): Promise<ToolResult> {
			const args = prepareGatewayArguments(rawArgs);
			const op = typeof args.op === "string" ? args.op : "";
			if (op === "find") return runFind(args, options);
			if (op === "describe") return runDescribe(args, options);
			if (op === "call") return runCall(args, options);
			return { kind: "error", message: `gateway: op must be find, describe, or call; got '${op}'` };
		},
	};
}
