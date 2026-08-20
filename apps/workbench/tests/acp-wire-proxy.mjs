import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { Transform } from "node:stream";

const [logPath, ...childArgs] = process.argv.slice(2);
if (logPath === undefined || childArgs.length === 0) {
	process.stderr.write("usage: acp-wire-proxy.mjs LOG_PATH CLI_ARGS...\n");
	process.exit(2);
}

const log = createWriteStream(logPath, { flags: "a", mode: 0o600 });
const child = spawn(process.execPath, childArgs, {
	cwd: process.cwd(),
	env: process.env,
	stdio: ["pipe", "pipe", "pipe"],
});

let buffered = "";
const tap = new Transform({
	transform(chunk, _encoding, callback) {
		buffered += chunk.toString("utf8");
		for (;;) {
			const newline = buffered.indexOf("\n");
			if (newline < 0) break;
			log.write(`${buffered.slice(0, newline)}\n`);
			buffered = buffered.slice(newline + 1);
		}
		callback(null, chunk);
	},
	flush(callback) {
		if (buffered.length > 0) log.write(`${buffered}\n`);
		callback();
	},
});

process.stdin.pipe(tap).pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.once("error", (error) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
child.once("close", (code, signal) => {
	log.end(() => {
		if (signal !== null) process.kill(process.pid, signal);
		else process.exit(code ?? 1);
	});
});
