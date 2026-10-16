import { mcpToolName } from "../core/tool-names.js";
import { mcpToolActionClass } from "../domains/gateway/mcp/action-classes.js";
import type { McpClient } from "../domains/gateway/mcp/client.js";
import type { McpServerEntryScript, ResolvedMcpServer } from "../domains/gateway/mcp/index.js";
import {
	MCP_TRUST_ACTION_CLASSES,
	type McpTrustActionClass,
	type McpTrustOptions,
	resolveMcpServers,
	trustMcpServer,
	untrustMcpServer,
} from "../domains/gateway/mcp/index.js";
import { readMcpServerCatalog } from "../domains/gateway/mcp/metadata-cache.js";
import { canonicalProjectRoot } from "../domains/gateway/mcp/trust.js";
import type { RegistryVerdict } from "../tools/registry.js";
import { printError } from "./shared.js";

const HELP = `clio-coder mcp <command>

Commands:
  clio-coder mcp list [--refresh] [--json]
  clio-coder mcp test <id> [--call <tool> [--args <json>]]... [--json]
  clio-coder mcp trust <id> [--action-class <class>] [--network] [--json]
  clio-coder mcp untrust <id> [--json]

Action classes: ${MCP_TRUST_ACTION_CLASSES.join(", ")}

JSON responses (--json):
  list: {servers: [...], diagnostics: [...], trustDiagnostics: [...]}
    Each server includes its declaration, trust {status, actionClass, reason?},
    entry (project servers: the project files its trust binds, [] when none),
    network, networkSource?, and cached tools with per-tool actionClass.
    network is true when the server holds the worker network grant
    described under trust; networkSource says whether the trust record (project and
    plugin servers) or the user declaration granted it. --refresh lists
    trusted servers live and updates their catalogs; untrusted declarations
    are never launched. A diagnostic with severity "warning" is advisory.
  test: {ok, server: {id, scope, trust, network, networkSource?}, protocolVersion, serverInfo,
    tools: [{name, capability, actionClass, serverHint?}], truncated,
    calls: [{tool, isError, text, structuredContent?, refused?, denial?,
      serverPolicyRefusal?} | {tool, error}]}
    Launches one trusted server through the same client the gateway uses,
    lists its tools, makes each --call in order, and closes it. Each call is
    admitted as a session admits it; one that needs approval is refused, as
    in a headless run, and a tool the server does not list is never sent. A
    call whose request gets no answer is recorded as {tool, error} and ends
    the calls; a JSON-RPC error answer is that call's error.
    An untrusted or stale declaration is never launched. The supported seam for external
    integration checks; nothing outside Clio needs to import its source.
  trust: {ok: true, record: {projectRoot, id, digest, actionClass, trustedAt, network?,
    entryScriptHashes?}, entry: [...]}
    entry lists the project files the record binds: an absolute command,
    every argument not shaped like a flag and every value a flag carries
    after = (--require=./a.cjs) that names an existing file in the project.
    Imports, python -m modules, directories, npx or uvx bins and files named
    through env such as NODE_OPTIONS or PATH are not bound; a symlink whose
    target is outside the project is bound by path only. entryScriptHashes
    maps each bound file to its SHA-256. Bindings are checked when a session or worker takes its MCP
    snapshot, so an edit is caught from the next session or dispatch.
    --network lets the server's own sandboxed process reach the network in
    fleet workers; worker shells keep their policy. On Linux that is the host
    network namespace (internet, localhost services and abstract unix
    sockets); on macOS the seatbelt profile allows network. Credential masking
    is a denylist of known paths, so other secrets readable in the home can
    leave with the grant. A worker whose write roots contain or lie inside
    the server's launch cwd, the directory of a file it runs (a project
    server's bound entry files; every existing file argument of a user or
    plugin server), or a project server's project root starts it without
    the grant, which an in-place or worktree writer does for a server in its
    tree; a read-only worker keeps it. A module the server imports is not
    bound, so a writer's edit to one persists into a later read-only run
    that holds the grant. Re-trusting without it drops the grant. An older build sharing the
    config dir drops network and entryScriptHashes when it rewrites the trust
    file and sees entry-bound digests as stale.
  untrust: {ok: true, removed: boolean}
  errors: {ok: false, message: string}
Exit codes: 0 success; 1 operational failure; 2 invalid usage. A test also
 exits 1 when its server fails or one of its calls returns an error.
List retains its response shape on failure and exits 1 when config or trust
 diagnostics other than warnings are present. Mutation errors return the
 error shape with a one-line reason. --help prints this text even when --json
 is supplied.
`;

