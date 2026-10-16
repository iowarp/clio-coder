import { strict as assert } from "node:assert";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { pathToFileURL } from "node:url";
import { processBirthToken } from "../../src/core/process-identity.js";
import {
	acquireFleetWorkspaceLock,
	FleetWorkspaceBusyError,
	fleetWorkspaceLockPath,
} from "../../src/domains/dispatch/fleet-workspace-lock.js";
import { type IsolatedClioEnv, isolateClioEnv, scratchClioEnvVars } from "../harness/scratch-env.js";

const LOCK_MODULE = pathToFileURL(resolve("src/domains/dispatch/fleet-workspace-lock.ts")).href;

/** A separate process that takes the workspace lock for `rootId` and holds it until killed. */
function holdInChild(home: string, workspaceRoot: string, rootId: string): Promise<ChildProcess> {
	const script = `const m = await import(${JSON.stringify(LOCK_MODULE)});
await m.acquireFleetWorkspaceLock({ workspaceRoot: ${JSON.stringify(workspaceRoot)}, rootId: ${JSON.stringify(rootId)} });
process.stdout.write("held\\n");
setInterval(() => {}, 60_000);`;
	const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
		env: { ...process.env, ...scratchClioEnvVars(home) },
		stdio: ["ignore", "pipe", "pipe"],
	});
	return new Promise((resolveChild, reject) => {
		let stderr = "";
		child.stderr?.on("data", (chunk) => {
			stderr += String(chunk);
		});
		child.stdout?.on("data", (chunk) => {
			if (String(chunk).includes("held")) resolveChild(child);
		});
		child.once("exit", (code) => reject(new Error(`holder exited ${code} before taking the lock: ${stderr}`)));
	});
}

/** A separate process's attempt to take the workspace lock: "busy" when refused, "took" when it won. */
function tryInChild(home: string, workspaceRoot: string, rootId: string): string {
	const script = `const m = await import(${JSON.stringify(LOCK_MODULE)});
try {
	await m.acquireFleetWorkspaceLock({ workspaceRoot: ${JSON.stringify(workspaceRoot)}, rootId: ${JSON.stringify(rootId)} });
	process.stdout.write("took");
} catch (error) {
	process.stdout.write(error instanceof m.FleetWorkspaceBusyError ? "busy" : String(error));
}
process.exit(0);`;
	return execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
		env: { ...process.env, ...scratchClioEnvVars(home) },
		encoding: "utf8",
	});
}

