import assert from "node:assert/strict";
import { mkdir, readdir, readFile, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { Installation } from "../../src/domains/lifecycle/install-method.js";
import { compareReleaseVersions, parseReleaseVersion } from "../../src/domains/lifecycle/release-version.js";
import {
	createUpdateCheck,
	UPDATE_CHECK_INTERVAL_MS,
	UPDATE_NOTICE_INTERVAL_MS,
} from "../../src/domains/lifecycle/update-check.js";
import { startUpdateMonitor } from "../../src/interactive/update-monitor.js";
import { makeScratchHome } from "../harness/scratch-env.js";

async function fixture(kind: Installation["kind"] = "npm") {
	const home = makeScratchHome("clio-update-check-");
	const root = join(home.dir, "package");
	const cacheDir = join(home.dir, "cache");
	const entry = join(root, "dist/cli/index.js");
	await mkdir(join(root, "dist/cli"), { recursive: true });
	await writeFile(join(root, "package.json"), JSON.stringify({ name: "@iowarp/clio-coder", version: "0.5.4" }));
	await writeFile(entry, "// installed CLI\n");
	await utimes(entry, 1, 1);
	const installation: Installation = { kind, root, entry, prefix: home.dir };
	return { home, root, entry, cacheDir, installation, processStartedAt: Date.now() - 10_000, runningVersion: "0.5.4" };
}

test("release ordering is semantic, rejects malformed metadata, and handles prereleases", () => {
	assert.equal(compareReleaseVersions("0.5.10", "0.5.9"), 1);
	assert.equal(compareReleaseVersions("1.0.0-beta.10", "1.0.0-beta.2"), 1);
	assert.equal(compareReleaseVersions("1.0.0", "1.0.0-rc.1"), 1);
	assert.equal(compareReleaseVersions("1.0.0+build.2", "1.0.0+build.1"), 0);
	assert.equal(compareReleaseVersions("1.0.0-alpha", "1.0.0-alpha.1"), -1);
	assert.equal(compareReleaseVersions("1.0.0-1", "1.0.0-alpha"), -1);
	for (const bad of ["v1.0.0", "01.0.0", "1.0.0-01", "1.0.0\nrun code", "1.0.0; echo hi", "99999999999999999.0.0", null])
		assert.equal(parseReleaseVersion(bad), null);
});

test("checks once a day across processes, caches failures, and reminds once a week", async (t) => {
	const f = await fixture();
	t.after(f.home.cleanup);
	const controller = new AbortController();
	let time = Date.now();
	let calls = 0;
	let available: string | null = "0.5.5";
	const options = {
		...f,
		now: () => time,
		fetchVersion: async () => {
			calls++;
			return available;
		},
	};
	const check = createUpdateCheck(options);
	assert.deepEqual(await readdir(f.home.dir), ["package"], "construction does no I/O");
	const notice = await check.probe(controller.signal);
	assert.equal(notice?.kind, "available");
	assert.equal(calls, 1);
	assert.ok(notice);
	assert.equal(
		await check.claim(notice, () => false, controller.signal),
		false,
		"busy sessions do not consume a reminder",
	);
	assert.equal(await check.claim(notice, () => true, controller.signal), true);
	const sibling = createUpdateCheck(options);
	await sibling.probe(controller.signal);
	assert.equal(calls, 1);
	assert.equal(await sibling.claim(notice, () => true, controller.signal), false);
	time += UPDATE_NOTICE_INTERVAL_MS + 1;
	assert.equal(await sibling.claim(notice, () => true, controller.signal), true);
	available = null;
	assert.equal(await sibling.probe(controller.signal), null);
	assert.equal(calls, 2);
	await createUpdateCheck(options).probe(controller.signal);
	assert.equal(calls, 2, "offline attempts also back off");
	time += UPDATE_CHECK_INTERVAL_MS + 1;
	await check.probe(controller.signal);
	assert.equal(calls, 3);
});

test("simultaneous sessions share one registry request and one reminder", async (t) => {
	const f = await fixture();
	t.after(f.home.cleanup);
	const controller = new AbortController();
	let calls = 0;
	const fetchVersion = async () => {
		calls++;
		return "0.5.5";
	};
	const checks = [createUpdateCheck({ ...f, fetchVersion }), createUpdateCheck({ ...f, fetchVersion })];
	const notices = await Promise.all(checks.map((check) => check.probe(controller.signal)));
	assert.equal(calls, 1);
	const notice = notices[0];
	assert.ok(notice);
	const claims = await Promise.all(checks.map((check) => check.claim(notice, () => true, controller.signal)));
	assert.equal(claims.filter(Boolean).length, 1);
});

test("detects replacement and same-version rebuilds without consulting the registry", async (t) => {
	const f = await fixture("source");
	t.after(f.home.cleanup);
	const controller = new AbortController();
	const check = createUpdateCheck({
		...f,
		fetchVersion: async () => {
			throw new Error("source check must stay local");
		},
	});
	assert.equal(await check.probe(controller.signal), null);
	await writeFile(join(f.root, "package.json"), '{"name":"@iowarp/clio-coder","version":"0.5.5"}');
	assert.equal((await check.probe(controller.signal))?.kind, "replaced");
	await writeFile(join(f.root, "package.json"), '{"name":"@iowarp/clio-coder","version":"0.5.4"}');
	await utimes(f.entry, new Date(), new Date());
	assert.equal((await check.probe(controller.signal))?.kind, "replaced");
});

test("development, local and unknown installations never check the registry; bad cache data is disposable", async (t) => {
	for (const kind of ["source", "local", "unknown"] as const) {
		const f = await fixture(kind);
		t.after(f.home.cleanup);
		const check = createUpdateCheck({
			...f,
			fetchVersion: async () => {
				throw new Error("unexpected registry request");
			},
		});
		assert.equal(await check.probe(new AbortController().signal), null);
	}
	const f = await fixture();
	t.after(f.home.cleanup);
	const options = { ...f, fetchVersion: async () => "0.5.3" };
	assert.equal(await createUpdateCheck(options).probe(new AbortController().signal), null, "never nudge a downgrade");
	const cache = (await readdir(f.cacheDir)).find((name) => name.endsWith(".json"));
	assert.ok(cache);
	await writeFile(join(f.cacheDir, cache), "{damaged");
	assert.equal(await createUpdateCheck(options).probe(new AbortController().signal), null);
	const repaired = JSON.parse(await readFile(join(f.cacheDir, cache), "utf8"));
	assert.equal(repaired.available, "0.5.3");
});

test("a pending notice waits for idle, hides immediately during work, expires, and can be dismissed", async (t) => {
	const controller = new AbortController();
	t.after(() => controller.abort());
	let idle = false;
	let time = 10_000;
	let probes = 0;
	let claims = 0;
	const notice = { kind: "available" as const, key: "update:1", text: "Update available" };
	const monitor = startUpdateMonitor({
		runningVersion: "0.5.4",
		signal: controller.signal,
		now: () => time,
		isIdle: () => idle,
		onChange: () => {},
		check: {
			probe: async () => {
				probes++;
				return notice;
			},
			claim: async () => {
				claims++;
				return true;
			},
		},
	});
	assert.equal(probes, 0, "creating the monitor does not start a check");
	await monitor.tick();
	assert.equal(monitor.text(), null);
	assert.equal(claims, 0);
	idle = true;
	await monitor.tick();
	assert.equal(monitor.text(), notice.text);
	idle = false;
	assert.equal(monitor.text(), null, "rendering reevaluates busy state without waiting for the next poll");
	idle = true;
	time += 30_001;
	assert.equal(monitor.text(), null);
	await monitor.tick();
	assert.equal(claims, 1);
	time += 60_000;
	await monitor.tick();
	assert.equal(claims, 1, "a reminder appears at most once in this process");
	monitor.dismiss();
	controller.abort();
	assert.equal(monitor.text(), null);
});

test("update failures and shutdown during an in-flight check produce no notice", async (t) => {
	const controller = new AbortController();
	t.after(() => controller.abort());
	let changes = 0;
	const monitor = startUpdateMonitor({
		runningVersion: "0.5.4",
		signal: controller.signal,
		isIdle: () => true,
		onChange: () => {
			changes++;
		},
		check: {
			probe: async () => {
				throw new Error("offline");
			},
			claim: async () => true,
		},
	});
	await monitor.tick();
	assert.equal(changes, 0);
	controller.abort();
	await monitor.tick();
	assert.equal(monitor.text(), null);
});
