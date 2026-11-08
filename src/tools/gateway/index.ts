import { Type } from "typebox";
import { discoveryScore } from "../../core/harness-discovery.js";
import type { CatalogRanker, PrecomputedRanking } from "../../core/precomputed-rank.js";
import { rankByPrecomputedScore } from "../../core/precomputed-rank.js";
import { isMcpToolName, type ToolName, ToolNames } from "../../core/tool-names.js";
import { toolSurfaceSources } from "../../core/turn-constraints.js";
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
	nestedChainResult,
	nestedExecutedResult,
	prepareToolArgs,
	resolveToolPromptHint,
	type ToolInvokeOptions,
	type ToolRegistry,
	type ToolResult,
	type ToolSpec,
} from "../registry.js";
import { type GatewayCapabilityKind, gatewayCapabilityKind, surfaceSpecPlacement } from "../surface.js";
import { GATEWAY_FIND_SELF_CAP_BYTES } from "./caps.js";
import { runGatewayChain } from "./chain.js";
import { capabilityArgumentShape, gatewayExamples } from "./guidance.js";
import type { McpCapabilitySource, McpLaunchOptions, McpServerListing } from "./mcp-capabilities.js";

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

export const GATEWAY_OPS = ["find", "describe", "call", "chain"] as const;
export type GatewayOp = (typeof GATEWAY_OPS)[number];

/** Entries a find listing returns before it says `truncated` and asks for a narrower query. */
export const GATEWAY_FIND_MAX_ENTRIES = 300;

export interface GatewayCapabilityEntry {
	name: string;
	kind: GatewayCapabilityKind;
	/** The first sentence of the capability's description. */
	description: string;
	actionClass: ActionClass;
	/** Required field names are a compact cue, not a substitute for the full schema. */
	requiredArgs?: ReadonlyArray<string>;
	argumentShape?: string;
	/** An MCP server's own read-only or destructive annotation; `actionClass` is what Clio enforces. */
	serverHint?: "read-only" | "destructive";
	/** Why an MCP capability cannot succeed as things stand, such as a server policy refusal. */
	unavailable?: string;
}

/** Entries an unfiltered listing must exceed before a ranker is asked to order it. */
export const GATEWAY_RANK_MIN_LISTING = 40;
export interface GatewayToolDeps {
	registry: ToolRegistry;
	/** Local MCP servers, present on the session registry only. */
	mcp?: McpCapabilitySource;
	rankCapabilities?: CatalogRanker;
	/** A capability the model called through the gateway, which feeds the capability gate's usage prior. */
	onCapabilityCalled?: (name: string) => void;
}

const DESCRIPTION =
	'Discover builtin, extension and MCP capabilities. op="find" searches; an exact name adds its schema. op="describe" returns a schema; op="call" runs it with args under its own admission; op="chain" runs tool steps. Put capability at top level, its parameters in args. After an argument error, describe the capability before retrying. Chain syntax: op="describe", capability="gateway"; gateway ops are not chain capabilities. Discovery grants no authority.';

export const gatewayToolSurface: ToolSurface = {
	name: ToolNames.Gateway,
	description: DESCRIPTION,
	parameters: Type.Object({
		op: StringEnum(GATEWAY_OPS, { description: "Gateway operation." }),
		capability: Type.Optional(Type.String({ description: "describe and call: the capability name." })),
		query: Type.Optional(Type.String({ description: "find: task terms or the next step." })),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 300, description: "find: page size." })),
		offset: Type.Optional(Type.Integer({ minimum: 0, description: "find: nextOffset." })),
		// The find payload names the exact refresh call for a server whose catalog
		// is missing, so the remedy is taught where it is needed rather than
		// carried in every turn's attached schema.
		server: Type.Optional(Type.String({ description: "find: one MCP server id." })),
		refresh: Type.Optional(Type.Boolean({ description: "find: list that server live." })),
		args: Type.Optional(
			Type.Record(Type.String(), Type.Unknown(), {
				description: "call: the capability's arguments matching its described schema; nest them here.",
			}),
		),
		steps: Type.Optional(
			Type.Array(Type.Unknown(), {
				maxItems: 16,
				description: 'chain: {id,capability,args,after?:[ids]}; describe capability="gateway" for bindings.',
			}),
		),
	}),
	baseActionClass: "read",
	executionMode: "sequential",
};

/** A read-only turn starts only MCP servers trusted as read, before any call reaches admission (Z1). */
function mcpLaunchOptions(options: ToolInvokeOptions | undefined): McpLaunchOptions {
	return {
		...(options?.signal ? { signal: options.signal } : {}),
		...(options?.turnConstraints?.readOnly === true ? { readOnly: true } : {}),
	};
}