/**
 * The worker network grant as one per-server field. Only a trusted server
 * carries it; a stale record's grant lapses with its trust.
 */
function networkGrant(server: ResolvedMcpServer): { network: boolean; networkSource?: "trust" | "declaration" } {
	if (server.trust.status !== "trusted" || server.trust.network !== true) return { network: false };
	return { network: true, networkSource: server.scope === "user" ? "declaration" : "trust" };
}

/** The project files a project server's trust binds; null for a scope that binds none. */
function boundEntry(server: ResolvedMcpServer): string[] | null {
	return server.scope === "project" ? (server.entryScripts ?? []).map((entry) => entry.path) : null;
}

/**
 * Each binding as the trust record holds it: a symlinked entry names the real
 * path whose content is hashed, and one whose target is outside the project
 * is marked as bound by path only, so the printed list matches the record.
 */
function entryLabel(entries: ReadonlyArray<McpServerEntryScript>): string {
	if (entries.length === 0) return "entry=none";
	const spelled = entries.map((entry) => {
		if ("error" in entry || entry.realPath === undefined) return entry.path;
		return "sha256" in entry ? `${entry.path} -> ${entry.realPath}` : `${entry.path} -> ${entry.realPath} (path only)`;
	});
	return `entry=${spelled.join(", ")}`;
}

function networkLabel(grant: ReturnType<typeof networkGrant>): string {
	return grant.network
		? `network=true (${grant.networkSource === "trust" ? "trust record" : "user declaration"})`
		: "network=false";
}

export interface McpCommandOutput {
	code: number;
	text: string;
	data: unknown;
}

