import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { McpToolDescriptor } from "../../src/domains/gateway/mcp/client.js";
import {
	MCP_METADATA_CACHE_CAPS,
	MCP_METADATA_CACHE_TTL_MS,
	type McpCatalogIdentity,
	mcpCatalogPath,
	readMcpServerCatalog,
	writeMcpServerCatalog,
} from "../../src/domains/gateway/mcp/metadata-cache.js";

/**
 * The persisted MCP tool catalog. It exists so find and describe can answer
 * without launching a server, so everything here is about refusing to answer
 * from a file that no longer describes the declaration in front of it: a
 * different checkout, a re-declared command, an expired or corrupt snapshot.
 * A known-partial listing must also read back as partial, because a catalog
 * that forgets its truncation turns a capped listing into an apparent census.
 */

const roots: string[] = [];

function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "clio-coder-mcp-catalog-"));
	roots.push(dir);
	return dir;
}

function identity(overrides: Partial<McpCatalogIdentity> = {}): McpCatalogIdentity {
	return {
		projectRoot: "/repo/alpha",
		scope: "project",
		declarationPath: "/repo/alpha/.clio-coder/mcp.yaml",
		serverId: "files",
		digest: "a".repeat(64),
		cwd: "/repo/alpha",
		...overrides,
	};
}

function tool(overrides: Partial<McpToolDescriptor> = {}): McpToolDescriptor {
	return {
		name: "read_file",
		title: null,
		description: "Read a file",
		inputSchema: { type: "object", properties: { path: { type: "string" } } },
		annotations: null,
		...overrides,
	};
}

