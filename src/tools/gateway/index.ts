import { Type } from "typebox";
import { rankByPrecomputedScore } from "../../core/precomputed-rank.js";
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
	type McpCapabilityMetadata,
	type McpCapabilitySource,
	type McpCapabilitySourceOptions,
	type McpCatalog,
	type McpCatalogEntry,
	type McpCatalogProvenance,
	type McpCloseReport,
	type McpListing,
	type McpMetadataResult,
	type McpRefreshResult,
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

/** Entries an unfiltered listing must exceed before a ranker is asked to order it. */
export const GATEWAY_RANK_MIN_LISTING = 40;
/** A query with fewer lexical hits than this asks the ranker for related entries. */
export const GATEWAY_RELATED_BELOW_HITS = 3;
/** Related entries a find adds beside a query's own hits. */
export const GATEWAY_RELATED_MAX = 5;
/** Probability at or above which a ranked entry counts as related. */
const GATEWAY_RELATED_MIN_SCORE = 0.5;

/** Scores for capability names, and who produced them. */
export interface GatewayCapabilityRanking {
	scores: Readonly<Record<string, number>>;
	source: string;
}

/**
 * Ranks capabilities against what find was asked for, or returns null when it
 * has no opinion. Bound only on the session registry, from the `capabilities`
 * decision site; a worker's gateway and an unbound session never rank.
 */
export type GatewayCapabilityRanker = (
	request: { query: string; entries: ReadonlyArray<{ name: string; description: string }> },
	signal?: AbortSignal,
) => Promise<GatewayCapabilityRanking | null>;

export interface GatewayToolDeps {
	registry: ToolRegistry;
	/** Local MCP servers, present on the session registry only. */
	mcp?: McpCapabilitySource;
	rankCapabilities?: GatewayCapabilityRanker;
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
		// The find payload names the exact refresh call for a server whose catalog
		// is missing, so the remedy is taught where it is needed rather than
		// carried in every turn's attached schema.
		server: Type.Optional(Type.String({ description: "find: one MCP server id." })),
		refresh: Type.Optional(Type.Boolean({ description: "find: list that server live." })),
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
			return "Write class: runs in default and yolo, and is denied for read-only runs.";
		case "execute":
			return "Execute class: an unrecognized command asks in default, runs in yolo, and is denied for read-only runs.";
		case "dispatch":
			return "Dispatch class: plan-scale calls ask in default, run in yolo, and are denied for read-only runs.";
		case "unknown":
			return "No action class was declared: default asks for approval, yolo runs it, and read-only runs deny it.";
		default:
			return `Action class ${actionClass}.`;
	}
}

