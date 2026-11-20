import assert from "node:assert/strict";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { serverProof } from "../server/launch-proof.js";
import { dropClientCredential, launchTicket, localServerReady } from "../server/local-server.js";
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
	const credential = "c".repeat(43);
	const legacyToken = "b".repeat(43);
	const launchTokenPaths: string[] = [];
	const server = createServer(async (req, res) => {
		if (req.headers.authorization === `Bearer ${token}`) launchTokenPaths.push(`${req.method} ${req.url}`);
		if (req.url === "/api/auth/challenge") {
			assert.equal(req.method, "POST");
			assert.equal(req.headers.authorization, undefined);
			res.writeHead(mode === "legacy" ? 404 : 200);
			res.end(mode === "legacy" ? "{}" : JSON.stringify({ challenge: "h".repeat(43), expiresIn: 60 }));
			return;
		}
		if (req.url === "/api/auth/clients") {
			assert.equal(req.method, "POST");
			if (mode === "legacy") {
				res.writeHead(404);
				res.end("{}");
				return;
			}
			assert.equal(req.headers.authorization, undefined);
			let text = "";
			for await (const chunk of req) text += String(chunk);
			const { challenge } = JSON.parse(text) as { challenge: string };
			assert.equal(challenge, "h".repeat(43));
			const port = (server.address() as { port: number }).port;
			res.end(
				JSON.stringify({
					clientId: "launcher-1",
					credential,
					rotateIn: 450,
					expiresIn: 900,
					serverProof: serverProof(token, challenge, port),
				}),
			);
			return;
		}
		assert.equal(req.url, "/api/meta");
		res.setHeader("X-Clio-Client", "launcher-1");
		assert.equal(req.headers.authorization, `Bearer ${mode === "legacy" ? legacyToken : credential}`);
		if (mode === "redirect") {
			res.writeHead(302, { Location: "https://example.invalid" });
			res.end();
		} else if (mode === "oversized") res.end("x".repeat(9000));
		else res.end(JSON.stringify({ apiVersion: 1, pwa: mode === "ready" || mode === "legacy" }));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => {
		server.closeAllConnections();
		server.close();
	});
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	assert.equal(await localServerReady(address.port, token), true);
	// The launch token went nowhere: the exchange carried a proof and the probe read meta on the credential it bought.
	assert.deepEqual(launchTokenPaths, []);
	for (mode of ["redirect", "transient", "oversized"]) assert.equal(await localServerReady(address.port, token), false);
	await assert.rejects(localServerReady(0, token));
	await assert.rejects(localServerReady(address.port, "bad\r\nheader"));
	// An app from before per-client credentials has no exchange; the version gate still reads it.
	// A listener that answers the exchange with 404 is not this app, and is never handed the token.
	mode = "legacy";
	assert.equal(await localServerReady(address.port, legacyToken), false);
});

test("a held credential's answer counts only from the app that issued it, so a listener that took the port after a restart is not ready", async (t) => {
	const token = "s".repeat(43);
	let named = true;
	const app = createServer(async (req, res) => {
		if (req.url === "/api/auth/challenge") return res.end(JSON.stringify({ challenge: "h".repeat(43), expiresIn: 60 }));
		if (req.url === "/api/auth/clients") {
			let text = "";
			for await (const chunk of req) text += String(chunk);
			const { challenge } = JSON.parse(text) as { challenge: string };
			const port = (app.address() as { port: number }).port;
			return res.end(
				JSON.stringify({
					clientId: "launcher-1",
					credential: "c".repeat(43),
					rotateIn: 450,
					expiresIn: 900,
					serverProof: serverProof(token, challenge, port),
				}),
			);
		}
		if (named) res.setHeader("X-Clio-Client", "launcher-1");
		res.end(JSON.stringify({ apiVersion: 1, pwa: true, ticket: "k".repeat(43) }));
	});
	await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
	// Closed here too, so a failing assertion never leaves the listener holding the test process open.
	t.after(() => {
		app.closeAllConnections();
		app.close(() => {});
	});
	const port = (app.address() as { port: number }).port;
	assert.equal(await localServerReady(port, token), true);
	assert.equal(await launchTicket(port, token), "k".repeat(43));
	// The proof answers for its own exchange only: a listener that hands the port over right after it, so the next
	// answer names no client this process holds, is not the app, for readiness and for the ticket a browser opens.
	dropClientCredential(port, port, token);
	named = false;
	assert.equal(await localServerReady(port, token), false);
	assert.equal(await launchTicket(port, token), null);
	// One more authenticated exchange with the app, so the launcher holds a credential when the replacement binds.
	named = true;
	assert.equal(await localServerReady(port, token), true);
	app.closeAllConnections();
	await new Promise((resolve) => app.close(resolve));
	// Another program takes the port in the restart gap and answers 200 to anything; the held credential's answer names
	// a client this process does not hold, and the squatter cannot prove the token.
	const presented: string[] = [];
	const squatter = createServer((req, res) => {
		if (req.url === "/api/auth/challenge") return res.end(JSON.stringify({ challenge: "q".repeat(43), expiresIn: 60 }));
		if (req.url === "/api/auth/clients")
			return res.end(JSON.stringify({ clientId: "x", credential: "x".repeat(43), rotateIn: 450, serverProof: "nope" }));
		presented.push(req.headers.authorization ?? "");
		res.setHeader("X-Clio-Client", "squatter");
		res.end(JSON.stringify({ apiVersion: 1, pwa: true }));
	});
	await new Promise<void>((resolve) => squatter.listen(port, "127.0.0.1", resolve));
	t.after(() => {
		squatter.closeAllConnections();
		squatter.close();
	});
	assert.equal(await localServerReady(port, token), false);
	assert.ok(presented[0]?.endsWith("c".repeat(43)), "the replacement was asked with the held credential");
});
