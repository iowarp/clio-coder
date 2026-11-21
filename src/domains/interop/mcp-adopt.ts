/**
 * Another agent's MCP server declaration mapped onto Clio's strict `mcp.yaml`
 * (domains/gateway/mcp/config.ts). A server whose launch cannot be stated
 * exactly in that schema (a remote transport, `${VAR}` expansion, a shell
 * string, an env pass-through list) is never guessed at: the plan skips it
 * and says why. A user-scope source lands in the user's `<config>/mcp.yaml`;
 * a project source lands in the project's `.clio-coder/mcp.yaml`, which keeps
 * its own trust record before anything in it launches.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { parseDocument, stringify as stringifyYaml } from "yaml";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import { clioConfigDir } from "../../core/xdg.js";
import {
	MCP_CONFIG_CAPS,
	MCP_CONFIG_VERSION,
	type McpConfigLoadResult,
	mcpConfigPaths,
	parseMcpConfigText,
} from "../gateway/mcp/index.js";
import { inventoryText } from "./inventory.js";
import type { InteropInventoryItem } from "./types.js";

/** One server in the shape Clio's `mcp.yaml` declares it. Env values stay host-side; plans show keys only. */
export interface AdoptedMcpServer {
	id: string;
	command: string;
	args: string[];
	env: Record<string, string>;
	cwd?: string;
	timeoutMs?: number;
}

export type McpAdoptionMapping =
	| { ok: true; server: AdoptedMcpServer; destination: string; digest: string; omittedFields: string[] }
	| { ok: false; reason: string };

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function strings(value: unknown): string[] | null {
	if (value === undefined) return [];
	return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : null;
}

/** The raw declaration of `item.name` in its source file, re-read on every call. */
function sourceDeclaration(item: InteropInventoryItem): Record<string, unknown> | null {
	const text = inventoryText(item.path);
	if (item.path.endsWith(".toml")) {
		const data = parseToml(text) as Record<string, unknown>;
		const servers = data.mcp_servers;
		const value = record(servers) ? servers[item.name] : undefined;
		return record(value) ? value : null;
	}
	const data: unknown = JSON.parse(text);
	if (!record(data)) return null;
	for (const key of ["mcpServers", "mcp"]) {
		const servers = data[key];
		const value = record(servers) ? servers[item.name] : undefined;
		if (record(value)) return value;
	}
	return null;
}

/** A Clio server id from a foreign name: lowercase, `[a-z0-9_-]`, at most the schema's cap. */
function serverId(name: string): string {
	const id = name
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^[^a-z0-9]+/, "")
		.slice(0, MCP_CONFIG_CAPS.idChars)
		.replace(/-+$/, "");
	return id.length > 0 ? id : "server";
}

/** Fields each host may set that change nothing about how Clio launches the server. */
const IGNORED_FIELDS = new Set([
	"type",
	"command",
	"args",
	"env",
	"environment",
	"cwd",
	"enabled",
	"tool_timeout_sec",
	"startup_timeout_sec",
	"startup_timeout_ms",
]);

function mapDeclaration(raw: Record<string, unknown>, name: string): AdoptedMcpServer | string {
	if (raw.enabled === false) return "disabled in the source configuration";
	const type = raw.type;
	if (typeof raw.url === "string" || (type !== undefined && type !== "stdio" && type !== "local"))
		return `uses the ${typeof type === "string" ? type : "remote"} transport; CLIO Coder runs stdio servers only`;
	if (raw.env_vars !== undefined)
		return "passes host environment variables through by name (env_vars), which CLIO Coder's mcp.yaml cannot state";
	// OpenCode's local servers spell argv as one `command` array.
	const argv = Array.isArray(raw.command) ? strings(raw.command) : null;
	const command = argv ? argv[0] : raw.command;
	const args = argv ? argv.slice(1) : strings(raw.args);
	if (typeof command !== "string" || command.length === 0) return "has no command";
	if (args === null) return "args is not a list of strings";
	const envSource = raw.env ?? raw.environment;
	const env: Record<string, string> = {};
	if (envSource !== undefined) {
		if (!record(envSource)) return "env is not a mapping";
		for (const [key, value] of Object.entries(envSource)) {
			if (typeof value !== "string") return `env ${key} is not a string`;
			env[key] = value;
		}
	}
	const expanded = [command, ...args, ...Object.values(env)].some((value) => /\$\{[^}]*\}/.test(value));
	if (expanded)
		return "expands environment variables in its values, which CLIO Coder's mcp.yaml does not do; declare the literal values by hand";
	const server: AdoptedMcpServer = { id: serverId(name), command, args, env };
	if (typeof raw.cwd === "string" && raw.cwd.length > 0) server.cwd = raw.cwd;
	if (typeof raw.tool_timeout_sec === "number" && raw.tool_timeout_sec > 0)
		server.timeoutMs = Math.min(MCP_CONFIG_CAPS.timeoutMs, Math.round(raw.tool_timeout_sec * 1000));
	return server;
}

