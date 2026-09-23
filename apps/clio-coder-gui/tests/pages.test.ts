import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
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
