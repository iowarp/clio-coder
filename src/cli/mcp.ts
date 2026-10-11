import { mcpToolName } from "../core/tool-names.js";
import { mcpToolActionClass } from "../domains/gateway/mcp/action-classes.js";
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
import { printError } from "./shared.js";

const HELP = `clio-coder mcp <command>

Commands:
  clio-coder mcp list [--refresh] [--json]
  clio-coder mcp trust <id> [--action-class <class>] [--json]
  clio-coder mcp untrust <id> [--json]

Action classes: ${MCP_TRUST_ACTION_CLASSES.join(", ")}

JSON responses (--json):
  list: {servers: [...], diagnostics: [...], trustDiagnostics: [...]}
    Each server includes its declaration, trust {status, actionClass, reason?},
    and cached tools with per-tool actionClass. --refresh lists trusted servers
    live and updates their catalogs; untrusted declarations are never launched.
  trust: {ok: true, record: {projectRoot, id, digest, actionClass, trustedAt}}
  untrust: {ok: true, removed: boolean}
  errors: {ok: false, message: string}
Exit codes: 0 success; 1 operational failure; 2 invalid usage.
List retains its response shape on failure and exits 1 when config or trust
 diagnostics are present. Mutation errors return the error shape with a
 one-line reason. --help prints this text even when --json is supplied.
`;

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
					return {
						...server,
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
					`${server.id} scope=${server.scope} command=${JSON.stringify([server.command, ...server.args])} cwd=${JSON.stringify(server.cwd)} trust=${server.trust.status}${"reason" in server.trust ? ` (${server.trust.reason})` : ""} actionClass=${server.trust.actionClass}`,
			);
			for (const server of result.servers) {
				for (const tool of server.tools) lines.push(`  ${tool.capability} actionClass=${tool.actionClass}`);
				if (server.trust.status === "trusted" && server.catalog === "missing")
					lines.push("  no recorded tool catalog; use clio-coder mcp list --refresh");
			}
			lines.push(...result.diagnostics.map((entry) => `${entry.path}: ${entry.message}`), ...result.trustDiagnostics);
			return {
				code: result.diagnostics.length || result.trustDiagnostics.length ? 1 : 0,
				text: lines.join("\n") || "mcp: none",
				data: result,
			};
		}
		if ((command !== "trust" && command !== "untrust") || !id)
			return fail(2, "usage: clio-coder mcp list | trust <id> [--action-class <class>] | untrust <id>");
		let actionClass: McpTrustActionClass | undefined;
		if (rest.length) {
			if (
				command !== "trust" ||
				rest.length !== 2 ||
				rest[0] !== "--action-class" ||
				!MCP_TRUST_ACTION_CLASSES.includes(rest[1] as McpTrustActionClass)
			)
				return fail(2, `--action-class must be one of ${MCP_TRUST_ACTION_CLASSES.join(", ")} and applies only to trust`);
			actionClass = rest[1] as McpTrustActionClass;
		}
		if (command === "trust") {
			const result = trustMcpServer({ ...options, id, ...(actionClass ? { actionClass } : {}) });
			return result.ok
				? { code: 0, text: `mcp: trusted ${id} ${JSON.stringify(result.record)}`, data: result }
				: fail(1, result.message);
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

export async function runMcpCommand(argv: ReadonlyArray<string>): Promise<number> {
	if (argv.includes("--help") || argv.includes("-h")) {
		process.stdout.write(HELP);
		return 0;
	}
	const json = argv.includes("--json");
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
