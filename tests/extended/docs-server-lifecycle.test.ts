import { deepStrictEqual, match, notStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { ensureDocsServer, stopDocsServer } from "../../src/cli/docs-server.js";
import { processAlive, processBirthToken } from "../../src/core/process-identity.js";
import { resolveClioDirs } from "../../src/core/xdg.js";

const repository = resolve(import.meta.dirname, "../..");
const built = existsSync(join(repository, "dist/gui/server.js"));
const skip = built ? false : "dist/gui is not built; run pnpm run build first";

let home: string;
const saved = { home: process.env.CLIO_CODER_HOME };
const registry = () => join(resolveClioDirs().state, "gui", "docs-server.json");
const record = () => JSON.parse(readFileSync(registry(), "utf8")) as { pid: number; birth: string; port: number };

async function gone(pid: number, ms = 8000) {
	const deadline = Date.now() + ms;
	while (processAlive(pid) && Date.now() < deadline) await sleep(50);
	return !processAlive(pid);
}
const meta = (origin: string, token: string) =>
	fetch(`${origin}/api/meta`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3000) });

/** A package root whose server is whatever script the test needs; it never touches the real build. */
function fakePackage(script: string) {
	const root = mkdtempSync(join(home, "package-"));
	mkdirSync(join(root, "dist/gui"), { recursive: true });
	writeFileSync(join(root, "package.json"), '{"name":"fake"}');
	writeFileSync(join(root, "dist/gui/server.js"), script);
	return root;
}

