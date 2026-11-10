import { ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { installProxyFromEnv, proxyEnvSummary } from "../../src/core/proxy-env.js";

test("a NO_PROXY CIDR range is not listed as direct, and installing the proxy says it is not honoured", async (t) => {
	const written: string[] = [];
	t.mock.method(process.stderr, "write", (chunk: string | Uint8Array) => {
		written.push(String(chunk));
		return true;
	});
	await installProxyFromEnv({ https_proxy: "http://proxy.invalid:3128", no_proxy: "192.168.0.0/16,corp.example" });
	t.mock.restoreAll();
	const summary = proxyEnvSummary() ?? "";
	ok(summary.includes("corp.example"), summary);
	strictEqual(summary.includes("192.168.0.0/16"), false, summary);
	const warning = written.join("");
	ok(/CIDR entries are not honoured \(192\.168\.0\.0\/16\)/u.test(warning), warning);
	strictEqual(warning.includes("corp.example"), false, warning);
});
