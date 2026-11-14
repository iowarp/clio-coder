import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import { isPagePath, PAGE_PATHS } from "../contracts/pages.js";
import { harness } from "./harness/app.js";

test("the server's page list is exactly the routes the client router declares", async () => {
	const source = await readFile(new URL("../client/main.tsx", import.meta.url), "utf8");
	// A route is either eager (`{ path, element }`) or code-split (`{ path, lazy }`); both declare a page.
	const routed = [...source.matchAll(/\{\s*path: "([^"]+)",\s*(?:element|lazy):/g)].map((match) => match[1] as string);
	assert.ok(routed.length > 20, `expected the router's routes, read ${routed.length}`);
	// `/docs` is the index of `/docs/*`, which the router serves from the one wildcard route.
	assert.deepEqual([...new Set([...routed, "/docs"])].sort(), [...PAGE_PATHS].sort());
});

test("a page path is a page, a parameter is one segment, and an asset is not a page", () => {
	for (const path of [
		"/",
		"/settings/effective",
		"/sessions/abc",
		"/workspaces/0123abcd/sessions",
		"/fleet/dispatches/run-1",
		"/docs/architecture/trace-store.md",
		"/docs/",
	])
		assert.equal(isPagePath(path), true, path);
	for (const path of ["/assets/index.js", "/settings/unknown", "/sessions/a/b", "/api/meta", "/sw.js"])
		assert.equal(isPagePath(path), false, path);
});

test("a reload of any routed page is answered with the application, not a 404", async (t) => {
	const clientDir = await mkdtemp(join(tmpdir(), "clio-web-pages-"));
	t.after(() => rm(clientDir, { recursive: true, force: true }));
	await writeFile(join(clientDir, "index.html"), "<!doctype html><html><body>Clio</body></html>");
	const h = await harness({}, { clientDir });
	try {
		for (const path of ["/settings/effective", "/settings/why", "/system/interop", "/evidence/some-bundle"]) {
			const response = await h.request(path);
			assert.equal(response.status, 200, path);
			assert.match(await response.text(), /Clio/, path);
		}
		assert.equal((await h.request("/settings/unknown")).status, 404);
	} finally {
		await h.close();
	}
});

test("hashed assets are immutable, everything else revalidates by ETag, and large text is gzipped on request", async (t) => {
	const clientDir = await mkdtemp(join(tmpdir(), "clio-web-cache-"));
	t.after(() => rm(clientDir, { recursive: true, force: true }));
	await mkdir(join(clientDir, "assets"));
	const script = `export const rows = [${Array.from({ length: 200 }, (_, index) => `"row ${index}"`).join(",")}];\n`;
	assert.ok(script.length > 1024);
	await writeFile(join(clientDir, "index.html"), "<!doctype html><html><head></head><body>Clio</body></html>");
	await writeFile(join(clientDir, "assets", "index-Ab12Cd34.js"), script);
	await writeFile(join(clientDir, "assets", "tiny-Ef56Gh78.js"), "export {};\n");
	const h = await harness({}, { clientDir });
	const get = (path: string, headers: Record<string, string> = {}) =>
		h.app.request(`http://127.0.0.1:4317${path}`, { headers });
	try {
		const asset = await get("/assets/index-Ab12Cd34.js");
		assert.equal(asset.status, 200);
		assert.equal(asset.headers.get("Cache-Control"), "public, max-age=31536000, immutable");
		assert.ok(asset.headers.get("ETag"));
		assert.equal(asset.headers.get("Content-Encoding"), null);
		assert.equal(await asset.text(), script);

		const zipped = await get("/assets/index-Ab12Cd34.js", { "Accept-Encoding": "gzip, deflate, br" });
		assert.equal(zipped.headers.get("Content-Encoding"), "gzip");
		assert.match(zipped.headers.get("Vary") ?? "", /Accept-Encoding/);
		assert.equal(gunzipSync(Buffer.from(await zipped.arrayBuffer())).toString("utf8"), script);

		const tiny = await get("/assets/tiny-Ef56Gh78.js", { "Accept-Encoding": "gzip" });
		assert.equal(tiny.headers.get("Content-Encoding"), null);
		assert.equal(await tiny.text(), "export {};\n");

		for (const path of ["/", "/sessions/abc"]) {
			const page = await get(path);
			assert.equal(page.status, 200, path);
			assert.equal(page.headers.get("Cache-Control"), "no-cache", path);
			const etag = page.headers.get("ETag");
			assert.ok(etag, path);
			assert.match(await page.text(), /Clio/, path);
			const again = await get(path, { "If-None-Match": etag });
			assert.equal(again.status, 304, path);
			assert.equal(again.headers.get("ETag"), etag, path);
			assert.equal(again.headers.get("Cache-Control"), "no-cache", path);
			assert.equal(await again.text(), "", path);
		}
		const stale = await get("/", { "If-None-Match": '"0-0"' });
		assert.equal(stale.status, 200);

		const head = await h.app.request("http://127.0.0.1:4317/assets/index-Ab12Cd34.js", {
			method: "HEAD",
			headers: { "Accept-Encoding": "gzip" },
		});
		assert.equal(head.headers.get("Content-Encoding"), "gzip");
		assert.equal(head.headers.get("Cache-Control"), "public, max-age=31536000, immutable");
		assert.equal(await head.text(), "");
	} finally {
		await h.close();
	}
});

test("a changed file is served fresh with a new ETag, never from the cache", async (t) => {
	const clientDir = await mkdtemp(join(tmpdir(), "clio-web-cache-change-"));
	t.after(() => rm(clientDir, { recursive: true, force: true }));
	await writeFile(join(clientDir, "index.html"), "<!doctype html><html><body>Clio one</body></html>");
	const h = await harness({}, { clientDir });
	try {
		const first = await h.app.request("http://127.0.0.1:4317/");
		assert.match(await first.text(), /Clio one/);
		await writeFile(join(clientDir, "index.html"), "<!doctype html><html><body>Clio second</body></html>");
		const second = await h.app.request("http://127.0.0.1:4317/", {
			headers: { "If-None-Match": first.headers.get("ETag") ?? "" },
		});
		assert.equal(second.status, 200);
		assert.notEqual(second.headers.get("ETag"), first.headers.get("ETag"));
		assert.match(await second.text(), /Clio second/);
	} finally {
		await h.close();
	}
});
