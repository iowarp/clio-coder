import { deepStrictEqual, match, ok, strictEqual, throws } from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { Type } from "typebox";

import {
	normalizePathBoundary,
	normalizePathBoundaryEntry,
	pathBoundariesOverlap,
	pathBoundaryCovers,
} from "../../src/core/path-boundary.js";
import { ToolNames } from "../../src/core/tool-names.js";
import { writeWikiMeta } from "../../src/domains/context/wiki/meta.js";
import { CONFIRMED_SCOPE, READONLY_SCOPE, WORKSPACE_SCOPE } from "../../src/domains/safety/scope.js";
import { codeNavTool } from "../../src/tools/codewiki/code-nav.js";
import { codeNavToolSurface } from "../../src/tools/codewiki/code-nav-surface.js";
import { createRegistry, type ToolSpec } from "../../src/tools/registry.js";
import { toolResultContextText } from "../../src/tools/result-disposition.js";
import { webFetchTool } from "../../src/tools/web-fetch.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

function allowAllSafety() {
	return {
		classify: () => ({ actionClass: "read" as const, reasons: [] }),
		evaluate: () => ({ kind: "allow" as const, classification: { actionClass: "read" as const, reasons: [] } }),
		observeLoop: () => ({ looping: false, key: "contract", count: 0 }),
		scopes: { readonly: READONLY_SCOPE, workspace: WORKSPACE_SCOPE, confirmed: CONFIRMED_SCOPE },
		isSubset: () => true,
		audit: { recordCount: () => 0 },
	};
}