describe("fleet workspace lock across processes", () => {
	let env: IsolatedClioEnv;
	let holder: ChildProcess | null = null;

	beforeEach(async () => {
		env = await isolateClioEnv("clio-coder-fleet-lock-");
	});

	afterEach(() => {
		mock.timers.reset();
		holder?.kill("SIGKILL");
		holder = null;
		env.restore();
	});

	it("refuses a second fleet while another process holds the workspace and reclaims the lock once it dies", async () => {
		const workspaceRoot = join(env.dir, "checkout");
		mkdirSync(workspaceRoot);
		holder = await holdInChild(env.dir, workspaceRoot, "fleet-held");
		const holderPid = holder.pid;

		await assert.rejects(acquireFleetWorkspaceLock({ workspaceRoot, rootId: "fleet-second" }), (error: unknown) => {
			assert.ok(error instanceof FleetWorkspaceBusyError);
			assert.equal(error.holder.rootId, "fleet-held");
			assert.equal(error.holder.pid, holderPid);
			assert.match(error.message, /root=fleet-held/);
			assert.match(error.message, new RegExp(`pid ${holderPid}\\b`));
			// The refused run never existed, so its minted id is not announced.
			assert.doesNotMatch(error.message, /fleet-second/);
			return true;
		});

		// Killed without unwinding, the holder leaves its record behind.
		const exited = new Promise((done) => holder?.once("exit", done));
		holder.kill("SIGKILL");
		await exited;
		holder = null;
		assert.ok(existsSync(fleetWorkspaceLockPath(workspaceRoot)));

		const lease = await acquireFleetWorkspaceLock({ workspaceRoot, rootId: "fleet-second" });
		await assert.rejects(
			acquireFleetWorkspaceLock({ workspaceRoot, rootId: "fleet-third" }),
			(error: unknown) => error instanceof FleetWorkspaceBusyError && error.holder.rootId === "fleet-second",
		);
		await lease.release();
		assert.equal(existsSync(fleetWorkspaceLockPath(workspaceRoot)), false);
	});

	it("keys the lock on the git checkout so a subdirectory and the checkout root share it", async () => {
		const workspaceRoot = join(env.dir, "checkout");
		const subdir = join(workspaceRoot, "apps", "gui");
		mkdirSync(subdir, { recursive: true });
		execFileSync("git", ["init", "-q", workspaceRoot]);
		const lease = await acquireFleetWorkspaceLock({ workspaceRoot: subdir, rootId: "fleet-sub" });
		await assert.rejects(
			acquireFleetWorkspaceLock({ workspaceRoot, rootId: "fleet-top" }),
			(error: unknown) => error instanceof FleetWorkspaceBusyError && error.holder.rootId === "fleet-sub",
		);
		await lease.release();
	});

	it("lets the same process take the workspace again after its release failed", async () => {
		const workspaceRoot = join(env.dir, "checkout");
		mkdirSync(workspaceRoot);
		const lockDir = dirname(fleetWorkspaceLockPath(workspaceRoot));
		const lease = await acquireFleetWorkspaceLock({ workspaceRoot, rootId: "fleet-first" });
		// An unwritable lock directory fails the release and leaves the record naming this live process.
		chmodSync(lockDir, 0o500);
		try {
			await assert.rejects(lease.release());
		} finally {
			chmodSync(lockDir, 0o700);
		}
		assert.ok(existsSync(fleetWorkspaceLockPath(workspaceRoot)));

		const next = await acquireFleetWorkspaceLock({ workspaceRoot, rootId: "fleet-next" });
		await next.release();
		assert.equal(existsSync(fleetWorkspaceLockPath(workspaceRoot)), false);
	});

	it("refuses a record it cannot read instead of overwriting it", async () => {
		const workspaceRoot = join(env.dir, "checkout");
		mkdirSync(workspaceRoot);
		const path = fleetWorkspaceLockPath(workspaceRoot);
		mkdirSync(dirname(path), { recursive: true });
		const future = `${JSON.stringify({ version: 2, rootId: "fleet-newer" })}\n`;
		writeFileSync(path, future);
		await assert.rejects(acquireFleetWorkspaceLock({ workspaceRoot, rootId: "fleet-older" }), (error: unknown) => {
			assert.ok(error instanceof Error);
			assert.ok(error.message.includes(path));
			return true;
		});
		assert.equal(readFileSync(path, "utf8"), future);
	});

	it("reclaims another host's record once its holder stops refreshing it, refuses while it is fresh and treats a same-pid twin as foreign", async () => {
		const workspaceRoot = join(env.dir, "checkout");
		mkdirSync(workspaceRoot);
		const path = fleetWorkspaceLockPath(workspaceRoot);
		mkdirSync(dirname(path), { recursive: true });
		const foreign = {
			version: 1,
			workspaceRoot,
			rootId: "fleet-elsewhere",
			host: "another-host.invalid",
			processOwner: { pid: 4242, processBirthToken: "foreign-token", acquiredAt: "2026-01-01T00:00:00.000Z" },
		};
		writeFileSync(path, `${JSON.stringify(foreign)}\n`);
		await assert.rejects(acquireFleetWorkspaceLock({ workspaceRoot, rootId: "fleet-fresh" }), (error: unknown) => {
			assert.ok(error instanceof FleetWorkspaceBusyError);
			assert.equal(error.holder.rootId, "fleet-elsewhere");
			assert.ok(error.message.includes(path));
			return true;
		});

		const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);
		utimesSync(path, anHourAgo, anHourAgo);
		const lease = await acquireFleetWorkspaceLock({ workspaceRoot, rootId: "fleet-takeover" });
		assert.equal(JSON.parse(readFileSync(path, "utf8")).rootId, "fleet-takeover");
		// A failed release leaves a retry pending for this path.
		chmodSync(dirname(path), 0o500);
		try {
			await assert.rejects(lease.release());
		} finally {
			chmodSync(dirname(path), 0o700);
		}

		// Another host sharing this home can carry this process's pid and token (macOS falls back to pid-<n>).
		const twin = {
			...foreign,
			rootId: "fleet-twin",
			processOwner: {
				pid: process.pid,
				processBirthToken: processBirthToken(),
				acquiredAt: foreign.processOwner.acquiredAt,
			},
		};
		writeFileSync(path, `${JSON.stringify(twin)}\n`);
		// Acquisition runs the pending retry first, which must not delete the twin's record.
		await assert.rejects(
			acquireFleetWorkspaceLock({ workspaceRoot, rootId: "fleet-fresh" }),
			(error: unknown) => error instanceof FleetWorkspaceBusyError && error.holder.rootId === "fleet-twin",
		);
		assert.equal(JSON.parse(readFileSync(path, "utf8")).rootId, "fleet-twin");

		utimesSync(path, anHourAgo, anHourAgo);
		const reclaimed = await acquireFleetWorkspaceLock({ workspaceRoot, rootId: "fleet-after-twin" });
		assert.equal(JSON.parse(readFileSync(path, "utf8")).rootId, "fleet-after-twin");
		await reclaimed.release();
	});

	it("keeps refreshing its own record after the host name changes so another process still refuses", async () => {
		const workspaceRoot = join(env.dir, "checkout");
		mkdirSync(workspaceRoot);
		const path = fleetWorkspaceLockPath(workspaceRoot);
		mock.timers.enable({ apis: ["setInterval"] });
		const lease = await acquireFleetWorkspaceLock({ workspaceRoot, rootId: "fleet-renamed" });
		// The record keeps the host name from acquisition time while hostname() now answers differently.
		const record = JSON.parse(readFileSync(path, "utf8"));
		writeFileSync(path, `${JSON.stringify({ ...record, host: "before-rename.invalid" })}\n`);
		const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);
		utimesSync(path, anHourAgo, anHourAgo);

		mock.timers.tick(30_000);
		assert.ok(statSync(path).mtimeMs > anHourAgo.getTime(), "the refresh must still touch this process's record");
		assert.equal(tryInChild(env.dir, workspaceRoot, "fleet-intruder"), "busy");

		await lease.release();
		assert.equal(existsSync(path), false);
	});
});
