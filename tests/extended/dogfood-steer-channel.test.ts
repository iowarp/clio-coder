import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
	appendFileSync,
	chmodSync,
	closeSync,
	constants,
	mkdtempSync,
	openSync,
	rmSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const childScript = `
import readline from "node:readline";
import { syncBuiltinESMExports } from "node:module";
let input;
if (process.argv[2] === "fault") {
  // Capture the real input without replacing the Socket or readline behavior.
  const createInterface = readline.createInterface;
  readline.createInterface = (...args) => {
    input = args[0].input;
    return createInterface(...args);
  };
  syncBuiltinESMExports();
}
const { setupSteerChannel } = await import("./src/cli/steer-channel.ts");
const cleanup = setupSteerChannel(process.argv[1], (line) => process.send({ type: "line", line }));
process.on("message", (command) => {
  if (command !== "cleanup") return;
  if (input) {
    input.emit("error", new Error("controlled FIFO read failure"));
    input.emit("data", Buffer.from("must not steer after failure\\n"));
  }
  cleanup(); cleanup();
  process.send({ type: "cleaned" }, () => process.disconnect());
});
process.send({ type: "ready" });
`;

async function bounded<T>(promise: Promise<T>, description: string, ms = 3000): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(`${description} did not finish within ${ms}ms`)), ms);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

function startReader(path: string, faultOnCleanup = false) {
	const child = spawn(
		process.execPath,
		["--import", "tsx", "--input-type=module", "--eval", childScript, path, faultOnCleanup ? "fault" : "normal"],
		{
			cwd: root,
			stdio: ["ignore", "pipe", "pipe", "ipc"],
		},
	);
	const events: Array<{ type: string; line?: string }> = [];
	let stderr = "";
	ok(child.stderr, "the subprocess exposes its piped diagnostic stream");
	child.stderr.on("data", (chunk) => {
		stderr += String(chunk);
	});
	const listeners = new Set<() => void>();
	child.on("message", (event: { type: string; line?: string }) => {
		events.push(event);
		for (const listener of listeners) listener();
	});
	const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code, signal) => resolve({ code, signal }));
	});
	const waitFor = async (predicate: () => boolean, description: string) => {
		let listener: () => void = () => {};
		try {
			await bounded(
				new Promise<void>((resolve) => {
					listener = () => {
						if (predicate()) resolve();
					};
					listeners.add(listener);
					listener();
				}),
				description,
			);
		} finally {
			listeners.delete(listener);
		}
	};
	return {
		lines: () => events.filter((event) => event.type === "line").map((event) => event.line),
		ready: () => waitFor(() => events.some((event) => event.type === "ready"), "channel setup"),
		linesReceived: (count: number) =>
			waitFor(() => events.filter((event) => event.type === "line").length >= count, "steering delivery"),
		async cleanup() {
			child.send("cleanup");
			await Promise.race([
				waitFor(() => events.some((event) => event.type === "cleaned"), "cleanup acknowledgement"),
				exited.then((result) => {
					deepStrictEqual(result, { code: 0, signal: null }, stderr);
				}),
			]);
			const result = await bounded(exited, "normal process exit after cleanup with writer state unchanged");
			deepStrictEqual(result, { code: 0, signal: null }, stderr);
			strictEqual(
				stderr,
				faultOnCleanup ? "clio-coder run: failed to setup steer channel: controlled FIFO read failure\n" : "",
			);
		},
		async dispose() {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			await bounded(exited, "owned fixture process cleanup");
		},
	};
}

it("FIFO input errors forwarded by readline report once and exit normally without late steering", {
	skip: process.platform === "win32",
	timeout: 10_000,
}, async () => {
	const scratch = mkdtempSync(join(tmpdir(), "dog-fifo-error-"));
	const fifo = join(scratch, "steer.fifo");
	let reader: ReturnType<typeof startReader> | undefined;
	let writer: number | undefined;
	try {
		const created = spawnSync("mkfifo", [fifo]);
		strictEqual(created.status, 0, created.stderr?.toString());
		writer = openSync(fifo, constants.O_RDWR | constants.O_NONBLOCK);
		reader = startReader(fifo, true);
		await reader.ready();
		writeSync(writer, "before failure\n");
		await reader.linesReceived(1);
		await reader.cleanup();
		deepStrictEqual(reader.lines(), ["before failure"]);
	} finally {
		await reader?.dispose();
		if (writer !== undefined) closeSync(writer);
		rmSync(scratch, { recursive: true, force: true });
	}
});

