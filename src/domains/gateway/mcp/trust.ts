/**
 * Explicit trust for project-declared MCP servers. A repository can ship
 * `.clio-coder/mcp.yaml`, and cloning a repository must not launch anything,
 * so a project server runs only once the operator records a trust decision
 * for that exact declaration. The record binds the project root, the server
 * id, and the declaration digest: change the command, arguments, environment,
 * cwd, or timeout and the record is stale until the operator re-trusts it.
 * User-scope declarations are trusted by authorship; they carry no record.
 */

import { realpathSync } from "node:fs";
import path from "node:path";
import { safeResourceWrite } from "../../../core/safe-resource-write.js";
import { clioConfigDir } from "../../../core/xdg.js";
import {
	loadMcpServerConfig,
	type McpConfigDiagnostic,
	type McpServerDeclaration,
	readBoundedFileText,
} from "./config.js";

export const MCP_TRUST_FILENAME = "mcp-trust.json";
export const MCP_TRUST_VERSION = 1;

/** Bounds on the trust file, read on every resolve; a file past either is unusable until repaired. */
export const MCP_TRUST_CAPS = Object.freeze({
	fileBytes: 1024 * 1024,
	records: 256,
});

export type McpTrustActionClass = "read" | "execute" | "unknown";
export const MCP_TRUST_ACTION_CLASSES: ReadonlyArray<McpTrustActionClass> = ["read", "execute", "unknown"];

export interface McpTrustRecord {
	/** Canonical (realpath) project root the record applies to. */
	projectRoot: string;
	id: string;
	digest: string;
	/** The action class the gateway gives this server's tools. */
	actionClass: McpTrustActionClass;
	trustedAt: string;
}

export interface McpTrustState {
	version: typeof MCP_TRUST_VERSION;
	records: McpTrustRecord[];
}

export type McpTrustStatus =
	| { status: "trusted"; actionClass: McpTrustActionClass }
	| { status: "untrusted"; actionClass: "unknown"; reason: string }
	| { status: "stale"; actionClass: "unknown"; reason: string };

export interface ResolvedMcpServer extends McpServerDeclaration {
	trust: McpTrustStatus;
}

export interface McpTrustOptions {
	cwd: string;
	/** Override for the user config directory; defaults to clioConfigDir(). */
	configDir?: string;
}

export interface McpTrustReadResult {
	state: McpTrustState;
	/** Non-empty when the file exists but could not be used; the state is then empty. */
	diagnostics: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isActionClass(value: unknown): value is McpTrustActionClass {
	return typeof value === "string" && (MCP_TRUST_ACTION_CLASSES as ReadonlyArray<string>).includes(value);
}

export function mcpTrustPath(configDir?: string): string {
	return path.join(configDir ?? clioConfigDir(), MCP_TRUST_FILENAME);
}

function canonicalProjectRoot(cwd: string): string {
	const resolved = path.resolve(cwd);
	try {
		return realpathSync(resolved);
	} catch {
		return resolved;
	}
}

function parseTrustState(text: string): McpTrustState | Error {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text) as unknown;
	} catch (error) {
		return new Error(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!isRecord(parsed) || parsed.version !== MCP_TRUST_VERSION) {
		return new Error(`trust state must be a version ${MCP_TRUST_VERSION} object`);
	}
	if (!Array.isArray(parsed.records)) return new Error("trust state records must be an array");
	if (parsed.records.length > MCP_TRUST_CAPS.records) {
		return new Error(`trust state exceeds the ${MCP_TRUST_CAPS.records}-record cap`);
	}
	const records: McpTrustRecord[] = [];
	for (const [index, raw] of parsed.records.entries()) {
		if (!isRecord(raw)) return new Error(`records[${index}] must be an object`);
		for (const field of ["projectRoot", "id", "digest", "trustedAt"] as const) {
			if (typeof raw[field] !== "string" || raw[field].length === 0) {
				return new Error(`records[${index}].${field} must be a non-empty string`);
			}
		}
		if (!isActionClass(raw.actionClass)) {
			return new Error(`records[${index}].actionClass must be one of ${MCP_TRUST_ACTION_CLASSES.join(", ")}`);
		}
		records.push({
			projectRoot: raw.projectRoot as string,
			id: raw.id as string,
			digest: raw.digest as string,
			actionClass: raw.actionClass,
			trustedAt: raw.trustedAt as string,
		});
	}
	return { version: MCP_TRUST_VERSION, records };
}

/**
 * Read the trust file through a bounded read. A missing file is an empty
 * state; an oversized, over-populated, or corrupt one is empty with a
 * diagnostic, and nothing here ever rewrites it.
 */
export function readMcpTrustState(configDir?: string): McpTrustReadResult {
	const filePath = mcpTrustPath(configDir);
	const empty: McpTrustState = { version: MCP_TRUST_VERSION, records: [] };
	const read = readBoundedFileText(filePath, MCP_TRUST_CAPS.fileBytes);
	if (!read.ok) {
		if (read.reason === "missing") return { state: empty, diagnostics: [] };
		return { state: empty, diagnostics: [`${filePath}: ${read.message}`] };
	}
	const parsed = parseTrustState(read.text);
	if (parsed instanceof Error) return { state: empty, diagnostics: [`${filePath}: ${parsed.message}`] };
	return { state: parsed, diagnostics: [] };
}