export function createGatewayTool(deps: GatewayToolDeps): ToolSpec {
	const { registry } = deps;

	const allowedSet = (options: ToolInvokeOptions | undefined): ReadonlySet<string> | null => {
		const run = options?.allowedTools;
		const turn = options?.turnConstraints?.allowedTools;
		if (run === undefined && turn === undefined) return null;
		return new Set((run ?? turn ?? []).filter((name) => turn === undefined || turn.includes(name)));
	};

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
		message: `gateway: capability "${name}" is not on this run's admitted tool surface (${[...allowed].sort().join(", ")}); the recipe or explicit task scope excludes it`,
	});

	/**
	 * Ask the ranker, never letting it cost the find. Every failure is the
	 * listing the substring filter already produced.
	 */
	const rank = async (
		query: string,
		entries: ReadonlyArray<GatewayCapabilityEntry>,
		signal: AbortSignal | undefined,
	): Promise<GatewayCapabilityRanking | null> => {
		if (deps.rankCapabilities === undefined || entries.length === 0) return null;
		try {
			return await deps.rankCapabilities(
				{ query, entries: entries.map((entry) => ({ name: entry.name, description: entry.description })) },
				signal,
			);
		} catch {
			return null;
		}
	};

	const runFind = async (args: Record<string, unknown>, options: ToolInvokeOptions | undefined): Promise<ToolResult> => {
		const rawQuery = typeof args.query === "string" ? args.query.trim() : "";
		const query = rawQuery.toLowerCase();
		const server = typeof args.server === "string" ? args.server.trim() : "";
		const refresh = args.refresh === true;
		const allowed = allowedSet(options);
		if (refresh && server.length === 0) {
			return {
				kind: "error",
				message: 'gateway: refresh needs the server it applies to; call gateway(op="find", server="<id>", refresh=true)',
			};
		}
		if (server.length > 0 || refresh) {
			if (deps.mcp === undefined) {
				return { kind: "error", message: "gateway: this session declares no local MCP servers" };
			}
			// A restricted surface already suppresses broad MCP discovery. Let it
			// launch a server here and the recipe's tool ceiling would stop being
			// a ceiling on what this run can start.
			if (allowed !== null) {
				return {
					kind: "error",
					message: `gateway: MCP discovery is not available on this run's admitted tool surface (${[...allowed].sort().join(", ")}); the recipe or explicit task scope excludes it`,
				};
			}
			const declared = deps.mcp.declaredIds();
			if (!declared.includes(server)) {
				return {
					kind: "error",
					message: `gateway: no MCP server named "${server}" is declared${declared.length > 0 ? `; declared servers: ${[...declared].sort().join(", ")}` : ""}`,
				};
			}
		}
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
			// MCP metadata comes from recorded catalogs, so an ordinary find lists
			// what this session offers without launching a single server. Only an
			// explicit scoped refresh connects, and only to the server it names.
			let servers: McpServerListing[] = [];
			let diagnostics: string[] = [];
			let missing: string[] = [];
			let mcpEntries: GatewayCapabilityEntry[] = [];
			let refreshNote: string | undefined;
			// A named server narrows the whole answer to that server, so the
			// registry's builtins and extensions are not part of it. The scoped
			// form is rejected above on a restricted surface, so the two filters
			// here never have to compose.
			const scoped = server.length > 0;
			if (deps.mcp && allowed === null) {
				if (refresh) {
					const result = await deps.mcp.refresh(server, options?.signal ? { signal: options.signal } : {});
					if (result.reason !== undefined) refreshNote = result.reason;
				}
				const catalog = deps.mcp.catalog();
				servers = scoped ? catalog.servers.filter((entry) => entry.id === server) : catalog.servers;
				diagnostics = catalog.diagnostics;
				missing = scoped ? catalog.missing.filter((id) => id === server) : catalog.missing;
				mcpEntries = catalog.entries
					.filter((entry) => !scoped || deps.mcp?.ownerIdOf(entry.name) === server)
					.map((entry) => ({
						name: entry.name,
						kind: gatewayCapabilityKind(entry.name),
						description: firstSentence(entry.description),
						actionClass: entry.actionClass,
					}));
			}
			const registryEntries: GatewayCapabilityEntry[] = registry
				.listGateway()
				// Scoping asks the source who owns a name rather than testing the
				// `mcp_<id>__` prefix. Server ids may contain `__`, so with
				// declarations `a` and `a__b` the prefix test hands `a__b`'s
				// capabilities to a caller that asked for `a`.
				.filter((spec) => (scoped ? deps.mcp?.ownerIdOf(spec.name) === server : allowed === null || allowed.has(spec.name)))
				.map((spec) => ({
					name: spec.name,
					kind: gatewayCapabilityKind(spec.name),
					description: firstSentence(spec.description),
					actionClass: spec.baseActionClass,
				}));
			// A registered spec is the live one; a cached descriptor of the same
			// name is the older snapshot of it and must not displace it.
			const byName = new Map(registryEntries.map((entry) => [entry.name, entry]));
			for (const entry of mcpEntries) if (!byName.has(entry.name)) byName.set(entry.name, entry);
			const catalogEntries = [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
			let entries = catalogEntries.filter(
				(entry) =>
					query.length === 0 || entry.name.toLowerCase().includes(query) || entry.description.toLowerCase().includes(query),
			);
			// A ranking only ever reorders an unfiltered listing or adds related
			// entries beside a query's own hits. The hits keep their order, nothing
			// is removed, and a scoped find is the one server the caller named.
			let rankedBy: string | undefined;
			let related: GatewayCapabilityEntry[] = [];
			let relatedBy: string | undefined;
			if (!scoped && query.length === 0 && entries.length > GATEWAY_RANK_MIN_LISTING) {
				const ranking = await rank("", entries, options?.signal);
				if (ranking !== null) {
					entries = rankByPrecomputedScore(entries, (entry) => entry.name, ranking.scores).map((ranked) => ranked.item);
					rankedBy = ranking.source;
				}
			} else if (!scoped && query.length > 0 && entries.length < GATEWAY_RELATED_BELOW_HITS) {
				const hits = new Set(entries.map((entry) => entry.name));
				const others = catalogEntries.filter((entry) => !hits.has(entry.name));
				const ranking = await rank(rawQuery, others, options?.signal);
				if (ranking !== null) {
					related = others
						.filter((entry) => (ranking.scores[entry.name] ?? 0) >= GATEWAY_RELATED_MIN_SCORE)
						.sort((left, right) => (ranking.scores[right.name] ?? 0) - (ranking.scores[left.name] ?? 0))
						.slice(0, GATEWAY_RELATED_MAX);
					if (related.length > 0) relatedBy = ranking.source;
				}
			}
			const total = entries.length;
			const shown = entries.slice(0, GATEWAY_FIND_MAX_ENTRIES);
			const truncated = shown.length < total;
			const payload = {
				capabilities: shown,
				count: shown.length,
				total,
				...(servers.length > 0 ? { servers } : {}),
				...(missing.length > 0
					? {
							missingCatalogs: missing,
							missingCatalogsNote:
								'no recorded tool list for these servers; run gateway(op="find", server="<id>", refresh=true)',
						}
					: {}),
				...(refreshNote !== undefined ? { refresh: refreshNote } : {}),
				...(diagnostics.length > 0 ? { diagnostics } : {}),
				...(truncated ? { note: "listing truncated; narrow it with query" } : {}),
				...(rankedBy !== undefined
					? { order: `ranked by ${rankedBy} against this turn's task; every capability is still listed` }
					: {}),
				...(relatedBy !== undefined
					? {
							related,
							relatedNote: `not matched by the query text; judged related to it by ${relatedBy}`,
						}
					: {}),
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

	/** Authority notes shared by a live spec and a cached MCP descriptor, which describe identically. */
	const admissionNotes = (name: string, actionClass: ActionClass): string[] => [
		`Runs through the same admission as a direct call, under its own name and action class (${actionClass}); the approval overlay, audit row, and ledger record name ${name}, not the gateway.`,
		autonomyNote(actionClass),
	];

	/**
	 * Describe an MCP capability the registry does not hold, from its recorded
	 * catalog. This never launches the owning server: the schema shown here is a
	 * snapshot, and the call path validates against the server's live listing,
	 * so launching to describe would buy nothing and spend a process.
	 */
	const describeFromCatalog = (name: string): ToolResult => {
		const found = deps.mcp?.metadata(name);
		if (found?.metadata == null) {
			return {
				kind: "error",
				message: `gateway: ${found?.reason ?? `unknown capability ${name}`}`,
			};
		}
		const { metadata } = found;
		const authority = [
			...admissionNotes(metadata.name, metadata.actionClass),
			"Recorded catalog, not a live listing: the server's current schema is what a call validates against, and a tool it no longer offers fails rather than running.",
		];
		if (metadata.truncated) {
			authority.push(
				`The catalog this came from is incomplete; list the server again with gateway(op="find", server="${metadata.serverId}", refresh=true).`,
			);
		}
		const mcpNote = deps.mcp?.authorityNote(metadata.name);
		if (mcpNote) authority.push(mcpNote);
		return {
			kind: "ok",
			output: JSON.stringify({
				name: metadata.name,
				kind: "mcp",
				description: metadata.description,
				parameters: wireParameterSchema(metadata.parameters),
				actionClass: metadata.actionClass,
				executionMode: "sequential",
				catalog: metadata.provenance,
				authority,
			}),
			details: { op: "describe", described: metadata.name, catalog: metadata.provenance },
		};
	};

	const runDescribe = (args: Record<string, unknown>, options: ToolInvokeOptions | undefined): ToolResult => {
		const name = typeof args.capability === "string" ? args.capability.trim() : "";
		if (name.length === 0) return { kind: "error", message: 'gateway: op="describe" requires capability' };
		const allowed = allowedSet(options);
		if (allowed !== null && !allowed.has(name)) return outsideSurface(name, allowed);
		const spec = registry.get(name as ToolName);
		if (spec === undefined) {
			if (isMcpToolName(name) && deps.mcp) return describeFromCatalog(name);
			return {
				kind: "error",
				message: `gateway: unknown capability "${name}"; run gateway(op="find") to list the capabilities this session offers`,
			};
		}
		if (toolSpecPlacement(spec) === "direct") {
			return {
				kind: "error",
				message: `gateway: "${name}" is a direct tool with an attached schema; call it directly, not through the gateway`,
			};
		}
		const kind = gatewayCapabilityKind(spec.name);
		const authority = admissionNotes(spec.name, spec.baseActionClass);
		if (spec.name === ToolNames.WebFetch) {
			authority.push(
				"A non-GET method or a body is an outward action and asks in default; use web_read when a plain GET is enough.",
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
			// A registered MCP spec came from this session's own listing, so it
			// carries the same provenance field a cached descriptor does.
			...(kind === "mcp" ? { catalog: "live" } : {}),
			authority,
		};
		return {
			kind: "ok",
			output: JSON.stringify(payload),
			details: { op: "describe", described: spec.name, ...(kind === "mcp" ? { catalog: "live" } : {}) },
		};
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
			// Discovery scope belongs to find alone. Accepting it elsewhere would
			// read as a way to launch a server from describe or call, which is
			// exactly what those two paths no longer do on their own.
			if (op !== "find" && (args.server !== undefined || args.refresh !== undefined)) {
				return { kind: "error", message: `gateway: server and refresh apply to op="find", not op="${op}"` };
			}
			if (op === "find") return runFind(args, options);
			if (op === "describe") return runDescribe(args, options);
			if (op === "call") return runCall(args, options);
			return { kind: "error", message: `gateway: op must be find, describe, or call; got '${op}'` };
		},
	};
}