for (const connect of ["before startup", "after startup", "never", "with read-only FIFO permissions"] as const) {
	it(`FIFO steering cleans up and exits normally with writer connected ${connect}`, {
		skip: process.platform === "win32",
		timeout: 12_000,
	}, async () => {
		const scratch = mkdtempSync(join(tmpdir(), "dog-fifo-"));
		const fifo = join(scratch, "steer.fifo");
		let writer: number | undefined;
		let reader: ReturnType<typeof startReader> | undefined;
		try {
			const created = spawnSync("mkfifo", [fifo]);
			strictEqual(created.status, 0, created.stderr?.toString());
			if (connect === "before startup" || connect === "with read-only FIFO permissions") {
				writer = openSync(fifo, constants.O_RDWR | constants.O_NONBLOCK);
				if (connect === "with read-only FIFO permissions") chmodSync(fifo, 0o400);
			}
			reader = startReader(fifo);
			await reader.ready();
			// Let an empty reader reach its pending read before late connection or
			// cleanup. The open writer stays in this parent until the child exits.
			await delay(100);
			if (connect === "after startup") writer = openSync(fifo, constants.O_RDWR | constants.O_NONBLOCK);
			if (writer !== undefined) {
				writeSync(writer, "  switch to src/mathx.py  \r\n\n");
				await reader.linesReceived(1);
				deepStrictEqual(reader.lines(), ["switch to src/mathx.py"]);
				await delay(100);
			}
			await reader.cleanup();
			if (writer !== undefined)
				ok(writeSync(writer, "after cleanup\n") > 0, "the parent's FIFO writer was still open at normal child exit");
			deepStrictEqual(reader.lines(), connect === "never" ? [] : ["switch to src/mathx.py"]);
		} finally {
			await reader?.dispose();
			if (writer !== undefined) closeSync(writer);
			rmSync(scratch, { recursive: true, force: true });
		}
	});
}

it("FIFO writer EOF delivers the final unterminated line and closes the read side", {
	skip: process.platform === "win32",
	timeout: 10_000,
}, async () => {
	const scratch = mkdtempSync(join(tmpdir(), "dog-fifo-eof-"));
	const fifo = join(scratch, "steer.fifo");
	let reader: ReturnType<typeof startReader> | undefined;
	let writer: number | undefined;
	try {
		const created = spawnSync("mkfifo", [fifo]);
		strictEqual(created.status, 0, created.stderr?.toString());
		reader = startReader(fifo);
		await reader.ready();
		writer = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
		writeSync(writer, "  last line at EOF  ");
		closeSync(writer);
		writer = undefined;
		await reader.linesReceived(1);
		deepStrictEqual(reader.lines(), ["last line at EOF"]);
		await delay(100);
		throws(
			() => {
				const fd = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
				closeSync(fd);
			},
			{ code: "ENXIO" },
			"the original EOF behavior closes the channel until a new run starts",
		);
		await reader.cleanup();
	} finally {
		await reader?.dispose();
		if (writer !== undefined) closeSync(writer);
		rmSync(scratch, { recursive: true, force: true });
	}
});

it("regular appended steering preserves initial lines, partial-line framing, and normal cleanup", {
	timeout: 10_000,
}, async () => {
	const scratch = mkdtempSync(join(tmpdir(), "dog-append-"));
	const path = join(scratch, "steer.txt");
	writeFileSync(path, "  initial  \r\nunfinished");
	const reader = startReader(path);
	try {
		await reader.ready();
		await reader.linesReceived(1);
		deepStrictEqual(reader.lines(), ["initial"]);
		appendFileSync(path, " line\n\n next \n");
		await reader.linesReceived(3);
		deepStrictEqual(reader.lines(), ["initial", "unfinished line", "next"]);
		await reader.cleanup();
		appendFileSync(path, "after cleanup\n");
		deepStrictEqual(reader.lines(), ["initial", "unfinished line", "next"]);
	} finally {
		await reader.dispose();
		rmSync(scratch, { recursive: true, force: true });
	}
});
