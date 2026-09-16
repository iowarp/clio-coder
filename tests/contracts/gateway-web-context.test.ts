import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ToolNames } from "../../src/core/tool-names.js";
import { classify } from "../../src/domains/safety/action-classifier.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { listDocsCorpus, searchDocs } from "../../src/tools/context/docs-engine.js";
import { createContextTool, runDocsScope } from "../../src/tools/context/index.js";
import { createClioDocsTool, createClioLibraryTool } from "../../src/tools/gateway/clio-context-tools.js";
import { reserveObservation } from "../../src/tools/observation.js";
import { createRegistry } from "../../src/tools/registry.js";
import { webFetchTool, webReadTool } from "../../src/tools/web-fetch.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

/**
 * The web split and the context split. web_read is never an outward action
 * whatever its arguments; web_fetch keeps the outward rules. clio_docs and
 * clio_library return what context(scope="docs"|"library") returned, and the
 * context tool refuses both scopes with the exact gateway replacement.
 */

describe("web_read and web_fetch", () => {
	it("classifies web_read as read whatever the arguments and keeps web_fetch's outward rule", () => {
		const outward = { url: "https://example.invalid/post", method: "POST", body: "payload" };
		strictEqual(classify({ tool: ToolNames.WebRead, args: outward }).actionClass, "read");
		strictEqual(classify({ tool: ToolNames.WebRead, args: { url: "https://example.invalid/" } }).actionClass, "read");
		strictEqual(classify({ tool: ToolNames.WebFetch, args: outward }).actionClass, "write");
		deepStrictEqual(classify({ tool: ToolNames.WebFetch, args: outward }).reasons, ["web-fetch:outward"]);
		strictEqual(classify({ tool: ToolNames.WebFetch, args: { url: "https://example.invalid/" } }).actionClass, "read");
	});

	it("parks an outward web_fetch at auto-edit while the same arguments run through web_read as a plain GET", async () => {
		const parks: string[] = [];
		const registry = createRegistry({ safety: createWorkerSafety(), autonomy: () => "auto-edit" });
		registry.register(webReadTool);
		registry.register(webFetchTool);
		registry.onPermissionRequired((call, _decision, meta) => {
			parks.push(call.tool);
			registry.cancelParkedCall(meta.requestId, "denied by the test");
		});
		const args = { url: "ftp://example.invalid/resource", method: "POST", body: "payload" };
		const fetched = await registry.invoke({ tool: ToolNames.WebFetch, args });
		strictEqual(fetched.kind, "blocked", "an outward request asks at auto-edit; the test denied it");
		deepStrictEqual(parks, [ToolNames.WebFetch]);
		const read = await registry.invoke({ tool: ToolNames.WebRead, args });
		strictEqual(read.kind, "ok", "web_read never asks: nothing it accepts is outward");
		if (read.kind !== "ok" || read.result.kind !== "error") throw new Error(JSON.stringify(read));
		ok(read.result.message.startsWith("web_read: unsupported scheme ftp:"), read.result.message);
		deepStrictEqual(parks, [ToolNames.WebFetch]);
	});

	it("exposes web_read without method, headers, or body in its schema", () => {
		const properties = Object.keys((webReadTool.parameters as { properties: Record<string, unknown> }).properties);
		deepStrictEqual(properties.sort(), ["format", "max_bytes", "timeout_ms", "url"]);
	});
});

describe("clio_docs and clio_library", () => {
	let env: IsolatedClioEnv;
	beforeEach(async () => {
		env = await isolateClioEnv("clio-coder-gateway-context-");
	});
	afterEach(() => env.restore());

	it("returns the documentation corpus and ranked sections exactly as the docs scope did", async () => {
		const docs = createClioDocsTool();
		const corpus = listDocsCorpus();
		ok(corpus.ok, corpus.ok ? "" : corpus.message);
		const listed = await docs.run({}, {});
		if (listed.kind !== "ok") throw new Error(listed.message);
		if (!corpus.ok) return;
		strictEqual(listed.output, JSON.stringify(corpus.payload));
		const observation = (listed.details as { observation: { tool: string } }).observation;
		strictEqual(observation.tool, ToolNames.ClioDocs);

		const search = searchDocs("gateway", 3);
		ok(search.ok, search.ok ? "" : search.message);
		const searched = await docs.run({ query: "gateway", limit: 3 }, {});
		if (searched.kind !== "ok" || !search.ok) throw new Error(JSON.stringify(searched));
		strictEqual(searched.output, JSON.stringify(search.payload));
		// The former scope function under the context name yields the same body.
		const legacy = runDocsScope({ query: "gateway", limit: 3 }, reserveObservation(16 * 1024), undefined);
		if (legacy.kind !== "ok") throw new Error(legacy.message);
		strictEqual(searched.output, legacy.output);
	});

	it("refuses the library read on a worker registry exactly as the context scope did", async () => {
		const worker = createClioLibraryTool({ getCwd: () => env.dir, skillMarketplace: false });
		const result = await worker.run({}, {});
		strictEqual(result.kind, "error");
		if (result.kind === "error") ok(result.message.includes("unavailable"), result.message);
	});

	it("drops docs and library from context and names the gateway replacement", async () => {
		const context = createContextTool({ getCwd: () => env.dir });
		for (const [scope, capability] of [
			["docs", ToolNames.ClioDocs],
			["library", ToolNames.ClioLibrary],
		] as const) {
			const result = await context.run({ scope }, {});
			strictEqual(result.kind, "error");
			if (result.kind !== "error") return;
			ok(result.message.includes(`capability="${capability}"`), result.message);
			ok(result.message.includes('gateway(op="call"'), result.message);
		}
		const schema = (context.parameters as { properties: { scope: { enum?: string[]; anyOf?: unknown[] } } }).properties;
		const scopes = JSON.stringify(schema.scope);
		ok(!scopes.includes('"docs"') && !scopes.includes('"library"'), scopes);
		ok(!("kind" in schema), "the library kind argument left the context schema");
	});
});
