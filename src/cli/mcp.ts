import {
	MCP_TRUST_ACTION_CLASSES,
	type McpTrustActionClass,
	type McpTrustOptions,
	resolveMcpServers,
	trustMcpServer,
	untrustMcpServer,
} from "../domains/gateway/mcp/index.js";
import { printError } from "./shared.js";

const HELP = `clio-coder mcp <command>

Commands:
  clio-coder mcp list [--json]
  clio-coder mcp trust <id> [--action-class <class>] [--json]
  clio-coder mcp untrust <id> [--json]

Action classes: ${MCP_TRUST_ACTION_CLASSES.join(", ")}

JSON responses (--json):
  list: {servers: [...], diagnostics: [...], trustDiagnostics: [...]}
    Each server includes its declaration and trust {status, actionClass, reason?}.
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
			const result = resolveMcpServers(options);
			const lines = result.servers.map(
				(server) =>
					`${server.id} scope=${server.scope} command=${JSON.stringify([server.command, ...server.args])} cwd=${JSON.stringify(server.cwd)} trust=${server.trust.status}${"reason" in server.trust ? ` (${server.trust.reason})` : ""} actionClass=${server.trust.actionClass}`,
			);
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

export function runMcpCommand(argv: ReadonlyArray<string>): number {
	if (argv.includes("--help") || argv.includes("-h")) {
		process.stdout.write(HELP);
		return 0;
	}
	const json = argv.includes("--json");
	const result = mcpCommandOutput(argv.filter((arg) => arg !== "--json"));
	if (json) process.stdout.write(`${JSON.stringify(result.data, null, 2)}\n`);
	else if (result.code && argv[0] !== "list") printError(result.text);
	else process.stdout.write(`${result.text}\n`);
	return result.code;
}
