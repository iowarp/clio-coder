import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

test("recovery upgrade replaces only owned caches and never caches API or external requests", async () => {
	const source = await readFile(new URL("../client/public/sw.js", import.meta.url), "utf8");
	const listeners = new Map<string, (event: Record<string, unknown>) => void>();
	const stores = new Map<string, string[]>([
		["clio-coder-recovery-v2", ["/offline.html", "/icon-192.png"]],
		["another-app", ["/unrelated"]],
	]);
	const caches = {
		async open(name: string) {
			return {
				async addAll(paths: string[]) {
					stores.set(name, paths);
				},
			};
		},
		async keys() {
			return [...stores.keys()];
		},
		async delete(name: string) {
			return stores.delete(name);
		},
		async match(path: string) {
			return [...stores.values()].some((paths) => paths.includes(path)) ? new Response(path) : undefined;
		},
	};
	runInNewContext(source, {
		URL,
		Response,
		caches,
		fetch: async () => {
			throw new Error("Offline");
		},
		self: {
			location: { origin: "http://127.0.0.1:4419" },
			addEventListener: (name: string, callback: (event: Record<string, unknown>) => void) =>
				listeners.set(name, callback),
			async skipWaiting() {},
			clients: { async claim() {} },
		},
	});
	for (const phase of ["install", "activate"]) {
		let work: Promise<unknown> | undefined;
		listeners.get(phase)?.({
			waitUntil: (promise: Promise<unknown>) => {
				work = promise;
			},
		});
		await work;
	}
	assert.equal(stores.has("clio-coder-recovery-v2"), false);
	assert.equal(stores.has("another-app"), true);
	assert.deepEqual(
		[...(stores.get("clio-coder-recovery-v3") ?? [])],
		["/offline.html", "/offline.css", "/offline.js", "/icon-192.png"],
	);
	for (const [url, method] of [
		["http://127.0.0.1:4419/api/sessions?token=private", "GET"],
		["https://coder.iowarp.ai/docs.html", "GET"],
		["http://127.0.0.1:4419/api/settings", "POST"],
	]) {
		let intercepted = false;
		listeners.get("fetch")?.({
			request: { url, method, mode: "navigate" },
			respondWith: () => {
				intercepted = true;
			},
		});
		assert.equal(intercepted, false, url);
	}
	let recovery: Promise<Response> | undefined;
	listeners.get("fetch")?.({
		request: { url: "http://127.0.0.1:4419/", method: "GET", mode: "navigate" },
		respondWith: (response: Promise<Response>) => {
			recovery = response;
		},
	});
	assert.ok(recovery);
	assert.equal(await (await recovery).text(), "/offline.html");
});