/** Shared operator outcomes for the CLI and slash command. */
export function mcpCommandOutput(
	argv: ReadonlyArray<string>,
	options: McpTrustOptions = { cwd: process.cwd() },
): McpCommandOutput {
	const fail = (code: number, message: string): McpCommandOutput => {
		const text = message.replace(/[\r\n]+/gu, " ");
		return { code, text, data: { ok: false, message: text } };
	};
	try {
		const [command, id, ...rest] = argv;
		if (command === "list" && id === undefined) {
			const resolved = resolveMcpServers(options);
			const result = {
				...resolved,
				servers: resolved.servers.map((server) => {
					const catalog =
						server.trust.status !== "trusted"
							? null
							: readMcpServerCatalog({
									projectRoot: canonicalProjectRoot(options.cwd),
									scope: server.scope,
									declarationPath: server.path,
									serverId: server.id,
									digest: server.digest,
									cwd: server.cwd,
								});
					const entry = boundEntry(server);
					return {
						...server,
						...(entry !== null ? { entry } : {}),
						...networkGrant(server),
						tools:
							catalog?.tools.flatMap((tool) => {
								const capability = mcpToolName(server.id, tool.name);
								return capability === null
									? []
									: [
											{
												name: tool.name,
												capability,
												actionClass: mcpToolActionClass(server, { ...tool, annotations: tool.annotations ?? null }),
											},
										];
							}) ?? [],
						catalog: catalog === null ? "missing" : "cached",
					};
				}),
			};
			const lines = result.servers.map(
				(server) =>
					`${server.id} scope=${server.scope}${server.plugin !== undefined ? ` plugin=${server.plugin.id}` : ""} command=${JSON.stringify([server.command, ...server.args])} cwd=${JSON.stringify(server.cwd)} trust=${server.trust.status}${"reason" in server.trust ? ` (${server.trust.reason})` : ""} actionClass=${server.trust.actionClass}${server.scope === "project" ? ` ${entryLabel(server.entryScripts ?? [])}` : ""} ${networkLabel(server)}`,
			);
			for (const server of result.servers) {
				for (const tool of server.tools) lines.push(`  ${tool.capability} actionClass=${tool.actionClass}`);
				if (server.trust.status === "trusted" && server.catalog === "missing")
					lines.push("  no recorded tool catalog; use clio-coder mcp list --refresh");
			}
			lines.push(
				...result.diagnostics.map(
					(entry) => `${entry.severity === "warning" ? "warning: " : ""}${entry.path}: ${entry.message}`,
				),
				...result.trustDiagnostics,
			);
			const failing = result.diagnostics.filter((entry) => entry.severity !== "warning");
			return {
				code: failing.length || result.trustDiagnostics.length ? 1 : 0,
				text: lines.join("\n") || "mcp: none",
				data: result,
			};
		}
		if ((command !== "trust" && command !== "untrust") || !id)
			return fail(
				2,
				"usage: clio-coder mcp list | test <id> [--call <tool> [--args <json>]]... | trust <id> [--action-class <class>] [--network] | untrust <id>",
			);
		let actionClass: McpTrustActionClass | undefined;
		let network = false;
		const flags = [...rest];
		if (flags.length && command !== "trust") return fail(2, "--action-class and --network apply only to trust");
		while (flags.length) {
			const flag = flags.shift();
			if (flag === "--network" && !network) {
				network = true;
				continue;
			}
			const value = flags.shift();
			if (
				flag !== "--action-class" ||
				actionClass !== undefined ||
				!MCP_TRUST_ACTION_CLASSES.includes(value as McpTrustActionClass)
			)
				return fail(
					2,
					`trust takes --action-class <${MCP_TRUST_ACTION_CLASSES.join("|")}> and --network, each at most once`,
				);
			actionClass = value as McpTrustActionClass;
		}
		if (command === "trust") {
			const result = trustMcpServer({ ...options, id, ...(actionClass ? { actionClass } : {}), network });
			if (!result.ok) return fail(1, result.message);
			const { entryScripts, ...data } = result;
			return { code: 0, text: `mcp: trusted ${id} ${entryLabel(entryScripts)} ${JSON.stringify(result.record)}`, data };
		}
		const resolved = resolveMcpServers(options);
		const server = resolved.servers.find((entry) => entry.id === id);
		if (!server) return fail(1, `no declared MCP server with id '${id}'`);
		if (server.scope === "user")
			return fail(1, `server '${id}' is a user-scope declaration; it is trusted by authorship`);
		const result = untrustMcpServer({ ...options, id });
		return result.ok
			? { code: 0, text: `mcp: untrusted ${id} (record ${result.removed ? "removed" : "already absent"})`, data: result }
			: fail(1, result.message);
	} catch (error) {
		return fail(1, error instanceof Error ? error.message : String(error));
	}
}

interface McpTestCall {
	tool: string;
	args: Record<string, unknown>;
}

/** `test <id> [--call <tool> [--args <json>]]...`, or the usage error that refuses it. */
function parseMcpTestArgs(argv: ReadonlyArray<string>): { id: string; calls: McpTestCall[] } | string {
	const [, id, ...rest] = argv;
	if (id === undefined || id.startsWith("--"))
		return "usage: clio-coder mcp test <id> [--call <tool> [--args <json>]]...";
	const calls: McpTestCall[] = [];
	for (let index = 0; index < rest.length; index += 1) {
		const flag = rest[index];
		const value = rest[index + 1];
		if (flag === "--call" && value !== undefined && !value.startsWith("--")) {
			calls.push({ tool: value, args: {} });
			index += 1;
			continue;
		}
		const last = calls.at(-1);
		if (flag === "--args" && value !== undefined && last !== undefined) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(value);
			} catch {
				return `--args for ${last.tool} must be a JSON object`;
			}
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
				return `--args for ${last.tool} must be a JSON object`;
			last.args = parsed as Record<string, unknown>;
			index += 1;
			continue;
		}
		return "usage: clio-coder mcp test <id> [--call <tool> [--args <json>]]...; --args follows its --call";
	}
	return { id, calls };
}