describe("clio-coder docs server lifecycle", { skip }, () => {
	before(() => {
		home = mkdtempSync(join(tmpdir(), "clio-docs-lifecycle-"));
		process.env.CLIO_CODER_HOME = home;
	});
	afterEach(async () => {
		await stopDocsServer().catch(() => undefined);
	});
	after(() => {
		if (saved.home === undefined) delete process.env.CLIO_CODER_HOME;
		else process.env.CLIO_CODER_HOME = saved.home;
		rmSync(home, { recursive: true, force: true });
	});

	it("starts one authenticated loopback server, reuses it, and stops it on request", async () => {
		const first = await ensureDocsServer(repository);
		strictEqual(first.reused, false);
		match(first.origin, /^http:\/\/127\.0\.0\.1:\d+$/u);
		strictEqual((await meta(first.origin, first.token)).status, 200);
		strictEqual((await meta(first.origin, "x".repeat(43))).status, 401, "the launch token is required");
		const page = await fetch(`${first.origin}/docs/architecture/safety-model.md`);
		strictEqual(page.status, 200, "the docs route is served by the app shell");
		strictEqual(statSync(registry()).mode & 0o777, 0o600, "the registry holds a token, so it is private");

		const second = await ensureDocsServer(repository);
		deepStrictEqual([second.reused, second.pid, second.token], [true, first.pid, first.token]);

		deepStrictEqual(await stopDocsServer(), { stopped: true, pid: first.pid });
		ok(await gone(first.pid), "the server process exits");
		ok(!existsSync(registry()), "the registry is removed");
		deepStrictEqual(await stopDocsServer(), { stopped: false });
	});

	it("starts exactly one server when launches race", async () => {
		const launches = await Promise.all(Array.from({ length: 4 }, () => ensureDocsServer(repository)));
		strictEqual(new Set(launches.map((row) => row.pid)).size, 1);
		strictEqual(launches.filter((row) => !row.reused).length, 1);
	});

	it("never signals a process that only reuses the recorded pid, and replaces the record", async () => {
		const bystander = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
		const pid = bystander.pid;
		ok(pid, "bystander started");
		try {
			mkdirSync(join(resolveClioDirs().state, "gui"), { recursive: true });
			writeFileSync(
				registry(),
				JSON.stringify({ v: 1, pid, birth: "not-this-process", port: 9, token: "t".repeat(43), packageRoot: repository }),
			);
			const server = await ensureDocsServer(repository);
			strictEqual(server.reused, false);
			notStrictEqual(server.pid, pid);
			ok(processAlive(pid), "an unrelated process holding the recorded pid is left running");
			ok(processBirthToken(pid) !== null);
		} finally {
			bystander.kill("SIGKILL");
		}
	});

	it("without verified birth tokens, signals only a process that answers with the launch token", async () => {
		const bystander = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
		const pid = bystander.pid;
		ok(pid, "bystander started");
		try {
			mkdirSync(join(resolveClioDirs().state, "gui"), { recursive: true });
			// Off Linux the recorded token is `pid-<n>`, which a reused pid satisfies.
			writeFileSync(
				registry(),
				JSON.stringify({ v: 1, pid, birth: `pid-${pid}`, port: 9, token: "t".repeat(43), packageRoot: repository }),
			);
			const result = await stopDocsServer({ birthVerified: false });
			deepStrictEqual(result, { stopped: false, pid, unverified: true });
			ok(processAlive(pid), "a silent process holding the recorded pid is not signalled");
			ok(!existsSync(registry()), "its record is cleared");

			writeFileSync(
				registry(),
				JSON.stringify({ v: 1, pid, birth: `pid-${pid}`, port: 9, token: "t".repeat(43), packageRoot: repository }),
			);
			const server = await ensureDocsServer(repository, { birthVerified: false });
			strictEqual(server.reused, false);
			ok(processAlive(pid), "replacing the record does not signal the bystander either");

			const again = await ensureDocsServer(repository, { birthVerified: false });
			deepStrictEqual([again.reused, again.pid], [true, server.pid], "an answering server is reused");
			deepStrictEqual(await stopDocsServer({ birthVerified: false }), { stopped: true, pid: server.pid });
			ok(await gone(server.pid), "an answering server is stopped on its own proof");
		} finally {
			bystander.kill("SIGKILL");
		}
	});

	it("replaces a record whose process is gone, is damaged, or belongs to another installation", async () => {
		const dead = spawnSync(process.execPath, ["-e", ""]);
		ok(dead.pid);
		mkdirSync(join(resolveClioDirs().state, "gui"), { recursive: true });
		writeFileSync(
			registry(),
			JSON.stringify({ v: 1, pid: dead.pid, birth: "1", port: 9, token: "t".repeat(43), packageRoot: repository }),
		);
		const first = await ensureDocsServer(repository);
		strictEqual(first.reused, false);
		// A record for another installation is stopped, not silently adopted.
		writeFileSync(registry(), JSON.stringify({ ...record(), packageRoot: join(home, "elsewhere") }));
		const second = await ensureDocsServer(repository);
		strictEqual(second.reused, false);
		ok(await gone(first.pid), "the server of another installation is stopped before its replacement is trusted");
		// A damaged record names nobody to stop, so the old server is left to its idle limit.
		writeFileSync(registry(), "not json");
		const third = await ensureDocsServer(repository);
		strictEqual(third.reused, false, "a damaged record is ignored");
		process.kill(second.pid, "SIGTERM");
		ok(await gone(second.pid));
	});

	it("reports a failed start with the server's own message and leaves nothing behind", async () => {
		const failing = fakePackage('console.error("[clio-coder:gui] port unavailable");process.exit(1);');
		await rejects(ensureDocsServer(failing), /did not start: port unavailable/u);
		ok(!existsSync(registry()));

		const silent = fakePackage("setInterval(() => {}, 1000);");
		const before = Date.now();
		await rejects(ensureDocsServer(silent, { startTimeoutMs: 700 }), /did not start\./u);
		ok(Date.now() - before < 5000, "a server that never reports is abandoned at the deadline");
		ok(!existsSync(registry()));
	});

	it("kills a server that reports an address but does not answer its token", async () => {
		const liar = fakePackage(
			`const server = require("node:http").createServer((_, res) => { res.statusCode = 403; res.end(); });
			server.listen(0, "127.0.0.1", () => {
				console.log("[clio-coder:gui] http://127.0.0.1:" + server.address().port + "/#token=" + "a".repeat(43));
				console.error(process.pid);
			});`,
		);
		await rejects(ensureDocsServer(liar, { startTimeoutMs: 1200 }), /did not answer its launch token/u);
		ok(!existsSync(registry()), "an unverified server is never published");
		const log = readFileSync(join(resolveClioDirs().state, "gui", "docs-server.log"), "utf8");
		const pid = Number(/^(\d+)$/mu.exec(log)?.[1]);
		ok(pid > 0, "the fake server reported its pid");
		ok(await gone(pid), "the unverified server is terminated");
	});

	it("keeps serving after the launching command exits, then exits by itself when idle", async () => {
		const script = `import { ensureDocsServer } from ${JSON.stringify(join(repository, "src/cli/docs-server.ts"))};
			const server = await ensureDocsServer(${JSON.stringify(repository)}, { idleMs: 1500 });
			console.log(JSON.stringify(server));`;
		const launched = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
			cwd: repository,
			env: process.env,
			encoding: "utf8",
			timeout: 30_000,
		});
		strictEqual(launched.status, 0, launched.stderr);
		const server = JSON.parse(launched.stdout.trim().split("\n").pop() ?? "") as {
			origin: string;
			token: string;
			pid: number;
		};
		ok(processAlive(record().pid), "the server outlives the command that started it");
		strictEqual((await meta(server.origin, server.token)).status, 200);
		const session = spawnSync("ps", ["-o", "sid=", "-p", String(server.pid)], { encoding: "utf8" });
		if (session.status === 0)
			notStrictEqual(Number(session.stdout.trim()), process.pid, "the server is detached from this session");

		ok(await gone(server.pid, 10_000), "an idle server stops without a stop command");
		const next = await ensureDocsServer(repository);
		strictEqual(next.reused, false, "the record of an exited server is replaced");
		notStrictEqual(next.pid, server.pid);
	});

	it("does not stop an idle server while a page holds its event stream", async () => {
		const server = await ensureDocsServer(repository, { idleMs: 600 });
		await stopDocsServer();
		ok(await gone(server.pid));
		const held = await ensureDocsServer(repository, { idleMs: 600 });
		const controller = new AbortController();
		const events = await fetch(`${held.origin}/api/events?token=${held.token}`, { signal: controller.signal });
		strictEqual(events.status, 200);
		await sleep(1800);
		ok(processAlive(held.pid), "an open page keeps the server alive past the idle limit");
		controller.abort();
		await events.body?.cancel().catch(() => undefined);
		ok(await gone(held.pid, 8000), "the server stops after the page closes");
	});
});
