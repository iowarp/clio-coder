/**
 * Persisted tool catalogs for declared local MCP servers.
 *
 * A server's tool list is machine state, not operator policy: it costs a
 * process launch and a handshake to learn, and it is the same answer every
 * session until the declaration or the server changes. Keeping the last
 * successful listing on disk lets the gateway answer find and describe without
 * launching anything, which is the only way an unrestricted find can stay
 * honest about what a session offers without spawning every trusted server to
 * produce that answer.
 *
 * A catalog is a snapshot and nothing more. It confers no authority: trust is
 * resolved from the trust file on every session, never read back from here, and
 * a call still validates against the live listing. Nothing that runs a server
 * is written here either, so a readable cache file cannot reconstruct a launch.
 */

import { createHash } from "node:crypto";
import path from "node:path";
import { safeResourceWrite } from "../../../core/safe-resource-write.js";
import { clioCacheDir } from "../../../core/xdg.js";
import { MCP_TOOL_LIST_CAP, type McpToolDescriptor } from "./client.js";
import type { McpServerScope } from "./config.js";
import { readBoundedFileText } from "./config.js";

export const MCP_METADATA_CACHE_VERSION = 1;

/**
 * How long a catalog is used before a live listing has to produce it again.
 * A day matches `TARGET_MODEL_CACHE_TTL_MS`, which solves the same problem for
 * provider model lists, and keeps a server that quietly gained or lost tools
 * from staying wrong across a week of sessions.
 */
export const MCP_METADATA_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;

/** Public decode limits; a file past any of them is a miss, never a partial read. */
export const MCP_METADATA_CACHE_CAPS = Object.freeze({
	/** 500 tools at a generous 2 KiB of schema each, with headroom. */
	fileBytes: 2 * 1024 * 1024,
	tools: MCP_TOOL_LIST_CAP,
	toolNameBytes: 512,
	descriptionBytes: 8 * 1024,
	schemaBytes: 64 * 1024,
});

const CACHE_SUBDIRECTORY = "mcp-catalogs";

/**
 * What a catalog belongs to. `mcpServerDigest()` covers the declaration's own
 * fields but a project-scope `cwd` is repository-relative, so two checkouts of
 * one repository produce identical digests for different processes on disk.
 * Binding the canonical project root and the resolved execution directory as
 * well keeps those two checkouts from sharing a catalog.
 */
export interface McpCatalogIdentity {
	projectRoot: string;
	scope: McpServerScope;
	/** The config file that declares the server. */
	declarationPath: string;
	serverId: string;
	/** sha256 of the canonical declaration, from `mcpServerDigest()`. */
	digest: string;
	/** Absolute working directory the server would start in. */
	cwd: string;
}

