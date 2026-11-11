import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { runCensus } from "../../src/domains/lifecycle/index.js";

const ENDPOINT = "https://census.example.test/census";
const env = {};

test("the census is off by default and sends nothing without an endpoint (R-23)", async () => {
	const stateDir = mkdtempSync(join(tmpdir(), "census-"));
	try {
		const fetch = async () => {
			throw new Error("no request may leave");
		};
		strictEqual(DEFAULT_SETTINGS.report.census, "off");
		strictEqual(DEFAULT_SETTINGS.report.censusEndpoint, "");
		strictEqual(await runCensus({ stateDir, settings: DEFAULT_SETTINGS.report, version: "0.8.0", env, fetch }), "off");
		const on = { census: "on" as const, censusEndpoint: "" };
		strictEqual(await runCensus({ stateDir, settings: on, version: "0.8.0", env, fetch }), "no-endpoint");
		const ci = { census: "on" as const, censusEndpoint: ENDPOINT };
		strictEqual(await runCensus({ stateDir, settings: ci, version: "0.8.0", env: { CI: "1" }, fetch }), "disabled");
		strictEqual(existsSync(join(stateDir, "census.json")), false);
	} finally {
		rmSync(stateDir, { recursive: true, force: true });
	}
});

test("a joined install sends one id-less request a month across concurrent boots (R-23)", async () => {
	const stateDir = mkdtempSync(join(tmpdir(), "census-"));
	try {
		const sent: Array<{ url: string; init: RequestInit }> = [];
		const fetch = async (url: string, init: RequestInit) => void sent.push({ url, init });
		const settings = { census: "on" as const, censusEndpoint: ENDPOINT };
		const boot = (now: Date) => runCensus({ stateDir, settings, version: "0.8.0", env, fetch, now, platform: "linux" });
		const november = new Date("2026-11-10T12:00:00Z");
		const outcomes = await Promise.all([boot(november), boot(november), boot(november)]);
		deepStrictEqual(outcomes.sort(), ["counted", "counted", "sent"]);
		strictEqual(await boot(new Date("2026-11-30T23:59:00Z")), "counted");
		strictEqual(await boot(new Date("2026-12-01T00:00:00Z")), "sent");
		deepStrictEqual(
			sent.map(({ url }) => url),
			[`${ENDPOINT}/v1/0.8/linux.txt`, `${ENDPOINT}/v1/0.8/linux.txt`],
		);
		for (const { init } of sent) {
			strictEqual(init.method, "GET");
			strictEqual(init.headers, undefined);
			strictEqual(init.body, undefined);
		}
	} finally {
		rmSync(stateDir, { recursive: true, force: true });
	}
});
