import assert from "node:assert/strict";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { localServerReady } from "../server/local-server.js";
import { harness } from "./harness/app.js";

test("installable assets are public and credential-free only in background mode; APIs remain authenticated", async (t) => {
	const clientDir = await mkdtemp(join(tmpdir(), "clio-web-pwa-assets-"));
	t.after(() => rm(clientDir, { recursive: true, force: true }));
	await cp(fileURLToPath(new URL("../client/public/", import.meta.url)), clientDir, { recursive: true });
	await writeFile(join(clientDir, "index.html"), "<!doctype html><html><head></head><body>Clio</body></html>");
	for (const pwa of [false, true]) {
		const h = await harness({}, { clientDir, pwa });
		try {
			assert.equal((await (await h.request("/api/meta")).json()).pwa, pwa);
			assert.equal((await h.app.request("http://127.0.0.1:4317/api/meta")).status, 401);
			const index = await (await h.app.request("http://127.0.0.1:4317/")).text();
			assert.equal(index.includes('rel="manifest"'), pwa);
			for (const path of ["manifest.webmanifest", "sw.js", "offline.html", "offline.js", "offline.css"]) {
				const response = await h.app.request(`http://127.0.0.1:4317/${path}`);
				assert.equal(response.status, pwa ? 200 : 404, path);
				assert.ok(!(await response.text()).includes("test-token"));
			}
			if (pwa) {
				const manifest = await h.app.request("http://127.0.0.1:4317/manifest.webmanifest");
				assert.match(manifest.headers.get("Content-Type") ?? "", /manifest\+json/);
				assert.equal(manifest.headers.get("Cache-Control"), "no-cache");
				assert.equal((await manifest.json()).start_url, "/");
			}
			assert.equal((await h.request("/server.json")).status, 404);
		} finally {
			await h.close();
		}
	}
});

test("background readiness authenticates the exact loopback endpoint and rejects redirects, transient apps and oversized replies", async (t) => {
	let mode = "ready";
	const token = "a".repeat(43);
	const server = createServer((req, res) => {
		assert.equal(req.url, "/api/meta");
		assert.equal(req.headers.authorization, `Bearer ${token}`);
		if (mode === "redirect") {
			res.writeHead(302, { Location: "https://example.invalid" });
			res.end();
		} else if (mode === "oversized") res.end("x".repeat(9000));
		else res.end(JSON.stringify({ apiVersion: 1, pwa: mode === "ready" }));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => {
		server.closeAllConnections();
		server.close();
	});
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	assert.equal(await localServerReady(address.port, token), true);
	for (mode of ["redirect", "transient", "oversized"]) assert.equal(await localServerReady(address.port, token), false);
	await assert.rejects(localServerReady(0, token));
	await assert.rejects(localServerReady(address.port, "bad\r\nheader"));
});