describe("tool boundary contract", () => {
	let scratch: IsolatedClioEnv;

	beforeEach(async () => {
		scratch = await isolateClioEnv("clio-tool-contract-");
	});

	afterEach(() => scratch.restore());

	it("normalizes write declarations without turning files, prefixes, or escapes into subtrees", () => {
		deepStrictEqual(normalizePathBoundary(["docs//guide.md", "src/", "src/"]), ["docs/guide.md", "src/"]);
		strictEqual(pathBoundaryCovers(["src/"], "src/domains/tool.ts"), true);
		strictEqual(pathBoundaryCovers(["src"], "src/domains/tool.ts"), false);
		strictEqual(pathBoundaryCovers(["src/"], "src-other/tool.ts"), false);
		strictEqual(pathBoundariesOverlap(["src/"], ["src/domains/tool.ts"]), true);
		strictEqual(pathBoundariesOverlap(["src/"], ["docs/"]), false);
		for (const entry of ["/etc/passwd", "../outside", "src/**/*.ts", "src\\windows"]) {
			throws(() => normalizePathBoundaryEntry(entry));
		}
	});

	it("normalizes registry arguments and applies one bounded result disposition", async () => {
		let received: Record<string, unknown> | null = null;
		const readReceived = (): Record<string, unknown> | null => received;
		const spec: ToolSpec = {
			name: ToolNames.Read,
			description: "contract read",
			parameters: Type.Object({}),
			baseActionClass: "read",
			prepareArguments: (args) => (typeof args.legacy === "string" ? { path: args.legacy } : args),
			metadata: {
				objective: "exercise the tool boundary",
				uiLabel: "Contract",
				retrySafety: "idempotent",
				costLatency: "local_fast",
				resultSizePolicy: { kind: "bounded", maxBytes: 8_192 },
				resultDisposition: {
					presentation: {
						foldDefault: "folded",
						showDiffWhenFolded: false,
						failureExcerpt: true,
						maxBytes: 8_192,
					},
					context: { mode: "summary", maxBytes: 320 },
				},
			},
			run: async (args) => {
				received = args;
				return { kind: "ok", output: Array.from({ length: 100 }, (_, index) => `line-${index}`).join("\n") };
			},
		};
		const registry = createRegistry({ safety: allowAllSafety() });
		registry.register(spec);
		const verdict = await registry.invoke({ tool: ToolNames.Read, args: { legacy: "src/file.ts" } });
		strictEqual(verdict.kind, "ok");
		strictEqual(readReceived()?.path, "src/file.ts");
		strictEqual(readReceived()?.legacy, undefined);
		if (verdict.kind !== "ok") return;
		const disposition = verdict.result.details?.resultDisposition as { applications?: number; contextBytes?: number };
		strictEqual(disposition.applications, 1);
		ok((disposition.contextBytes ?? Number.POSITIVE_INFINITY) <= 320);
		ok(Buffer.byteLength(toolResultContextText(verdict.result), "utf8") <= 320);
	});

	it("caps tool results at the default or session override and offloads every omitted byte", async () => {
		const fullOutput = "0123456789abcdef".repeat(4_500);
		const spec: ToolSpec = {
			name: ToolNames.Read,
			description: "oversize contract result",
			parameters: Type.Object({}),
			baseActionClass: "read",
			run: async () => ({ kind: "ok", output: fullOutput }),
		};
		const registry = createRegistry({ safety: allowAllSafety() });
		registry.register(spec);

		const defaultVerdict = await registry.invoke({ tool: ToolNames.Read, args: {} });
		strictEqual(defaultVerdict.kind, "ok");
		if (defaultVerdict.kind !== "ok") return;
		const defaultSize = defaultVerdict.result.details?.resultSize as {
			maxBytes?: number;
			truncated?: boolean;
			offloadPath?: string;
		};
		strictEqual(defaultSize.maxBytes, 65_536);
		strictEqual(defaultSize.truncated, true);
		ok(defaultSize.offloadPath);
		strictEqual(readFileSync(defaultSize.offloadPath, "utf8"), fullOutput);
		if (defaultVerdict.result.kind === "ok") match(defaultVerdict.result.output, /full: .*\.txt/u);

		const overrideVerdict = await registry.invoke(
			{ tool: ToolNames.Read, args: {} },
			{ sessionId: "override", toolResultMaxBytes: 4_096 },
		);
		strictEqual(overrideVerdict.kind, "ok");
		if (overrideVerdict.kind !== "ok") return;
		const overrideSize = overrideVerdict.result.details?.resultSize as { maxBytes?: number; offloadPath?: string };
		strictEqual(overrideSize.maxBytes, 4_096);
		ok(overrideSize.offloadPath);
		strictEqual(readFileSync(overrideSize.offloadPath, "utf8"), fullOutput);
		if (overrideVerdict.result.kind === "ok") match(overrideVerdict.result.output, /full: .*\.txt/u);
	});

	it("uses the same wiki summary for the catalog and a page query", async () => {
		const previousCwd = process.cwd();
		const wiki = join(scratch.dir, ".clio-coder/wiki");
		mkdirSync(wiki, { recursive: true });
		writeFileSync(join(scratch.dir, "a.ts"), "export const a = 1;\n");
		writeWikiMeta(scratch.dir, {
			version: 1,
			updatedAt: new Date().toISOString(),
			gitHead: null,
			model: "fixture",
			contentHash: "a".repeat(64),
			pages: [{ path: "a.md", title: "A" }],
		});
		try {
			process.chdir(scratch.dir);
			for (const frontmatter of ["summary: Authored routing summary.\n", ""]) {
				writeFileSync(join(wiki, "a.md"), `---\ntitle: A\n${frontmatter}---\n# A\n\nBody summary.\n`);
				const catalog = await codeNavTool.run({ mode: "wiki" });
				const query = await codeNavTool.run({ mode: "wiki", query: "a" });
				ok(catalog.kind === "ok" && query.kind === "ok");
				const pages = JSON.parse(catalog.output).pages;
				const page = JSON.parse(query.output).page;
				strictEqual(page.summary, frontmatter ? "Authored routing summary." : "Body summary.");
				strictEqual(page.summary, pages[0].summary);
			}
		} finally {
			process.chdir(previousCwd);
		}
	});

	it("keeps the code_nav source selector closed and defaults its schema to workspace", async () => {
		const parameters = codeNavToolSurface.parameters as {
			properties?: { source?: { enum?: unknown; default?: unknown } };
		};
		deepStrictEqual(parameters.properties?.source?.enum, ["workspace", "clio"]);
		strictEqual(parameters.properties?.source?.default, "workspace");

		const arbitrary = await codeNavTool.run({ source: scratch.dir, mode: "symbol", query: "codeNavTool" });
		strictEqual(arbitrary.kind, "error");
		if (arbitrary.kind === "error") match(arbitrary.message, /source must be workspace or clio/u);
	});

	it("preserves web method, headers, body, and response through the transport", async () => {
		let received: { method: string; header: string; body: string } | null = null;
		const readReceived = (): { method: string; header: string; body: string } | null => received;
		const server = createServer((request, response) => {
			const chunks: Buffer[] = [];
			request.on("data", (chunk: Buffer) => chunks.push(chunk));
			request.on("end", () => {
				received = {
					method: request.method ?? "",
					header: String(request.headers["x-contract"] ?? ""),
					body: Buffer.concat(chunks).toString("utf8"),
				};
				response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
				response.end("transport-ok");
			});
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});
		const previousPrivateNetwork = process.env.CLIO_CODER_WEB_FETCH_ALLOW_PRIVATE_NETWORK;
		process.env.CLIO_CODER_WEB_FETCH_ALLOW_PRIVATE_NETWORK = "1";
		try {
			const address = server.address() as AddressInfo;
			const result = await webFetchTool.run({
				url: `http://127.0.0.1:${address.port}/echo`,
				method: "post",
				headers: { "X-Contract": "tool-wire" },
				body: "snowman=☃",
				format: "raw",
				timeout_ms: 2_000,
			});
			strictEqual(result.kind, "ok");
			strictEqual(readReceived()?.method, "POST");
			strictEqual(readReceived()?.header, "tool-wire");
			strictEqual(readReceived()?.body, "snowman=☃");
			if (result.kind === "ok") ok(result.output.includes("transport-ok"));
		} finally {
			if (previousPrivateNetwork === undefined) delete process.env.CLIO_CODER_WEB_FETCH_ALLOW_PRIVATE_NETWORK;
			else process.env.CLIO_CODER_WEB_FETCH_ALLOW_PRIVATE_NETWORK = previousPrivateNetwork;
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		}
	});
});
