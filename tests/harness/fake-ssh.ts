/**
 * Fake `ssh` shim for worker-transport contract tests.
 *
 * The SSH transport treats ssh as an opaque byte channel: argv in, WorkerSpec
 * line on stdin, NDJSON on stdout, diagnostics on stderr, remote exit code as
 * the local exit code. This shim stands in for the real client so the whole
 * channel contract (spawn, stream, steer, permission escalation, abort,
 * stderr tail, exit codes, kill fallback) is exercised without a network.
 *
 * Behavior is selected with FAKE_SSH_SCENARIO (the transport inherits the
 * test's process.env for the local client). Every invocation appends its argv
 * as a JSON line to FAKE_SSH_ARGV_LOG so tests can assert both the primary
 * launch and the remote-kill fallback invocation.
 */

import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SHIM_SOURCE = `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const readline = require("node:readline");

const argv = process.argv.slice(2);
const argvLog = process.env.FAKE_SSH_ARGV_LOG;
if (argvLog) fs.appendFileSync(argvLog, JSON.stringify(argv) + "\\n");

const sep = argv.indexOf("--");
const remoteCommand = sep >= 0 ? argv.slice(sep + 1).join(" ") : "";

// The remote-kill fallback is a plain kill command over a second channel.
if (remoteCommand.startsWith("kill ")) {
	process.exit(0);
}

const scenario = process.env.FAKE_SSH_SCENARIO || "ok";
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const rl = readline.createInterface({ input: process.stdin });

let specSeen = false;
let eofExit = true;

function announce() {
	if (scenario === "require-announce-env" && process.env.CLIO_WORKER_ANNOUNCE !== "1") {
		process.exit(0);
	}
	const value = { type: "worker_announce", pid: process.pid, host: "fake-node", specVersion: scenario === "version-skew" ? 1 : 2 };
	if (scenario === "missing-announce-version") delete value.specVersion;
	emit(value);
}

function assistant(text) {
	emit({ type: "message_end", message: { role: "assistant", content: text, usage: { input: 1, output: 2 } } });
}

rl.on("line", (line) => {
	if (line.trim().length === 0) return;
	if (!specSeen) {
		specSeen = true;
		if (scenario === "no-announce-event") {
			assistant("must not be accepted");
			setTimeout(() => assistant("must not be accepted later"), 50);
			setInterval(() => {}, 1000);
			return;
		}
		if (scenario === "no-announce-exit0") {
			process.exit(0);
		}
		if (scenario === "malformed-first-event") {
			process.stdout.write("{not-json\\n");
			setTimeout(() => announce(), 25);
			setInterval(() => {}, 1000);
			return;
		}
		announce();
		if (scenario === "version-skew" || scenario === "missing-announce-version") {
			setTimeout(() => assistant("must not execute"), 50);
			return;
		}
		if (scenario === "ok" || scenario === "require-announce-env") {
			assistant("remote ok");
			process.exit(0);
		}
		if (scenario === "exit1") {
			process.exit(1);
		}
		if (scenario === "exit3") {
			process.exit(3);
		}
		if (scenario === "exit2") {
			process.stderr.write("[worker] fatal: fake runtime exploded\\n");
			process.exit(2);
		}
		if (scenario === "permission") {
			emit({ type: "clio_permission_escalated", payload: { requestId: "pr-1", tool: "write" } });
		}
		if (scenario === "hang-hard") {
			eofExit = false;
			process.on("SIGTERM", () => {});
			setInterval(() => {}, 1000);
		}
		// "steer", "permission", and "hang" wait for further stdin lines.
		return;
	}
	let value;
	try {
		value = JSON.parse(line);
	} catch {
		return;
	}
	if (value.type === "steer") {
		emit({ type: "clio_steer_received", payload: { text: value.text } });
		assistant("steered: " + value.text);
		process.exit(0);
	}
	if (value.type === "permission_decision") {
		emit({
			type: "clio_permission_resolved",
			payload: { requestId: value.requestId, decision: value.decision === "approve" ? "approved" : "denied", source: "operator", tool: "write" },
		});
		process.exit(0);
	}
});

// Parent-monitor semantics: channel close aborts the remote worker.
rl.on("close", () => {
	if (eofExit) {
		setTimeout(() => process.exit(0), 20);
	}
});
`;

export interface FakeSsh {
	binary: string;
	argvLog: string;
	dir: string;
}

export function installFakeSsh(): FakeSsh {
	const dir = mkdtempSync(join(tmpdir(), "clio-fake-ssh-"));
	const binary = join(dir, "fake-ssh.js");
	const argvLog = join(dir, "argv.log");
	writeFileSync(binary, SHIM_SOURCE, "utf8");
	chmodSync(binary, 0o755);
	writeFileSync(argvLog, "", "utf8");
	return { binary, argvLog, dir };
}