function serverNode(server: AdoptedMcpServer): Record<string, unknown> {
	return {
		id: server.id,
		command: server.command,
		...(server.args.length > 0 ? { args: server.args } : {}),
		...(Object.keys(server.env).length > 0 ? { env: server.env } : {}),
		...(server.cwd !== undefined ? { cwd: server.cwd } : {}),
		...(server.timeoutMs !== undefined ? { timeoutMs: server.timeoutMs } : {}),
	};
}

function serverDigest(server: AdoptedMcpServer): string {
	const canonical = [
		server.id,
		server.command,
		server.args,
		Object.entries(server.env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
		server.cwd ?? null,
		server.timeoutMs ?? null,
	];
	return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** The Clio config file a source of this scope adopts into. */
function destinationOf(scope: "user" | "project", cwd: string): { path: string; root: string } {
	const paths = mcpConfigPaths({ cwd, configDir: clioConfigDir() });
	return scope === "user"
		? { path: paths.user, root: path.dirname(paths.user) }
		: { path: paths.project, root: path.dirname(path.dirname(paths.project)) };
}

function strictCheck(
	text: string,
	scope: "user" | "project",
	destination: { path: string; root: string },
): McpConfigLoadResult {
	return parseMcpConfigText(text, { scope, path: destination.path, root: destination.root });
}

function errorsOf(result: McpConfigLoadResult): string[] {
	return result.diagnostics.filter((d) => d.severity !== "warning").map((d) => d.message);
}

/** Map one inventory MCP item, validated through Clio's own config schema. */
export function mapForeignMcpServer(item: InteropInventoryItem, cwd: string): McpAdoptionMapping {
	let raw: Record<string, unknown> | null;
	try {
		raw = sourceDeclaration(item);
	} catch (error) {
		return { ok: false, reason: `Cannot read ${item.path}: ${error instanceof Error ? error.message : String(error)}` };
	}
	if (raw === null) return { ok: false, reason: `Not found in ${item.path}.` };
	const mapped = mapDeclaration(raw, item.name);
	if (typeof mapped === "string") return { ok: false, reason: `Not adoptable: the server ${mapped}.` };
	const destination = destinationOf(item.scope, cwd);
	const alone = strictCheck(
		JSON.stringify({ version: MCP_CONFIG_VERSION, servers: [serverNode(mapped)] }),
		item.scope,
		destination,
	);
	const problems = errorsOf(alone);
	if (problems.length > 0)
		return { ok: false, reason: `Not adoptable under CLIO Coder's mcp.yaml: ${problems.join("; ")}.` };
	return {
		ok: true,
		server: mapped,
		destination: destination.path,
		digest: serverDigest(mapped),
		omittedFields: Object.keys(raw).filter((key) => !IGNORED_FIELDS.has(key)),
	};
}

/** Why the destination already settles this server, or null when it can be added. */
export function mcpDestinationConflict(server: AdoptedMcpServer, destination: string): string | null {
	if (!existsSync(destination)) return null;
	let text: string;
	try {
		text = inventoryText(destination);
	} catch (error) {
		return `Cannot read ${destination}: ${error instanceof Error ? error.message : String(error)}`;
	}
	const document = parseDocument(text);
	const parsed: unknown = document.errors.length > 0 ? null : document.toJS();
	const servers = record(parsed) && Array.isArray(parsed.servers) ? parsed.servers : null;
	if (servers === null) return `${destination} is not a valid CLIO Coder MCP config; fix it before adopting servers.`;
	const existing = servers.find((entry) => record(entry) && entry.id === server.id);
	if (!record(existing)) return null;
	const same = JSON.stringify(existing) === JSON.stringify(serverNode(server));
	return same
		? "Already declared: same server in the CLIO Coder config."
		: `Server id collision: ${server.id} is already declared in ${destination}; existing content will not be replaced.`;
}

/** Append one reviewed server to its destination, re-checking the source and the merged file. */
export function applyMcpAdoption(
	item: InteropInventoryItem,
	cwd: string,
	reviewedDigest: string,
): { ok: true; destination: string; id: string } | { ok: false; reason: string } {
	const current = mapForeignMcpServer(item, cwd);
	if (!current.ok) return current;
	if (current.digest !== reviewedDigest)
		return { ok: false, reason: "Source changed after review; inspect a new plan." };
	const conflict = mcpDestinationConflict(current.server, current.destination);
	if (conflict !== null) return { ok: false, reason: conflict };
	let text: string;
	if (existsSync(current.destination)) {
		// Edited as a document so the operator's comments and order survive.
		const document = parseDocument(inventoryText(current.destination));
		document.addIn(["servers"], document.createNode(serverNode(current.server)));
		text = document.toString();
	} else text = stringifyYaml({ version: MCP_CONFIG_VERSION, servers: [serverNode(current.server)] });
	const destination = destinationOf(item.scope, cwd);
	const problems = errorsOf(strictCheck(text, item.scope, destination));
	if (problems.length > 0) return { ok: false, reason: `Merged config would be invalid: ${problems.join("; ")}.` };
	// Env values can be credentials: the file is the operator's own and readable only by them.
	safeResourceWrite(current.destination, text, { mode: 0o600 });
	return { ok: true, destination: current.destination, id: current.server.id };
}