/** Persist the state, or name why it would not be readable again under the caps. */
function writeTrustState(records: ReadonlyArray<McpTrustRecord>, configDir?: string): string | null {
	if (records.length > MCP_TRUST_CAPS.records) {
		return `trust state would exceed the ${MCP_TRUST_CAPS.records}-record cap; untrust servers you no longer use first`;
	}
	const sorted = [...records].sort(
		(left, right) => left.projectRoot.localeCompare(right.projectRoot) || left.id.localeCompare(right.id),
	);
	const text = `${JSON.stringify({ version: MCP_TRUST_VERSION, records: sorted }, null, 2)}\n`;
	if (Buffer.byteLength(text, "utf8") > MCP_TRUST_CAPS.fileBytes) {
		return `trust state would exceed the ${MCP_TRUST_CAPS.fileBytes}-byte cap; untrust servers you no longer use first`;
	}
	safeResourceWrite(mcpTrustPath(configDir), text, { mode: 0o600 });
	return null;
}

function trustStatusFor(server: McpServerDeclaration, projectRoot: string, state: McpTrustState): McpTrustStatus {
	if (server.scope === "user") return { status: "trusted", actionClass: "unknown" };
	const record = state.records.find((entry) => entry.projectRoot === projectRoot && entry.id === server.id);
	if (record === undefined) {
		return {
			status: "untrusted",
			actionClass: "unknown",
			reason: `project-scope server '${server.id}' requires explicit trust: clio-coder mcp trust ${server.id}`,
		};
	}
	if (record.digest !== server.digest) {
		return {
			status: "stale",
			actionClass: "unknown",
			reason: `declaration of '${server.id}' changed (command, args, env, cwd, or timeout) since it was trusted; review it and run clio-coder mcp trust ${server.id} again`,
		};
	}
	return { status: "trusted", actionClass: record.actionClass };
}

export interface ResolvedMcpServers {
	servers: ResolvedMcpServer[];
	diagnostics: McpConfigDiagnostic[];
	/** Trust-file problems, separate from config diagnostics. */
	trustDiagnostics: string[];
}

/** Every declared server with its trust status; the gateway launches only `trusted` entries. */
export function resolveMcpServers(options: McpTrustOptions): ResolvedMcpServers {
	const loaded = loadMcpServerConfig(options);
	const trust = readMcpTrustState(options.configDir);
	const projectRoot = canonicalProjectRoot(options.cwd);
	return {
		servers: loaded.servers.map((server) => ({ ...server, trust: trustStatusFor(server, projectRoot, trust.state) })),
		diagnostics: loaded.diagnostics,
		trustDiagnostics: trust.diagnostics,
	};
}

export interface TrustMcpServerOptions extends McpTrustOptions {
	id: string;
	actionClass?: McpTrustActionClass;
	now?: () => Date;
}

export type TrustMcpServerResult = { ok: true; record: McpTrustRecord } | { ok: false; message: string };

/** Record trust for one project-declared server at its current digest. */
export function trustMcpServer(options: TrustMcpServerOptions): TrustMcpServerResult {
	const actionClass = options.actionClass ?? "unknown";
	if (!isActionClass(actionClass)) {
		return { ok: false, message: `actionClass must be one of ${MCP_TRUST_ACTION_CLASSES.join(", ")}` };
	}
	const loaded = loadMcpServerConfig(options);
	const server = loaded.servers.find((entry) => entry.id === options.id);
	if (server === undefined) {
		const problems = loaded.diagnostics.map((entry) => `${entry.path}: ${entry.message}`);
		return {
			ok: false,
			message:
				`no declared MCP server with id '${options.id}'` +
				(problems.length > 0 ? `; config diagnostics: ${problems.join("; ")}` : ""),
		};
	}
	if (server.scope !== "project") {
		return { ok: false, message: `server '${options.id}' is a user-scope declaration; it is trusted by authorship` };
	}
	const trust = readMcpTrustState(options.configDir);
	if (trust.diagnostics.length > 0) {
		return { ok: false, message: `trust state is unusable; repair or remove it first: ${trust.diagnostics.join("; ")}` };
	}
	const projectRoot = canonicalProjectRoot(options.cwd);
	const record: McpTrustRecord = {
		projectRoot,
		id: server.id,
		digest: server.digest,
		actionClass,
		trustedAt: (options.now?.() ?? new Date()).toISOString(),
	};
	const records = trust.state.records.filter((entry) => !(entry.projectRoot === projectRoot && entry.id === server.id));
	records.push(record);
	const refused = writeTrustState(records, options.configDir);
	if (refused !== null) return { ok: false, message: refused };
	return { ok: true, record };
}

export type UntrustMcpServerResult = { ok: true; removed: boolean } | { ok: false; message: string };

/** Remove the trust record for one server in this project, whether or not it is still declared. */
export function untrustMcpServer(options: McpTrustOptions & { id: string }): UntrustMcpServerResult {
	const trust = readMcpTrustState(options.configDir);
	if (trust.diagnostics.length > 0) {
		return { ok: false, message: `trust state is unusable; repair or remove it first: ${trust.diagnostics.join("; ")}` };
	}
	const projectRoot = canonicalProjectRoot(options.cwd);
	const records = trust.state.records.filter((entry) => !(entry.projectRoot === projectRoot && entry.id === options.id));
	const removed = records.length !== trust.state.records.length;
	if (removed) {
		const refused = writeTrustState(records, options.configDir);
		if (refused !== null) return { ok: false, message: refused };
	}
	return { ok: true, removed };
}
