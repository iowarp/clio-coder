import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { Accepted } from "../contracts/operations.js";
import { problemResponse } from "../server/http/problem.js";
import { staticClient } from "../server/http/static.js";
import { fixtureOptions } from "./fixtures/toolchain.js";
import { pinnedFetcher } from "./harness/adapter.js";
import { harness, json, terminal } from "./harness/app.js";
import { exchangeLaunchTicket } from "./harness/exchange.js";

test("pin allowlist rejects arbitrary URLs before the injected fetcher is called", async () => {
	let calls = 0;
	const fixture = fixtureOptions();
	const fetcher = pinnedFetcher(fixture.pins, async () => {
		calls++;
		return Buffer.from("ok");
	});
	await assert.rejects(fetcher("http://127.0.0.1:9999/private"), /outside the pinned/);
	assert.equal(calls, 0);
	await fetcher("https://fixture.invalid/herdr");
	assert.equal(calls, 1);
});

test("static assets and install paths refuse symlink escape", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "clio-coder-gui-static-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, "client"));
	await writeFile(join(root, "secret"), "must never be served");
	await writeFile(join(root, "client/index.html"), "client");
	await symlink(join(root, "secret"), join(root, "client/leak"));
	const app = new Hono();
	app.onError(problemResponse);
	staticClient(app, join(root, "client"));
	assert.equal((await app.request("/leak")).status, 404);
	assert.equal((await app.request("/%E0.js")).status, 400);
	assert.equal((await app.request("/toolchain")).status, 200);
	assert.equal(await (await app.request("/toolchain", { method: "HEAD" })).text(), "");
	assert.equal((await app.request("/toolchain", { method: "POST" })).status, 405);
	const h = await harness();
	t.after(h.close);
	await mkdir(join(h.home.path, "data/tools"), { recursive: true });
	await symlink(root, join(h.home.path, "data/tools/herdr"));
	const accepted = await json(await h.post("/api/toolchain/tools/herdr/install"), Accepted);
	const record = await terminal(h.operations, accepted.operationId);
	assert.ok(record.status === "failed");
	assert.equal(record.problem.code, "validation");
	assert.equal(await readFile(join(root, "secret"), "utf8"), "must never be served");
});

for (const signal of ["SIGTERM", "SIGHUP"] as const)
	test(`checkout launcher binds loopback, serves authenticated meta, and exits cleanly on ${signal}`, {
		timeout: 15000,
	}, async (t) => {
		// Building the client is a separate acceptance step; this test supplies a tiny
		// app-local static fixture only when the checkout has no build yet.
		const clientDir = fileURLToPath(new URL("../dist/client/", import.meta.url));
		let temporary = false;
		try {
			await readFile(join(clientDir, "index.html"));
		} catch {
			temporary = true;
			await mkdir(clientDir, { recursive: true });
			await writeFile(join(clientDir, "index.html"), "<h1>Fixture client</h1>");
		}
		t.after(async () => {
			if (temporary) await rm(clientDir, { recursive: true, force: true });
		});
		const child = spawn(process.execPath, ["--import", "tsx", "server/main.ts", "--fixture"], {
			cwd: fileURLToPath(new URL("../", import.meta.url)),
			stdio: ["ignore", "pipe", "pipe"],
		});
		t.after(() => {
			if (child.exitCode === null) child.kill("SIGKILL");
		});
		const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
		const url = await new Promise<string>((resolve, reject) => {
			let output = "";
			child.stdout.on("data", (chunk) => {
				output += String(chunk);
				const match = output.match(/http:\/\/127\.0\.0\.1:\d+\/#ticket=[\w-]+/);
				if (match) resolve(match[0]);
			});
			child.once("error", reject);
			child.once("exit", () => reject(new Error("Server exited before printing a URL")));
		});
		const launch = new URL(url);
		const ticket = new URLSearchParams(launch.hash.slice(1)).get("ticket");
		const get = (headers: Record<string, string>) =>
			new Promise<{ status?: number; data: string }>((resolve, reject) => {
				const req = request(new URL("/api/meta", launch), { headers }, (response) => {
					let data = "";
					response.on("data", (chunk) => {
						data += String(chunk);
					});
					response.on("end", () => resolve({ ...(response.statusCode ? { status: response.statusCode } : {}), data }));
				});
				req.on("error", reject);
				req.end();
			});
		assert.equal((await get({})).status, 401);
		assert.equal((await get({ Host: "example.com" })).status, 421);
		// The printed link carries a single-use ticket; the credential it buys reads meta.
		assert.equal(
			(await get({ Authorization: `Bearer ${await exchangeLaunchTicket(launch, ticket ?? "")}` })).status,
			200,
		);
		child.kill(signal);
		// Exit code 0 means the awaited close path ran; an unhandled signal exits with null.
		assert.equal(await exited, 0);
	});
