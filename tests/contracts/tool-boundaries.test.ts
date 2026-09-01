import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, it } from "node:test";

import { Type } from "typebox";

import {
	normalizePathBoundary,
	normalizePathBoundaryEntry,
	pathBoundariesOverlap,
	pathBoundaryCovers,
} from "../../src/core/path-boundary.js";
import { ToolNames } from "../../src/core/tool-names.js";
import { CONFIRMED_SCOPE, READONLY_SCOPE, WORKSPACE_SCOPE } from "../../src/domains/safety/scope.js";
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
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		}
	});
});