/**
 * Prepend a line to the text the model reads while the output stays the
 * capability's bytes, the projection withApprovalNote uses for a grant. A
 * stale catalog the model just read is fixed by what it reads next, not by
 * the data a chain or a display takes from the output (K9).
 */
function withModelLine(result: ToolResult, line: string): ToolResult {
	const note = `${line}\n`;
	const text = result.modelContext ?? (result.kind === "ok" ? result.output : result.message);
	const disposition = result.details?.resultDisposition;
	const details =
		isRecord(disposition) && typeof disposition.contextBytes === "number"
			? {
					...result.details,
					resultDisposition: { ...disposition, contextBytes: disposition.contextBytes + Buffer.byteLength(note) },
				}
			: result.details;
	return { ...result, modelContext: `${note}${text}`, ...(details === undefined ? {} : { details }) };
}

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
	// Arguments only ever belong to a call. A request carrying them without a
	// capability is a call whose envelope was nested inside `args`; reading it
	// as find answered a mis-wrapped call with a successful discovery listing,
	// and the model took that as the call having run.
	if (typeof out.op !== "string") {
		if (out.args !== undefined) out.op = "call";
		else if (typeof out.capability === "string") out.op = "describe";
		else out.op = "find";
	}
	return out;
}

/** The correction for a call whose op or capability went inside `args`. */
function envelopeHint(args: Record<string, unknown>): string {
	const nested = isRecord(args.args) ? args.args : null;
	const named = nested?.capability ?? nested?.name ?? nested?.tool;
	const capability = typeof named === "string" && named.trim().length > 0 ? named.trim() : "<name>";
	return `op and capability belong at the top level and args holds only the capability's own arguments: {"op":"call","capability":"${capability}","args":{...}}. No capability was invoked.`;
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

/** The capability names this run may reach, or null when nothing restricts it. */
function allowedSet(options: ToolInvokeOptions | undefined): ReadonlySet<string> | null {
	const run = options?.allowedTools;
	const turn = options?.turnConstraints?.allowedTools;
	if (run === undefined && turn === undefined) return null;
	return new Set((run ?? turn ?? []).filter((name) => turn === undefined || turn.includes(name)));
}

/** What `find` would list for this run with each capability's full description, for a caller that filters them. */
export function gatewayCapabilityItems(
	registry: ToolRegistry,
	mcp: McpCapabilitySource | undefined,
	options: ToolInvokeOptions | undefined,
): Array<{ name: string; description: string }> {
	const allowed = allowedSet(options);
	const admitted = (name: string): boolean => allowed === null || allowed.has(name);
	const entries = new Map<string, string>();
	for (const spec of registry.listAll()) {
		if (surfaceSpecPlacement(spec, allowed) === "gateway" && admitted(spec.name))
			entries.set(spec.name, spec.description);
	}
	for (const entry of mcp?.catalog().entries ?? []) {
		if (admitted(entry.name)) entries.set(entry.name, entry.description);
	}
	return [...entries].map(([name, description]) => ({ name, description }));
}

export function createGatewayTool(deps: GatewayToolDeps): ToolSpec {
	const { registry } = deps;

	/** Whether this run's tool surface names any capability of MCP server `id`. */
	const admitsServer = (id: string, allowed: ReadonlySet<string> | null): boolean =>
		allowed === null || [...allowed].some((name) => deps.mcp?.ownerIdOf(name) === id);

	/** A server listing projected onto the capabilities a restricted surface admits. */
	const admittedListing = (entry: McpServerListing, allowed: ReadonlySet<string> | null): McpServerListing => {
		if (allowed === null) return entry;
		const { tools, unregistrable: _unregistrable, catalogCount: _catalogCount, ...rest } = entry;
		const admitted = tools?.filter((name) => allowed.has(name));
		return { ...rest, ...(admitted !== undefined ? { tools: admitted } : {}) };
	};

	const unknownCapabilityMessage = (name: string, options: ToolInvokeOptions | undefined): string => {
		const allowed = allowedSet(options);
		if (allowed !== null)
			return `gateway: no such capability "${name}"; admitted capabilities: ${[...allowed].sort().join(", ") || "(none)"}. Use these exact names; gateway(op="find") lists their descriptions.`;
		const registered = registry
			.listAll()
			.map((spec) => spec.name)
			.sort();
		const mcp = deps.mcp
			? ' MCP server tools load on first call and are missing until then; gateway(op="find", server="<id>") lists them.'
			: "";
		return `gateway: no such capability "${name}"; registered tools: ${registered.join(", ") || "(none)"}. Use these exact names; gateway(op="find") lists their descriptions.${mcp}`;
	};

	const unknownCapability = (name: string): boolean =>
		registry.get(name as ToolName) === undefined &&
		(!isMcpToolName(name) || deps.mcp === undefined || deps.mcp.ownerIdOf(name) === null);

	const directCallGuidance = (name: string): string =>
		`"${name}" is a direct tool with an attached schema; call it directly, not through the gateway`;

	const resolveCapability = async (
		name: string,
		options: ToolInvokeOptions | undefined,
		allowDirect = false,
	): Promise<{ spec: ToolSpec } | { spec: null; message: string }> => {
		let spec = registry.get(name as ToolName);
		if (isMcpToolName(name) && deps.mcp) {
			const ensured = await deps.mcp.ensure(name, mcpLaunchOptions(options));
			if (ensured.spec === null)
				return { spec: null, message: `gateway: ${ensured.reason ?? `unknown capability ${name}`}` };
			spec = ensured.spec;
		}
		if (spec === undefined) {
			return {
				spec: null,
				message: unknownCapabilityMessage(name, options),
			};
		}
		if (!allowDirect && surfaceSpecPlacement(spec, allowedSet(options)) === "direct") {
			return {
				spec: null,
				message: `gateway: ${directCallGuidance(name)}`,
			};
		}
		return { spec };
	};

	const surfaceRefusal = (
		options: ToolInvokeOptions | undefined,
		admits: (tools: readonly string[]) => boolean,
	): string => {
		const sources = toolSurfaceSources(options?.turnConstraints).filter((entry) => !admits(entry.tools));
		if (sources.length === 0)
			return "Refused by: dispatch tool scope.\nRemedy: Ask the operator to widen this dispatch's tool scope, then redispatch.";
		return `Refused by: ${[...new Set(sources.map((entry) => entry.source))].join("; ")}.\nRemedy: ${[...new Set(sources.map((entry) => entry.remedy))].join(" ")}`;
	};

	const outsideSurface = (
		name: string,
		allowed: ReadonlySet<string>,
		options: ToolInvokeOptions | undefined,
	): ToolResult => ({
		kind: "error",
		details: { refusal: { kind: "tool_surface" } },
		message: `gateway: capability "${name}" is not on this run's admitted tool surface; admitted capabilities: ${[...allowed].sort().join(", ") || "(none)"}. Use one of these exact names.\n${surfaceRefusal(options, (tools) => tools.includes(name))}`,
	});

	/** Never lets a ranking cost the find: every miss or failure is the listing it already had. */
	const rank = (entries: ReadonlyArray<GatewayCapabilityEntry>): PrecomputedRanking | null => {
		if (deps.rankCapabilities === undefined || entries.length === 0) return null;
		try {
			return deps.rankCapabilities({
				need: "",
				candidates: entries.map((entry) => ({ id: entry.name, summary: entry.description })),
			});
		} catch {
			return null;
		}
	};

	/**
	 * An unscoped find names a server by one of its capability names, or by its
	 * id as a whole word elsewhere in the query. Capability names come out first,
	 * punctuation and all, so a dotted tool part never reads as another server id.
	 */
	const queryNamesServer = (query: string, id: string, mcp: McpCapabilitySource): boolean => {
		let named = false;
		const rest = query.replace(/mcp_[a-z0-9][a-z0-9_-]*__[a-z0-9][a-z0-9_.-]*/g, (match) => {
			const name = match.replace(/\.+$/, "");
			if (isMcpToolName(name) && mcp.ownerIdOf(name) === id) named = true;
			return " ";
		});
		return named || rest.split(/[^a-z0-9_-]+/).includes(id.toLowerCase());
	};

	const runFind = async (args: Record<string, unknown>, options: ToolInvokeOptions | undefined): Promise<ToolResult> => {
		if (args.args !== undefined) {
			return { kind: "error", message: `gateway: op="find" takes no args; ${envelopeHint(args)}` };
		}
		const rawQuery = typeof args.query === "string" ? args.query.trim() : "";
		const query = rawQuery.toLowerCase();
		const server = typeof args.server === "string" ? args.server.trim() : "";
		const refresh = args.refresh === true;
		const limit =
			typeof args.limit === "number" ? Math.max(1, Math.min(GATEWAY_FIND_MAX_ENTRIES, Math.floor(args.limit))) : 12;
		const offset = typeof args.offset === "number" ? Math.max(0, Math.floor(args.offset)) : 0;
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
			const declared = deps.mcp.declaredIds();
			// A restricted surface may discover and launch only a server it was
			// given a capability of. Naming `mcp_<id>__<tool>` already lets a call
			// start that server, so scoped discovery of it widens nothing; any other
			// server stays out, or the tool ceiling would stop bounding what this
			// run can start. Its refusal names only the admitted servers and reads
			// the same for an undeclared id, so probing ids reveals no declaration.
			if (allowed !== null && !admitsServer(server, allowed)) {
				const admitted = declared.filter((id) => admitsServer(id, allowed)).sort();
				return {
					kind: "error",
					message: `gateway: MCP server "${server}" is not on this run's admitted tool surface; none of its capabilities are admitted${admitted.length > 0 ? ` (admitted servers: ${admitted.join(", ")})` : ""}.\n${surfaceRefusal(options, (tools) => tools.some((name) => deps.mcp?.ownerIdOf(name) === server))}`,
				};
			}
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
			// registry's builtins and extensions are not part of it. A restricted
			// surface narrows it again to the capabilities it names, and to the
			// servers that own one of them.
			const scoped = server.length > 0;
			const shownServer = (id: string): boolean => (scoped ? id === server : admitsServer(id, allowed));
			if (deps.mcp) {
				if (refresh) {
					const result = await deps.mcp.refresh(server, mcpLaunchOptions(options));
					if (result.reason !== undefined) refreshNote = result.reason;
				} else {
					// A declared, trusted server with no recorded catalog would answer
					// nothing and cost the model a second find with refresh=true (K10).
					// When this find names it, list it live now; a launch that fails
					// leaves the missing catalog and its remedy as before.
					const mcp = deps.mcp;
					const named = mcp
						.catalog()
						.missing.filter((id) => (scoped ? id === server : shownServer(id) && queryNamesServer(query, id, mcp)));
					const notes: string[] = [];
					for (const id of named) {
						const result = await mcp.refresh(id, mcpLaunchOptions(options));
						if (result.reason !== undefined) notes.push(result.reason);
					}
					if (notes.length > 0) refreshNote = notes.join("; ");
				}
				const catalog = deps.mcp.catalog();
				// A restricted surface lists only the servers it names a capability
				// of, projected onto those capabilities, and never a server it may
				// not reach.
				servers = catalog.servers.filter((entry) => shownServer(entry.id)).map((entry) => admittedListing(entry, allowed));
				diagnostics = allowed === null ? catalog.diagnostics : [];
				missing = catalog.missing.filter(shownServer);
				mcpEntries = catalog.entries
					.filter((entry) => !scoped || deps.mcp?.ownerIdOf(entry.name) === server)
					.filter((entry) => allowed === null || allowed.has(entry.name))
					.map((entry) => ({
						name: entry.name,
						kind: gatewayCapabilityKind(entry.name),
						description: firstSentence(entry.description),
						actionClass: entry.actionClass,
					}));
			}
			const registryEntries: GatewayCapabilityEntry[] = registry
				.listAll()
				.filter((spec) => surfaceSpecPlacement(spec, allowed) === "gateway")
				// Scoping asks the source who owns a name rather than testing the
				// `mcp_<id>__` prefix. Server ids may contain `__`, so with
				// declarations `a` and `a__b` the prefix test hands `a__b`'s
				// capabilities to a caller that asked for `a`.
				.filter((spec) => !scoped || deps.mcp?.ownerIdOf(spec.name) === server)
				.filter((spec) => allowed === null || allowed.has(spec.name))
				.map((spec) => {
					const schema: unknown = spec.parameters;
					const requiredArgs =
						isRecord(schema) && Array.isArray(schema.required)
							? schema.required.filter((name): name is string => typeof name === "string")
							: [];
					return {
						name: spec.name,
						kind: gatewayCapabilityKind(spec.name),
						description: firstSentence(spec.description),
						actionClass: spec.baseActionClass,
						...(requiredArgs.length > 0 ? { requiredArgs } : {}),
						...(capabilityArgumentShape(spec) ? { argumentShape: capabilityArgumentShape(spec) } : {}),
					};
				});
			// A registered spec is the live one; a cached descriptor of the same
			// name is the older snapshot of it and must not displace it.
			const byName = new Map(registryEntries.map((entry) => [entry.name, entry]));
			for (const entry of mcpEntries) if (!byName.has(entry.name)) byName.set(entry.name, entry);
			// Discovery states what Clio knows beyond the enforced class: the
			// server's own read/write annotation, and a refusal the server's policy
			// already gave this session, so an excluded read neither reads as a
			// write nor as callable.
			const catalogEntries = [...byName.values()]
				.map((entry) => (entry.kind === "mcp" ? { ...entry, ...deps.mcp?.discoveryNote(entry.name) } : entry))
				.sort((left, right) => left.name.localeCompare(right.name));
			const exactName = catalogEntries.find((entry) => entry.name.toLowerCase() === query);
			const discoveryText = (entry: GatewayCapabilityEntry): string => {
				const spec = registry.get(entry.name as ToolName);
				return spec
					? [
							spec.description,
							spec.metadata?.objective,
							spec.metadata?.discoveryHint,
							...(spec.metadata?.examples ?? []).slice(0, 3).map(({ goal }) => goal),
						]
							.filter(Boolean)
							.join(" ")
					: entry.description;
			};
			// Tokenize each descriptor once, not on every sort comparison for a large catalog.
			let entries = exactName
				? [exactName]
				: query.length === 0
					? catalogEntries
					: catalogEntries
							.map((entry) => ({
								entry,
								score: discoveryScore(query, entry.name, discoveryText(entry)),
							}))
							.filter(({ score }) => score > 0)
							.sort((left, right) => right.score - left.score || left.entry.name.localeCompare(right.entry.name))
							.map(({ entry }) => entry);
			// A ranking only ever reorders an unfiltered listing. Nothing is removed, and a
			// scoped find is the one server the caller named.
			let rankedBy: string | undefined;
			if (!scoped && query.length === 0 && entries.length > GATEWAY_RANK_MIN_LISTING) {
				const ranking = rank(entries);
				if (ranking !== null) {
					entries = rankByPrecomputedScore(entries, (entry) => entry.name, ranking.scores).map((ranked) => ranked.item);
					rankedBy = ranking.source;
				}
			}
			const total = entries.length;
			const shown = entries.slice(offset, offset + limit);
			const truncated = offset + shown.length < total;
			// An exact name answers with what describe would, so the model can call it without a describe round trip,
			// which resends the whole context once more (OAI-6). A recorded MCP catalog describes without launching.
			const registered = exactName && offset === 0 ? registry.get(exactName.name as ToolName) : undefined;
			const exactSpec = registered && surfaceSpecPlacement(registered, allowed) === "gateway" ? registered : undefined;
			const fromCatalog =
				exactName && offset === 0 && registered === undefined && exactName.kind === "mcp"
					? describedFromCatalog(exactName.name)
					: undefined;
			const described =
				exactSpec !== undefined
					? describedSpec(exactSpec, false, allowed)
					: fromCatalog !== undefined && !("message" in fromCatalog)
						? fromCatalog
						: undefined;
			// Guidance follows the already-filtered page: it never reveals an excluded capability.
			const examples =
				query.length > 0 && described === undefined
					? shown.slice(0, 1).flatMap((entry) => {
							const spec = registry.get(entry.name as ToolName);
							return spec ? gatewayExamples(spec, rawQuery, 1, allowed) : [];
						})
					: [];
			const payload = {
				capabilities: shown,
				count: shown.length,
				total,
				...(described !== undefined ? { described } : {}),
				...(examples.length > 0
					? {
							examples,
							exampleNote:
								'Examples are gateway arguments. Substitute task values; use op="describe", capability="<name>" for other options. This catalog finds capabilities, not workspace content.',
						}
					: {}),
				...(query.length > 0 && total === 0 && !scoped
					? {
							note:
								"No matching capabilities. Search by operation, such as search file contents or inspect structured data; this catalog does not search workspace files.",
						}
					: {}),
				...(truncated ? { nextOffset: offset + shown.length } : {}),
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
				...(truncated ? { note: "more matches; follow nextOffset or narrow query" } : {}),
				...(rankedBy !== undefined
					? { order: `ranked by ${rankedBy} against this turn's task; all capabilities remain available across pages` }
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
				...(truncated ? { next: `offset=${offset + shown.length}` } : {}),
				details: { op: "find", count: shown.length, total, servers: servers.length },
				reservation,
				...(options ? { options } : {}),
			});
		} catch (error) {
			releaseObservation(reservation);
			return { kind: "error", message: `gateway: find failed: ${error instanceof Error ? error.message : String(error)}` };
		}
	};

	/**
	 * A direct tool whose attached schema is a compact projection (dispatch)
	 * still accepts its canonical fields. Since 9348b2358 describe returns the
	 * attached schema, so without this block compete, council and review had no
	 * discovery path at all. `mode` is repeated because only the canonical
	 * description names compete and council.
	 */
	const advancedDirectParameters = (spec: ToolSpec): Record<string, unknown> | null => {
		if (spec.modelParameters === undefined) return null;
		const attached = (spec.modelParameters as { properties?: Record<string, unknown> }).properties ?? {};
		const canonical = (spec.parameters as { properties?: Record<string, unknown> }).properties ?? {};
		const properties: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(canonical)) {
			if (!(key in attached) || key === "mode") properties[key] = wireParameterSchema(value);
		}
		return Object.keys(properties).length > 0 ? { type: "object", properties } : null;
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
	const describedFromCatalog = (name: string) => {
		const found = deps.mcp?.metadata(name);
		if (found?.metadata == null) return { message: `gateway: ${found?.reason ?? `unknown capability ${name}`}` };
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
			name: metadata.name,
			kind: "mcp",
			description: metadata.description,
			parameters: wireParameterSchema(metadata.parameters),
			actionClass: metadata.actionClass,
			executionMode: "sequential",
			catalog: metadata.provenance,
			authority,
		};
	};

	const describeFromCatalog = (name: string): ToolResult => {
		const described = describedFromCatalog(name);
		if ("message" in described) return { kind: "error", message: described.message };
		return {
			kind: "ok",
			output: JSON.stringify(described),
			details: { op: "describe", described: described.name, catalog: described.catalog },
		};
	};

	const runDescribe = async (
		args: Record<string, unknown>,
		options: ToolInvokeOptions | undefined,
	): Promise<ToolResult> => {
		const name = typeof args.capability === "string" ? args.capability.trim() : "";
		if (name.length === 0)
			return {
				kind: "error",
				message: 'gateway: op="describe" requires a top-level capability name. Use gateway(op="find") to discover it.',
			};
		const allowed = allowedSet(options);
		// The admitted wrapper can describe its own transport syntax even when
		// scope named only an inner capability. This grants no child admission.
		if (allowed !== null && !allowed.has(name) && name !== ToolNames.Gateway)
			return outsideSurface(name, allowed, options);
		if (allowed === null && unknownCapability(name))
			return {
				kind: "error",
				message: unknownCapabilityMessage(name, options),
				details: { refusal: { kind: "unknown_capability" } },
			};
		let spec = registry.get(name as ToolName);
		if (spec === undefined && isMcpToolName(name) && deps.mcp) {
			// A restricted surface cannot refresh a catalog (runFind refuses it), so
			// an admitted name with none recorded launches its own server here, as
			// a call of that name would, and is described from the live listing.
			if (allowed === null || deps.mcp.metadata(name).metadata !== null) return describeFromCatalog(name);
			const ensured = await deps.mcp.ensure(name, mcpLaunchOptions(options));
			if (ensured.spec === null) {
				return { kind: "error", message: `gateway: ${ensured.reason ?? `unknown capability ${name}`}` };
			}
			spec = ensured.spec;
		}
		if (spec === undefined) {
			return {
				kind: "error",
				message: unknownCapabilityMessage(name, options),
			};
		}
		const direct = surfaceSpecPlacement(spec, allowed) === "direct";
		if (direct && name !== ToolNames.Dispatch && name !== ToolNames.Gateway) {
			return {
				kind: "error",
				message: `gateway: ${directCallGuidance(name)}`,
			};
		}
		const kind = gatewayCapabilityKind(spec.name);
		return {
			kind: "ok",
			output: JSON.stringify(describedSpec(spec, direct, allowed)),
			details: { op: "describe", described: spec.name, ...(kind === "mcp" ? { catalog: "live" } : {}) },
		};
	};

	/** What describe answers for a spec the caller may see; find embeds it for an exact name hit. */
	const describedSpec = (spec: ToolSpec, direct: boolean, allowed: ReadonlySet<string> | null) => {
		const name = spec.name;
		const kind = gatewayCapabilityKind(spec.name);
		const authority = direct
			? [directCallGuidance(spec.name), autonomyNote(spec.baseActionClass)]
			: admissionNotes(spec.name, spec.baseActionClass);
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
				`Extension${spec.sourceInfo?.extension ? ` ${spec.sourceInfo.extension.contentDigest.slice(0, 12)}` : ""}: an installed command run with JSON input on the workspace; its argv is classified like a bash command, and running it does not sandbox it.`,
			);
		}
		const mcpNote = kind === "mcp" ? deps.mcp?.authorityNote(spec.name) : null;
		if (mcpNote) authority.push(mcpNote);
		const examples = gatewayExamples(spec, "", 3, allowed);
		const advanced = direct ? advancedDirectParameters(spec) : null;
		if (advanced !== null) {
			authority.push(
				"advanced lists canonical fields the attached schema omits to save tokens; the direct call accepts them and canonical validation checks every call.",
			);
		}
		const payload = {
			name: spec.name,
			kind,
			description: spec.description,
			parameters: wireParameterSchema(direct ? (spec.modelParameters ?? spec.parameters) : spec.parameters),
			...(advanced !== null ? { advanced } : {}),
			...(spec.metadata?.discoveryHint ? { orientation: spec.metadata.discoveryHint } : {}),
			actionClass: spec.baseActionClass,
			executionMode: spec.executionMode ?? "sequential",
			// A registered MCP spec came from this session's own listing, so it
			// carries the same provenance field a cached descriptor does.
			...(kind === "mcp" ? { catalog: "live" } : {}),
			authority,
			...(examples.length > 0
				? {
						examples,
						exampleNote:
							"Substitute task values in these gateway arguments; examples do not establish that their sample paths exist.",
					}
				: {}),
			...(resolveToolPromptHint(spec.metadata?.promptHint, "session")
				? {
						usage: resolveToolPromptHint(spec.metadata?.promptHint, "session"),
					}
				: {}),
			...(name === ToolNames.Gateway
				? {
						chain: {
							steps:
								'1..16 steps {id,capability,args,after?:[ids]}; steps execute registered tools. For schema discovery call gateway with op="describe" separately. Unique ids, no cycles or nested gateways. Direct tools may be steps.',
							binding:
								"In args, {$from:<step id>,path:[<keys>]} consumes output (text), json (decoded output), or details. References add dependencies. Values remain data, never evaluated code.",
							scheduling:
								"Independent read-class tools declaring parallel execution run up to four at once; all other operations serialize. Every step is validated and admitted under its own name, safety, skill policy and task scope.",
							boundaries:
								"Failure, cancellation, skill activation, user interview or terminal result stops scheduling. Inspect results and pending ids before continuing; never repeat completed mutations. Read first, then formulate an interview from evidence when the questions are not yet known.",
							composition:
								"Use dispatch tasks/mode=parallel or pipeline for worker assignments; load skills through context(scope=skills,name=...) only at their workflow step. Activation and operator answers require reasoning before continuation.",
						},
					}
				: {}),
		};
		return payload;
	};

	const runCall = async (
		args: Record<string, unknown>,
		options: ToolInvokeOptions | undefined,
		allowDirect = false,
	): Promise<ToolResult> => {
		const name = typeof args.capability === "string" ? args.capability.trim() : "";
		if (name.length === 0) {
			return { kind: "error", message: `gateway: op="call" requires capability; ${envelopeHint(args)}` };
		}
		const allowed = allowedSet(options);
		// A restricted run gets one refusal for every name off its surface, so it
		// cannot probe which registered tools or declared MCP servers exist.
		if (allowed !== null && !allowed.has(name)) return outsideSurface(name, allowed, options);
		if (allowed === null && unknownCapability(name))
			return {
				kind: "error",
				message: unknownCapabilityMessage(name, options),
				details: { refusal: { kind: "unknown_capability" } },
			};
		const resolved = await resolveCapability(name, options, allowDirect);
		if (resolved.spec === null) {
			// A recorded tool the upgraded server dropped fails here, before any run (K9).
			const changed = isMcpToolName(name) ? (deps.mcp?.takeCatalogChange(name) ?? null) : null;
			return { kind: "error", message: changed === null ? resolved.message : `${changed}\n${resolved.message}` };
		}
		const spec = resolved.spec;
		try {
			deps.onCapabilityCalled?.(spec.name);
		} catch {
			// Outcome recording never costs the call it observes.
		}
		if (args.args !== undefined && !isRecord(args.args)) {
			return { kind: "error", message: `gateway: args for ${spec.name} must be a JSON object` };
		}
		const rawArgs: Record<string, unknown> = isRecord(args.args) ? args.args : {};
		// The direct path runs the capability's normalizer ahead of schema
		// validation (agent-tools wires it as pi's prepareArguments), so a prose
		// limitation reason or a JSON-string run_script array lands the same way
		// here. Admission-prepared tools keep theirs on the registry path there too.
		const preparedArgs = spec.prepareAdmissionArguments ? rawArgs : prepareToolArgs(spec, rawArgs);
		// The same coercion pi-ai applies to a direct call's arguments before
		// execute, so "5" reaches a number field as 5 either way.
		let validated: Record<string, unknown>;
		try {
			validated = validateEngineToolArguments(
				{ name: spec.name, description: spec.description, parameters: spec.parameters },
				{ type: "toolCall", id: options?.toolCallId ?? "", name: spec.name, arguments: preparedArgs },
			) as Record<string, unknown>;
		} catch (error) {
			const examples = gatewayExamples(spec, "", 1, allowedSet(options));
			// A schema the model read from an outdated recording is the likeliest
			// reason for the rejection, so the catalog change line belongs here (K9).
			const changed = isMcpToolName(spec.name) ? (deps.mcp?.takeCatalogChange(spec.name) ?? null) : null;
			return {
				kind: "error",
				message:
					(changed !== null ? `${changed}\n` : "") +
					`gateway: ${spec.name} arguments rejected: ${error instanceof Error ? error.message : String(error)}. Use gateway(op="describe", capability="${spec.name}") for the schema.` +
					(examples.length > 0 ? ` Example to adapt, not retry verbatim: ${JSON.stringify(examples[0])}` : ""),
			};
		}
		// The nested call keeps the outer options (signal, ids, skill policy,
		// progress, park accounting) minus any one-shot approval, which was
		// granted to the gateway call and must not travel to the capability.
		const { approval: _approval, ...outer } = options ?? {};
		const verdict = await registry.invoke({ tool: spec.name, args: validated }, { ...outer, nested: !allowDirect });
		if (verdict.kind === "not_visible") return { kind: "error", message: `gateway: ${verdict.reason}` };
		const admission = allowDirect
			? {
					outcome: verdict.kind === "blocked" ? "blocked" : verdict.result.kind === "ok" ? "ok" : "error",
					actionClass: verdict.decision.classification.actionClass,
					decision:
						verdict.kind === "blocked" && verdict.deniedPark === true
							? "permission_requested"
							: verdict.decision.kind === "allow"
								? "allowed"
								: verdict.decision.kind === "ask"
									? "permission_requested"
									: "blocked",
					...(verdict.decision.policy?.ruleId ? { ruleId: verdict.decision.policy.ruleId } : {}),
					...(verdict.decision.policy?.reasonCode ? { reasonCode: verdict.decision.policy.reasonCode } : {}),
					...(verdict.kind === "blocked" ? { blockReason: verdict.reason } : {}),
					...(verdict.kind === "ok" && verdict.result.kind === "ok" && verdict.result.terminate === true
						? { terminate: true }
						: {}),
					// A verify step naming no declared check ran nothing; receipts must not fold it as a failed check.
					...(verdict.kind === "ok" && verdict.result.kind === "error" && verdict.result.details?.unresolved === true
						? { unresolved: true }
						: {}),
				}
			: undefined;
		if (verdict.kind === "blocked") {
			const result = nestedBlockedResult(verdict);
			return { ...result, details: { ...result.details, ...(admission ? { chainAdmission: admission } : {}) } };
		}
		// A successful call still answers the stale catalog the model read. A chain
		// step keeps its result as later steps bind it; the chain says the line once.
		const changed =
			verdict.result.kind === "ok" && isMcpToolName(spec.name) ? (deps.mcp?.takeCatalogChange(spec.name) ?? null) : null;
		const executed: ToolResult = {
			...verdict.result,
			details: {
				...verdict.result.details,
				capability: spec.name,
				...(admission ? { chainAdmission: admission } : {}),
				...(changed !== null && allowDirect ? { catalogChange: changed } : {}),
			},
		};
		return nestedExecutedResult(changed !== null && !allowDirect ? withModelLine(executed, changed) : executed, verdict);
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
			if (op === "chain") {
				const executed: ToolResult[] = [];
				const result = await runGatewayChain(
					args.steps,
					{
						getSpec: (name) => registry.get(name as ToolName),
						call: async (name, stepArgs, stepOptions) => {
							const step = await runCall({ capability: name, args: stepArgs }, stepOptions, true);
							executed.push(step);
							return step;
						},
					},
					options,
				);
				const changes = [
					...new Set(
						executed.flatMap((step) => (typeof step.details?.catalogChange === "string" ? [step.details.catalogChange] : [])),
					),
				];
				return nestedChainResult(changes.length > 0 ? withModelLine(result, changes.join("\n")) : result, executed);
			}
			return { kind: "error", message: `gateway: op must be ${GATEWAY_OPS.join(", ")}; got '${op}'` };
		},
	};
}
