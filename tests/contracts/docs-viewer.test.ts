import { ok, strictEqual } from "node:assert/strict";
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
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

const CLI_ENTRY = join(new URL("../..", import.meta.url).pathname, "dist", "cli", "index.js");

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

/**
 * The banner names a fixed install directory, so it has to name it the way
 * every other path this CLI prints is named: absolutely. It used to be
 * relativized against the cwd, which from anywhere outside the install printed
 * a `../../../home/...` string that only resolved from the directory the
 * operator happened to be standing in.
 */
describe("contracts/docs viewer banner", () => {
	/** Start the viewer from `cwd`, read until it has printed its banner, then Ctrl+C it. */
	function runViewerBanner(cwd: string): Promise<string> {
		return new Promise((resolve, reject) => {
			const child = spawn(process.execPath, [CLI_ENTRY, "docs", "safety", "--no-open"], {
				cwd,
				env: process.env,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stdout = "";
			let stopped = false;
			const timer = setTimeout(() => {
				child.kill("SIGKILL");
				reject(new Error(`docs viewer printed no banner in time: ${stdout}`));
			}, 15_000);
			child.stdout.setEncoding("utf8");
			child.stdout.on("data", (chunk: string) => {
				stdout += chunk;
				if (!stopped && stdout.includes("press Ctrl+C to stop.")) {
					stopped = true;
					child.kill("SIGINT");
				}
			});
			child.on("error", (err) => {
				clearTimeout(timer);
				reject(err);
			});
			child.on("close", () => {
				clearTimeout(timer);
				resolve(stdout);
			});
		});
	}

	it("prints the served directory absolutely, from a cwd outside the install", async () => {
		const banner = await runViewerBanner(tmpdir());
		const served = banner.split("\n").find((line) => line.includes("serving ")) ?? "";
		const path = served.replace(/^\s*serving\s+/, "");
		strictEqual(path, resolveDocsHtmlDir(), `banner line was ${JSON.stringify(served)}`);
		ok(isAbsolute(path), `served path must be absolute: ${path}`);
		ok(!path.includes(".."), `served path must not be relativized: ${path}`);
	});
});
