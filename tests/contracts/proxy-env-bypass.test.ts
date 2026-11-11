import { ok, strictEqual } from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { installProxyFromEnv, proxyEnvSummary, proxyForUrl } from "../../src/core/proxy-env.js";

let proxyHits = 0;

function listen(body: string, host: string): Promise<Server> {
	const server = createServer((_req, res) => {
		if (body === "proxied") proxyHits++;
		res.end(body);
	});
	// undici tunnels through the proxy with CONNECT; the stub counts it and refuses.
	server.on("connect", (_req, socket) => {
		proxyHits++;
		socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
	});
	return new Promise((resolve) => server.listen(0, host, () => resolve(server)));
}

test("NO_PROXY CIDR ranges and IP wildcards send matching IP hosts direct and others through the proxy", async (t) => {
	const original = getGlobalDispatcher();
	const proxy = await listen("proxied", "127.0.0.1");
	const target = await listen("direct", "127.0.0.2");
	t.after(() => {
		setGlobalDispatcher(original);
		proxy.close();
		target.close();
	});
	const proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
	const url = `http://127.0.0.2:${(target.address() as AddressInfo).port}/`;
	const written: string[] = [];
	t.mock.method(process.stderr, "write", (chunk: string | Uint8Array) => {
		written.push(String(chunk));
		return true;
	});

	await installProxyFromEnv({ http_proxy: proxyUrl, no_proxy: "127.0.0.0/8,corp.example" });
	strictEqual(await (await fetch(url)).text(), "direct");
	strictEqual(proxyForUrl(url), null);
	strictEqual(proxyForUrl("http://10.1.2.3/"), proxyUrl);
	ok((proxyEnvSummary() ?? "").includes("127.0.0.0/8"));

	await installProxyFromEnv({ http_proxy: proxyUrl, no_proxy: "127.0.0.*" });
	strictEqual(await (await fetch(url)).text(), "direct");

	await installProxyFromEnv({ http_proxy: proxyUrl, no_proxy: "10.0.0.0/8,192.168.*" });
	const before = proxyHits;
	const via = await fetch(url).then(
		(res) => res.text(),
		() => "refused",
	);
	ok(via === "proxied" || via === "refused", via);
	ok(proxyHits > before);
	strictEqual(proxyForUrl("http://10.1.2.3/"), null);
	strictEqual(proxyForUrl("http://192.168.1.5/"), null);
	strictEqual(proxyForUrl("http://192.169.1.5/"), proxyUrl);
	strictEqual(proxyForUrl("http://[fd00::1]/"), proxyUrl);

	await installProxyFromEnv({ http_proxy: proxyUrl, no_proxy: "fd00::/8" });
	strictEqual(proxyForUrl("http://[fd00::1]/"), null);
	t.mock.restoreAll();
	strictEqual(written.join("").includes("not honoured"), false);
});
