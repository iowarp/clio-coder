import { match, strictEqual } from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { test } from "node:test";
import { createFleetEventJournal } from "../../src/domains/dispatch/fleet-event-journal.js";
import { openLedger } from "../../src/domains/dispatch/state.js";
import { ensureClioState } from "../../src/domains/lifecycle/index.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

test("closed stdout quietly ends fleet journals, followers, trace JSON, and root help with SIGPIPE status", async () => {
	const env = await isolateClioEnv("cli-broken-pipe-");
	try {
		const rootId = "fleet-closed-pipe";
		const journal = createFleetEventJournal(rootId);
		journal.append({
			type: "fleet_started",
			fleet: "pipe",
			planHash: "a".repeat(64),
			vars: {},
			resumedFrom: null,
			replayedStepIds: [],
			workspaceRoot: env.dir,
			stepIds: [],
		});
		journal.append({
			type: "fleet_sealed",
			outcome: "succeeded",
			endedAt: "2026-10-16T00:00:00.000Z",
			stepCount: 0,
			manifestDigest: "b".repeat(64),
		});
		for (const args of [
			["fleet", "events", rootId, "--json"],
			["fleet", "events", rootId, "--json", "--follow"],
			["fleet", "code-steps", rootId, "--json"],
			["agents"],
			["paths"],
			// Root help and version answer before dispatch; they end as subcommand help does (FX-23).
			["agents", "--help"],
			["--help"],
			["-h"],
			["--help", "--all"],
			["help"],
			["--version"],
		]) {
			const child = spawn(process.execPath, [resolve("dist/cli/index.js"), ...args], {
				cwd: process.cwd(),
				env: { ...process.env, HOME: env.dir },
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stderr = "";
			child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
				stderr += chunk;
			});
			const closed = new Promise<number | null>((accept, reject) => {
				child.once("error", reject);
				child.once("close", accept);
			});
			child.stdout.destroy();
			strictEqual(await closed, 141, args.join(" "));
			strictEqual(stderr, "", args.join(" "));
		}
	} finally {
		env.restore();
	}
});

test("fleet status --json ends with SIGPIPE status when its reader takes one byte and closes (SPEC L7a)", async () => {
	const env = await isolateClioEnv("cli-status-pipe-");
	try {
		ensureClioState();
		const ledger = openLedger({ maxRuns: 1000 });
		// Enough running rows that the one document outgrows the pipe buffer, so the write is pending when the reader closes.
		for (let i = 0; i < 600; i += 1) {
			const row = ledger.create({
				agentId: "scout",
				executionRole: "researcher",
				task: `closed reader ${i}`,
				targetId: "local",
				wireModelId: "model",
				runtimeId: "openai",
				runtimeKind: "http",
				sessionId: null,
				cwd: env.dir,
			});
			ledger.update(row.id, { status: "running" });
		}
		await ledger.persist();
		const child = spawn(process.execPath, [resolve("dist/cli/index.js"), "fleet", "status", "--json", "--all"], {
			cwd: env.dir,
			env: { ...process.env, HOME: env.dir },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stderr = "";
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
			stderr += chunk;
		});
		const closed = new Promise<number | null>((accept, reject) => {
			child.once("error", reject);
			child.once("close", accept);
		});
		const first = await new Promise<string>((accept) => {
			child.stdout.once("readable", () => accept(String(child.stdout.read(1))));
		});
		child.stdout.destroy();
		strictEqual(first, "{");
		strictEqual(await closed, 141, stderr);
		strictEqual(stderr, "");
	} finally {
		env.restore();
	}
});

for (const command of ["acp", "worker"]) {
	test(`${command} owns its stdout errors without a CLI handler`, async () => {
		const env = await isolateClioEnv(`cli-${command}-stdout-`);
		try {
			const script = `
				const before = process.stdout.listeners("error");
				process.argv = [process.execPath, "clio-coder", ${JSON.stringify(command)}, "--help"];
				await import(${JSON.stringify(resolve("src/cli/index.ts"))});
				const added = process.stdout.listeners("error").filter((listener) => !before.includes(listener) && listener.name !== "onerror");
				process.exit(added.length === 0 ? 0 : 91);
			`;
			const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
				env: { ...process.env, HOME: env.dir },
				stdio: "ignore",
			});
			strictEqual(await new Promise((accept) => child.once("close", accept)), 0);
		} finally {
			env.restore();
		}
	});
}

test("main reports an EPIPE rejection that was not emitted by stdout", async () => {
	const env = await isolateClioEnv("cli-upstream-epipe-");
	try {
		const script = `
			process.stdout.write = () => { throw Object.assign(new Error("upstream pipe failed"), {code: "EPIPE"}); };
			process.argv = [process.execPath, "clio-coder", "fleet", "code-steps", "missing", "--json"];
			await import(${JSON.stringify(resolve("src/cli/index.ts"))});
		`;
		const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
			env: { ...process.env, HOME: env.dir },
			stdio: ["ignore", "ignore", "pipe"],
		});
		let stderr = "";
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
			stderr += chunk;
		});
		strictEqual(await new Promise((accept) => child.once("close", accept)), 1);
		match(stderr, /upstream pipe failed/);
	} finally {
		env.restore();
	}
});