describe("MCP metadata cache", () => {
	let cacheDir: string;
	beforeEach(() => {
		cacheDir = scratch();
	});
	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("round trips a listing and keeps its truncation flag", () => {
		const id = identity();
		ok(writeMcpServerCatalog(id, { tools: [tool()], truncated: true }, { cacheDir }));
		const catalog = readMcpServerCatalog(id, { cacheDir });
		ok(catalog);
		strictEqual(catalog.truncated, true, "a capped listing must never read back as complete");
		strictEqual(catalog.serverId, "files");
		deepStrictEqual(catalog.tools, [
			{
				name: "read_file",
				description: "Read a file",
				inputSchema: { type: "object", properties: { path: { type: "string" } } },
			},
		]);
		const complete = identity({ serverId: "other" });
		ok(writeMcpServerCatalog(complete, { tools: [tool()], truncated: false }, { cacheDir }));
		strictEqual(readMcpServerCatalog(complete, { cacheDir })?.truncated, false);
	});

	it("never persists environment values, launch vectors, or trust decisions", () => {
		const id = identity();
		ok(
			writeMcpServerCatalog(
				id,
				{ tools: [tool({ annotations: { destructiveHint: false, readOnlyHint: true } })], truncated: false },
				{ cacheDir },
			),
		);
		const text = readFileSync(mcpCatalogPath(id, cacheDir), "utf8");
		for (const forbidden of ["command", "args", "env", "actionClass", "trust", "timeoutMs", "annotations"]) {
			ok(!text.includes(forbidden), `${forbidden} must not reach the cache file`);
		}
		// The catalog is not an authority record; a server hint cannot become one.
		strictEqual(readMcpServerCatalog(id, { cacheDir })?.tools[0]?.name, "read_file");
	});

	it("misses on a missing, corrupt, non-JSON, or oversized file", () => {
		const id = identity();
		strictEqual(readMcpServerCatalog(id, { cacheDir }), null, "no file is a miss");
		const file = mcpCatalogPath(id, cacheDir);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, "{not json");
		strictEqual(readMcpServerCatalog(id, { cacheDir }), null);
		writeFileSync(file, JSON.stringify({ version: 1, tools: [] }));
		strictEqual(readMcpServerCatalog(id, { cacheDir }), null, "a catalog without its identity is a miss");
		writeFileSync(
			file,
			JSON.stringify({ ...identity(), version: 2, truncated: false, observedAt: new Date().toISOString(), tools: [] }),
		);
		strictEqual(readMcpServerCatalog(id, { cacheDir }), null, "an unsupported version is a miss");
		writeFileSync(file, "x".repeat(MCP_METADATA_CACHE_CAPS.fileBytes + 1));
		strictEqual(readMcpServerCatalog(id, { cacheDir }), null, "an oversized file is a miss");
	});

	it("rejects a catalog whose tool entries are malformed or duplicated", () => {
		const id = identity();
		const file = mcpCatalogPath(id, cacheDir);
		mkdirSync(dirname(file), { recursive: true });
		const base = { ...id, version: 1, truncated: false, observedAt: new Date().toISOString() };
		const cases: unknown[][] = [
			[{ name: "", description: "", inputSchema: {} }],
			[{ name: "ok", description: 7, inputSchema: {} }],
			[{ name: "ok", description: "", inputSchema: "not an object" }],
			[
				{ name: "dup", description: "", inputSchema: {} },
				{ name: "dup", description: "", inputSchema: {} },
			],
			[{ name: "ok", description: "", inputSchema: { blob: "y".repeat(MCP_METADATA_CACHE_CAPS.schemaBytes) } }],
		];
		for (const tools of cases) {
			writeFileSync(file, JSON.stringify({ ...base, tools }));
			strictEqual(readMcpServerCatalog(id, { cacheDir }), null, JSON.stringify(tools).slice(0, 80));
		}
		writeFileSync(file, JSON.stringify({ ...base, tools: [{ name: "ok", description: "", inputSchema: {} }] }));
		ok(readMcpServerCatalog(id, { cacheDir }), "a well-formed catalog still loads");
	});

	it("separates two checkouts whose relative declarations are identical", () => {
		// A project-scope declaration's cwd is repository-relative, so the
		// declaration digest is the same in every clone. Only the project root
		// and resolved cwd tell the two catalogs apart.
		const alpha = identity({ projectRoot: "/repo/alpha", cwd: "/repo/alpha" });
		const beta = identity({
			projectRoot: "/repo/beta",
			declarationPath: "/repo/beta/.clio-coder/mcp.yaml",
			cwd: "/repo/beta",
		});
		strictEqual(alpha.digest, beta.digest, "the fixture reproduces the shared digest");
		ok(writeMcpServerCatalog(alpha, { tools: [tool({ name: "alpha_tool" })], truncated: false }, { cacheDir }));
		strictEqual(readMcpServerCatalog(beta, { cacheDir }), null, "the other checkout must not read this catalog");
		ok(writeMcpServerCatalog(beta, { tools: [tool({ name: "beta_tool" })], truncated: false }, { cacheDir }));
		strictEqual(readMcpServerCatalog(alpha, { cacheDir })?.tools[0]?.name, "alpha_tool");
		strictEqual(readMcpServerCatalog(beta, { cacheDir })?.tools[0]?.name, "beta_tool");
	});

	it("misses when the declaration digest or resolved cwd changed", () => {
		const id = identity();
		ok(writeMcpServerCatalog(id, { tools: [tool()], truncated: false }, { cacheDir }));
		strictEqual(readMcpServerCatalog(identity({ digest: "b".repeat(64) }), { cacheDir }), null);
		strictEqual(readMcpServerCatalog(identity({ cwd: "/repo/alpha/packages/server" }), { cacheDir }), null);
		strictEqual(readMcpServerCatalog(identity({ scope: "user" }), { cacheDir }), null);
		ok(readMcpServerCatalog(id, { cacheDir }), "the unchanged declaration still hits");
	});

	it("expires against an injected clock and refuses a future-dated file", () => {
		const id = identity();
		const writtenAt = 1_700_000_000_000;
		ok(writeMcpServerCatalog(id, { tools: [tool()], truncated: false }, { cacheDir, nowMs: writtenAt }));
		ok(readMcpServerCatalog(id, { cacheDir, nowMs: writtenAt + MCP_METADATA_CACHE_TTL_MS - 1 }));
		strictEqual(readMcpServerCatalog(id, { cacheDir, nowMs: writtenAt + MCP_METADATA_CACHE_TTL_MS }), null);
		strictEqual(readMcpServerCatalog(id, { cacheDir, nowMs: writtenAt - 1 }), null, "a future observedAt is a miss");
	});

	it("isolates one server's write from another's", () => {
		const files = identity({ serverId: "files" });
		const search = identity({ serverId: "search" });
		ok(writeMcpServerCatalog(files, { tools: [tool({ name: "read_file" })], truncated: false }, { cacheDir }));
		ok(writeMcpServerCatalog(search, { tools: [tool({ name: "query" })], truncated: false }, { cacheDir }));
		ok(mcpCatalogPath(files, cacheDir) !== mcpCatalogPath(search, cacheDir));
		strictEqual(readMcpServerCatalog(files, { cacheDir })?.tools[0]?.name, "read_file");
		strictEqual(readMcpServerCatalog(search, { cacheDir })?.tools[0]?.name, "query");
	});

	it("replaces a re-declared server's own catalog instead of stranding it", () => {
		const first = identity({ digest: "a".repeat(64) });
		ok(writeMcpServerCatalog(first, { tools: [tool({ name: "old" })], truncated: false }, { cacheDir }));
		const second = identity({ digest: "c".repeat(64) });
		strictEqual(mcpCatalogPath(first, cacheDir), mcpCatalogPath(second, cacheDir));
		ok(writeMcpServerCatalog(second, { tools: [tool({ name: "new" })], truncated: false }, { cacheDir }));
		strictEqual(readMcpServerCatalog(first, { cacheDir }), null);
		strictEqual(readMcpServerCatalog(second, { cacheDir })?.tools[0]?.name, "new");
	});

	it("marks a catalog incomplete when a tool is too large to persist", () => {
		const id = identity();
		const huge = tool({ name: "huge", inputSchema: { blob: "z".repeat(MCP_METADATA_CACHE_CAPS.schemaBytes) } });
		ok(writeMcpServerCatalog(id, { tools: [tool(), huge], truncated: false }, { cacheDir }));
		const catalog = readMcpServerCatalog(id, { cacheDir });
		ok(catalog);
		deepStrictEqual(
			catalog.tools.map((entry) => entry.name),
			["read_file"],
		);
		strictEqual(catalog.truncated, true, "a dropped tool is missing catalog too");
	});

	it("reports a failed write instead of throwing", () => {
		const blocked = join(cacheDir, "blocked");
		writeFileSync(blocked, "not a directory");
		strictEqual(writeMcpServerCatalog(identity(), { tools: [tool()], truncated: false }, { cacheDir: blocked }), false);
		strictEqual(
			writeMcpServerCatalog(
				identity(),
				{
					tools: Array.from({ length: MCP_METADATA_CACHE_CAPS.tools + 1 }, (_, i) => tool({ name: `t${i}` })),
					truncated: false,
				},
				{ cacheDir },
			),
			false,
			"a listing past the tool cap is refused rather than silently trimmed",
		);
	});
});