/** One `mcp test` call as the registry settled it. */
function mcpTestCallRecord(
	id: string,
	tool: string,
	capability: string,
	verdict: RegistryVerdict,
): Record<string, unknown> {
	if (verdict.kind === "not_visible") return { tool, isError: true, refused: true, text: verdict.reason };
	if (verdict.kind === "blocked") {
		const denial = verdict.denial;
		return {
			tool,
			isError: true,
			refused: true,
			text: verdict.reason,
			...(denial !== undefined ? { denial } : {}),
			...(denial?.layer === "mcp_server_policy"
				? {
						serverPolicyRefusal: {
							code: denial.code,
							message: verdict.decision.classification.reasons[0] ?? verdict.reason,
						},
					}
				: {}),
		};
	}
	const result = verdict.result;
	const details = result.details ?? {};
	// Only a result the server answered carries its id; an error without it is
	// a request that never got an answer.
	if (result.kind === "error" && details.server !== id) return { tool, error: result.message };
	const structured = details.structuredContent;
	return {
		tool,
		isError: result.kind === "error",
		text: result.kind === "error" ? result.message.replace(`${capability}: `, "") : result.output,
		...(structured !== undefined ? { structuredContent: structured } : {}),
	};
}

/**
 * Launch one declared server the way the gateway does and report what Clio
 * sees: the negotiated protocol, the server's identity, its tools with the
 * action class Clio enforces, and the raw result of each requested call. The
 * launch goes through the gateway's own capability source, so trust gating,
 * cwd containment, the safe tool environment and teardown are the session's,
 * not a second copy of them.
 */
async function mcpTestOutput(id: string, calls: ReadonlyArray<McpTestCall>): Promise<McpCommandOutput> {
	const fail = (message: string, data: Record<string, unknown> = {}): McpCommandOutput => ({
		code: 1,
		text: `mcp test ${id}: ${message}`,
		data: { ok: false, message, ...data },
	});
	const cwd = process.cwd();
	const server = resolveMcpServers({ cwd }).servers.find((entry) => entry.id === id);
	if (server === undefined) return fail(`no declared MCP server with id '${id}'`);
	const trust = server.trust;
	const described = { id: server.id, scope: server.scope, trust, ...networkGrant(server) };
	if (trust.status !== "trusted")
		return fail(`server '${id}' is ${trust.status}; it is never launched until trusted: clio-coder mcp trust ${id}`, {
			server: described,
		});
	const [{ createMcpCapabilitySource }, { createRegistry }, { createWorkerSafety }, { createMcpStdioClient }] =
		await Promise.all([
			import("../tools/gateway/mcp-capabilities.js"),
			import("../tools/registry.js"),
			import("../engine/worker-tools.js"),
			import("../domains/gateway/mcp/index.js"),
		]);
	let client: McpClient | null = null;
	const registry = createRegistry({ safety: createWorkerSafety({ cwd }) });
	const source = createMcpCapabilitySource({
		cwd,
		registry,
		clientFactory: (spec, options) => {
			const created = createMcpStdioClient(spec, options);
			if (spec.id === id) client = created;
			return created;
		},
	});
	try {
		const refreshed = await source.refresh(id);
		const live = client as McpClient | null;
		const info = live?.serverInfo() ?? null;
		if (live === null || info === null || refreshed.reason !== undefined)
			return fail(refreshed.reason ?? "the server did not finish initializing", { server: described });
		const owned = source.catalog().entries.filter((entry) => source.ownerIdOf(entry.name) === id);
		const tools = owned.map((entry) => ({
			name: entry.name.slice(`mcp_${id}__`.length),
			capability: entry.name,
			actionClass: entry.actionClass,
			...source.discoveryNote(entry.name),
		}));
		// Each call goes through the registry the server's tools were registered
		// in, so `mcp test` admits exactly what a session admits: action class,
		// confirmation rule, execute projection, information flow and repeat
		// refusal. Arguments are not checked against the tool's input schema;
		// the server validates them. No park listener exists here, so an ask is
		// refused the way a headless run refuses it instead of waiting.
		const results: Array<Record<string, unknown>> = [];
		for (const call of calls) {
			const capability = mcpToolName(id, call.tool);
			if (capability === null || source.ownerIdOf(capability) !== id || registry.get(capability) === undefined) {
				results.push({
					tool: call.tool,
					isError: true,
					refused: true,
					text: `server '${id}' lists no tool named '${call.tool}'; nothing was sent`,
				});
				continue;
			}
			let verdict: RegistryVerdict;
			try {
				verdict = await registry.invoke({ tool: capability, args: call.args });
			} catch (error) {
				results.push({ tool: call.tool, error: error instanceof Error ? error.message : String(error) });
				break;
			}
			const record = mcpTestCallRecord(id, call.tool, capability, verdict);
			results.push(record);
			// The request got no answer (timeout, a dead server), so later calls
			// would only report the same transport failure. A JSON-RPC error answer
			// is that call's own error and the run goes on.
			if ("error" in record) break;
		}
		const listing = refreshed.listing;
		const data = {
			ok: results.every((result) => result.isError === false),
			server: described,
			protocolVersion: info.protocolVersion,
			serverInfo: info.serverInfo,
			tools,
			truncated: listing?.truncated === true,
			calls: results,
		};
		const lines = [
			`${id}: protocol ${info.protocolVersion}, server ${info.serverInfo?.name ?? "?"} ${info.serverInfo?.version ?? "?"}, ${tools.length} tools`,
			...tools.map((tool) => `  ${tool.capability} actionClass=${tool.actionClass}`),
			...results.map(
				(result) =>
					`call ${String(result.tool)}: ${"error" in result ? "failed" : result.refused === true ? "refused" : result.isError === true ? "error" : "ok"} ${String(result.error ?? result.text).slice(0, 200)}`,
			),
		];
		return { code: data.ok ? 0 : 1, text: lines.join("\n"), data };
	} catch (error) {
		return fail(error instanceof Error ? error.message : String(error), { server: described });
	} finally {
		await source.close();
	}
}