/** One tool as the gateway needs it offline: enough to list and to describe, never to authorize. */
export interface McpCachedTool {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

export interface McpServerCatalog {
	version: typeof MCP_METADATA_CACHE_VERSION;
	projectRoot: string;
	scope: McpServerScope;
	declarationPath: string;
	serverId: string;
	digest: string;
	cwd: string;
	/**
	 * The listing that produced this catalog stopped at the client's tool or
	 * page cap, so the server offers more than is recorded here. Carried so a
	 * known-partial catalog never reads back as a complete one.
	 */
	truncated: boolean;
	observedAt: string;
	tools: McpCachedTool[];
}

export interface McpCatalogOptions {
	/** Override of the Clio cache directory. */
	cacheDir?: string;
	nowMs?: number;
	ttlMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The file name covers only the parts of the identity that say *which server in
 * which project*. The digest and cwd are verified from the file body instead,
 * so a changed declaration replaces its own catalog rather than stranding the
 * old one on disk forever.
 */
function catalogKey(identity: McpCatalogIdentity): string {
	const canonical = JSON.stringify([identity.projectRoot, identity.scope, identity.declarationPath, identity.serverId]);
	return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

/** One file per declared server, so two sessions refreshing different servers never overwrite each other. */
export function mcpCatalogPath(identity: McpCatalogIdentity, cacheDir?: string): string {
	return path.join(cacheDir ?? clioCacheDir(), CACHE_SUBDIRECTORY, `${catalogKey(identity)}.json`);
}

function decodeTool(value: unknown): McpCachedTool | null {
	if (!isRecord(value)) return null;
	const { name, description, inputSchema } = value;
	if (typeof name !== "string" || name.length === 0) return null;
	if (Buffer.byteLength(name, "utf8") > MCP_METADATA_CACHE_CAPS.toolNameBytes) return null;
	if (typeof description !== "string") return null;
	if (Buffer.byteLength(description, "utf8") > MCP_METADATA_CACHE_CAPS.descriptionBytes) return null;
	if (!isRecord(inputSchema)) return null;
	if (Buffer.byteLength(JSON.stringify(inputSchema), "utf8") > MCP_METADATA_CACHE_CAPS.schemaBytes) return null;
	return { name, description, inputSchema };
}

/** Decode a whole file or reject it. A single bad tool fails the catalog: half a listing is not a listing. */
function decodeCatalog(value: unknown): McpServerCatalog | null {
	if (!isRecord(value)) return null;
	if (value.version !== MCP_METADATA_CACHE_VERSION) return null;
	for (const field of ["projectRoot", "declarationPath", "serverId", "digest", "cwd", "observedAt"]) {
		const entry = value[field];
		if (typeof entry !== "string" || entry.length === 0) return null;
	}
	if (value.scope !== "user" && value.scope !== "project") return null;
	if (typeof value.truncated !== "boolean") return null;
	if (!Number.isFinite(Date.parse(value.observedAt as string))) return null;
	if (!Array.isArray(value.tools) || value.tools.length > MCP_METADATA_CACHE_CAPS.tools) return null;
	const tools: McpCachedTool[] = [];
	const seen = new Set<string>();
	for (const entry of value.tools) {
		const tool = decodeTool(entry);
		if (tool === null || seen.has(tool.name)) return null;
		seen.add(tool.name);
		tools.push(tool);
	}
	return {
		version: MCP_METADATA_CACHE_VERSION,
		projectRoot: value.projectRoot as string,
		scope: value.scope,
		declarationPath: value.declarationPath as string,
		serverId: value.serverId as string,
		digest: value.digest as string,
		cwd: value.cwd as string,
		truncated: value.truncated,
		observedAt: value.observedAt as string,
		tools,
	};
}

/**
 * The last recorded catalog for this exact declaration, or null.
 *
 * Malformed, oversized, version-mismatched, identity-mismatched, future-dated
 * and expired files are all the same answer: a miss. There is no degraded hit,
 * because every caller of a degraded hit would have to decide separately
 * whether to trust it.
 */
export function readMcpServerCatalog(
	identity: McpCatalogIdentity,
	options: McpCatalogOptions = {},
): McpServerCatalog | null {
	const read = readBoundedFileText(mcpCatalogPath(identity, options.cacheDir), MCP_METADATA_CACHE_CAPS.fileBytes);
	if (!read.ok) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(read.text) as unknown;
	} catch {
		return null;
	}
	const catalog = decodeCatalog(parsed);
	if (catalog === null) return null;
	if (
		catalog.projectRoot !== identity.projectRoot ||
		catalog.scope !== identity.scope ||
		catalog.declarationPath !== identity.declarationPath ||
		catalog.serverId !== identity.serverId ||
		catalog.digest !== identity.digest ||
		catalog.cwd !== identity.cwd
	) {
		return null;
	}
	const observedMs = Date.parse(catalog.observedAt);
	const nowMs = options.nowMs ?? Date.now();
	const ttlMs = options.ttlMs ?? MCP_METADATA_CACHE_TTL_MS;
	if (observedMs > nowMs || nowMs - observedMs >= ttlMs) return null;
	return catalog;
}

/**
 * Replace one server's catalog atomically. Returns false rather than throwing:
 * a cache that cannot be written must never fail the live tool listing that
 * produced it.
 */
export function writeMcpServerCatalog(
	identity: McpCatalogIdentity,
	listing: { tools: ReadonlyArray<McpToolDescriptor>; truncated: boolean },
	options: Pick<McpCatalogOptions, "cacheDir" | "nowMs"> = {},
): boolean {
	if (listing.tools.length > MCP_METADATA_CACHE_CAPS.tools) return false;
	const tools: McpCachedTool[] = [];
	for (const tool of listing.tools) {
		const encoded = decodeTool({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema });
		// A tool the decoder would reject on the way back in is dropped rather
		// than written, so a round trip is never the thing that invalidates a file.
		if (encoded !== null) tools.push(encoded);
	}
	const catalog: McpServerCatalog = {
		version: MCP_METADATA_CACHE_VERSION,
		projectRoot: identity.projectRoot,
		scope: identity.scope,
		declarationPath: identity.declarationPath,
		serverId: identity.serverId,
		digest: identity.digest,
		cwd: identity.cwd,
		// A tool dropped above is as much missing catalog as one the client's cap cut.
		truncated: listing.truncated || tools.length !== listing.tools.length,
		observedAt: new Date(options.nowMs ?? Date.now()).toISOString(),
		tools,
	};
	const text = `${JSON.stringify(catalog, null, 2)}\n`;
	if (Buffer.byteLength(text, "utf8") > MCP_METADATA_CACHE_CAPS.fileBytes) return false;
	try {
		safeResourceWrite(mcpCatalogPath(identity, options.cacheDir), text, { encoding: "utf8", mode: 0o600 });
		return true;
	} catch {
		return false;
	}
}
