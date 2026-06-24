import { ok, strictEqual } from "node:assert/strict";
import { readdirSync } from "node:fs";
import { request } from "node:http";
import { after, before, describe, it } from "node:test";
import {
	contentTypeFor,
	type DocsServerHandle,
	resolveDocsHtmlDir,
	resolveRequestPath,
	startDocsServer,
	synthesizeMenu,
	topicToFile,
} from "../../src/cli/docs.js";

function httpGet(base: string, path: string): Promise<{ status: number; contentType: string; body: string }> {
	return new Promise((resolve, reject) => {
		const url = new URL(base);
		const req = request({ host: url.hostname, port: Number(url.port), method: "GET", path }, (res) => {
			let body = "";
			res.setEncoding("utf8");
			res.on("data", (chunk) => {
				body += chunk;
			});
			res.on("end", () => {
				resolve({
					status: res.statusCode ?? 0,
					contentType: String(res.headers["content-type"] ?? ""),
					body,
				});
			});
		});
		req.on("error", reject);
		req.end();
	});
}

describe("contracts/docs viewer pure helpers", () => {
	it("resolveRequestPath defaults to index.html and strips query and fragment", () => {
		const root = resolveRequestPath("/");
		ok(root.ok && root.relative === "index.html");
		const deep = resolveRequestPath("/safety_blueprint.html?theme=dark#top");
		ok(deep.ok && deep.relative === "safety_blueprint.html");
	});

	it("resolveRequestPath rejects traversal raw and percent-encoded", () => {
		const raw = resolveRequestPath("/../package.json");
		strictEqual(raw.ok, false);
		const encoded = resolveRequestPath("/%2e%2e/%2e%2e/package.json");
		strictEqual(encoded.ok, false);
	});

	it("contentTypeFor maps known extensions and defaults to octet-stream", () => {
		ok(contentTypeFor("a/index.html").startsWith("text/html"));
		ok(contentTypeFor("a/style.css").startsWith("text/css"));
		strictEqual(contentTypeFor("a/blob.bin"), "application/octet-stream");
	});

	it("synthesizeMenu excludes index, drops non-html, and strips the blueprint suffix", () => {
		const menu = synthesizeMenu(["index.html", "tools_blueprint.html", "safety_blueprint.html", "notes.txt"]);
		strictEqual(menu.length, 2);
		strictEqual(menu[0]?.topic, "safety");
		strictEqual(menu[0]?.label, "Safety");
		strictEqual(menu[1]?.topic, "tools");
		ok(!menu.some((entry) => entry.file === "index.html"));
	});

	it("topicToFile resolves bare topic, stem, full name, and case; null otherwise", () => {
		const files = ["index.html", "safety_blueprint.html"];
		strictEqual(topicToFile("safety", files), "safety_blueprint.html");
		strictEqual(topicToFile("safety_blueprint", files), "safety_blueprint.html");
		strictEqual(topicToFile("safety_blueprint.html", files), "safety_blueprint.html");
		strictEqual(topicToFile("SAFETY", files), "safety_blueprint.html");
		strictEqual(topicToFile("missing", files), null);
	});
});

describe("contracts/docs viewer server", () => {
	let handle: DocsServerHandle;
	let firstBlueprint: string | undefined;

	before(async () => {
		const htmlDir = resolveDocsHtmlDir();
		firstBlueprint = synthesizeMenu(readdirSync(htmlDir))[0]?.file;
		handle = await startDocsServer({ htmlDir });
	});

	after(async () => {
		await handle.close();
	});

	it("binds 127.0.0.1 only on an ephemeral port", () => {
		ok(handle.url.startsWith("http://127.0.0.1:"), handle.url);
		ok(handle.port > 0);
	});

	it("serves the index menu with a 200 and html content type", async () => {
		const res = await httpGet(handle.url, "/");
		strictEqual(res.status, 200);
		ok(res.contentType.startsWith("text/html"), res.contentType);
		ok(res.body.length > 0);
	});

	it("serves a blueprint page with a 200", async () => {
		ok(firstBlueprint, "expected at least one bundled blueprint");
		const res = await httpGet(handle.url, `/${firstBlueprint}`);
		strictEqual(res.status, 200);
		ok(res.contentType.startsWith("text/html"), res.contentType);
	});

	it("returns 404 for a missing file", async () => {
		const res = await httpGet(handle.url, "/does-not-exist.html");
		strictEqual(res.status, 404);
	});

	it("refuses to escape the html root", async () => {
		const res = await httpGet(handle.url, "/%2e%2e/package.json");
		strictEqual(res.status, 403);
	});
});