export async function runMcpCommand(argv: ReadonlyArray<string>): Promise<number> {
	if (argv.includes("--help") || argv.includes("-h")) {
		process.stdout.write(HELP);
		return 0;
	}
	const json = argv.includes("--json");
	if (argv[0] === "test") {
		const parsed = parseMcpTestArgs(argv.filter((arg) => arg !== "--json"));
		const result =
			typeof parsed === "string"
				? { code: 2, text: parsed, data: { ok: false, message: parsed } }
				: await mcpTestOutput(parsed.id, parsed.calls);
		if (json) process.stdout.write(`${JSON.stringify(result.data, null, 2)}\n`);
		else if (result.code !== 0 && !("protocolVersion" in (result.data as object))) printError(result.text);
		else process.stdout.write(`${result.text}\n`);
		return result.code;
	}
	let refreshFailure: string | null = null;
	const refresh =
		argv[0] === "list" &&
		argv.includes("--refresh") &&
		argv.slice(1).every((arg) => arg === "--refresh" || arg === "--json");
	if (refresh) {
		const [{ createMcpCapabilitySource }, { createRegistry }, { createWorkerSafety }] = await Promise.all([
			import("../tools/gateway/mcp-capabilities.js"),
			import("../tools/registry.js"),
			import("../engine/worker-tools.js"),
		]);
		const registry = createRegistry({ safety: createWorkerSafety({ cwd: process.cwd() }) });
		const source = createMcpCapabilitySource({ cwd: process.cwd(), registry });
		try {
			const listing = await source.list();
			refreshFailure =
				listing.servers
					.filter((server) => server.status === "failed")
					.map((server) => `${server.id}: ${server.reason}`)
					.join("; ") || null;
		} finally {
			await source.close();
		}
	}
	const result = mcpCommandOutput(argv.filter((arg) => arg !== "--json" && (!refresh || arg !== "--refresh")));
	if (refreshFailure !== null) {
		result.code = 1;
		result.text += `\n${refreshFailure}`;
		(result.data as { trustDiagnostics: string[] }).trustDiagnostics.push(refreshFailure);
	}
	if (json) process.stdout.write(`${JSON.stringify(result.data, null, 2)}\n`);
	else if (result.code && argv[0] !== "list") printError(result.text);
	else process.stdout.write(`${result.text}\n`);
	return result.code;
}
