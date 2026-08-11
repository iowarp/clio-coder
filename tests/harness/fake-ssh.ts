/**
 * Fake `ssh` shim and fake worker entry for worker-transport contract tests.
 *
 * The SSH transport treats ssh as an opaque byte channel: argv in, WorkerSpec
 * line on stdin, bulk NDJSON on stdout, the structured control lane plus
 * diagnostics on stderr, remote exit code as the local exit code. This shim
 * stands in for the real client so the whole channel contract (spawn, attest,
 * stream, steer, permission escalation, backpressure, abort, stderr tail, exit
 * codes, process-group kill fallback) is exercised without a network.
 *
 * The shim recomputes the WorkerSpec digest from the bytes it received, using
 * the same canonical encoding as the orchestrator. That is the point of the
 * attestation: the peer proves it parsed the document that was actually sent,
 * not a document it was told about.
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
const crypto = require("node:crypto");
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
const CONTROL_PREFIX = "@clio-control/1 ";
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
// process.exit truncates buffered stdout mid-line, which would lose exactly the
// frames the backpressure scenarios exist to observe. Flush, then exit.
const exitFlushed = (code) => { process.stdout.write("", () => process.exit(code)); };
const control = (frame) => process.stderr.write(CONTROL_PREFIX + JSON.stringify(frame) + "\\n");
const rl = readline.createInterface({ input: process.stdin });

let specSeen = false;
let eofExit = true;

function canonicalJson(value) {
	if (value === null) return "null";
	if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
	if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
	if (Array.isArray(value)) return "[" + value.map((e) => (e === undefined ? "null" : canonicalJson(e))).join(",") + "]";
	if (typeof value === "object") {
		const parts = [];
		for (const key of Object.keys(value).sort()) {
			if (value[key] === undefined) continue;
			parts.push(JSON.stringify(key) + ":" + canonicalJson(value[key]));
		}
		return "{" + parts.join(",") + "}";
	}
	return "null";
}

function sha256(text) {
	return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function endpointIdentityHash(url) {
	if (url === undefined || String(url).trim().length === 0) return sha256("clio.endpoint:none");
	const raw = String(url).trim();
	let canonical;
	try {
		const parsed = new URL(raw);
		canonical = parsed.protocol + "//" + parsed.hostname + ":" + parsed.port + parsed.pathname.replace(/\\/+$/, "");
	} catch {
		canonical = raw.replace(/\\/+$/, "");
	}
	return sha256("clio.endpoint:" + canonical);
}

function announce(spec) {
	const attestation = {
		protocolVersion: 1,
		specVersion: scenario === "version-skew" ? 2 : spec.specVersion,
		pid: process.pid,
		processGroupId: Number.parseInt(process.env.CLIO_WORKER_PGID || "", 10) || process.pid,
		host: "fake-node",
		settingsFingerprint: scenario === "settings-drift" ? sha256("a different settings snapshot") : spec.settingsFingerprint,
		specDigest: scenario === "spec-drift" ? sha256("a different spec") : sha256("clio.workerSpec:" + canonicalJson(spec)),
		runtimeId: spec.runtimeId,
		targetId: scenario === "target-drift" ? "some-other-target" : spec.target.id,
		endpointIdentityHash: endpointIdentityHash(spec.target.url),
		wireModelId: spec.wireModelId,
		toolSignature:
			scenario === "tool-drift"
				? sha256("clio.tools:a-different-tool-surface")
				: sha256("clio.tools:" + [...(spec.allowedTools || [])].sort().join(",")),
		resources: {
			labels: (process.env.CLIO_WORKER_LABELS || "").split(",").filter((l) => l.length > 0),
			cpuCount: { known: true, value: 8 },
			totalMemoryBytes: { known: true, value: 17179869184 },
			freeMemoryBytes: { known: true, value: 8589934592 },
			gpuCount: { known: false },
			vramBytes: { known: false },
			residentModels: { known: false },
		},
	};
	if (scenario === "missing-announce-version") delete attestation.specVersion;
	if (scenario === "oversized-control") attestation.host = "x".repeat(32 * 1024);
	control({ kind: "announce", attestation });
}

function assistant(text) {
	emit({ type: "message_end", message: { role: "assistant", content: text, usage: { input: 1, output: 2 } } });
}

rl.on("line", (line) => {
	if (line.trim().length === 0) return;
	if (!specSeen) {
		specSeen = true;
		let spec;
		try {
			spec = JSON.parse(line);
		} catch {
			process.exit(2);
		}
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
			process.stderr.write(CONTROL_PREFIX + "{not-json\\n");
			setTimeout(() => announce(spec), 25);
			setInterval(() => {}, 1000);
			return;
		}
		announce(spec);
		if (
			scenario === "version-skew" ||
			scenario === "missing-announce-version" ||
			scenario === "settings-drift" ||
			scenario === "spec-drift" ||
			scenario === "target-drift" ||
			scenario === "tool-drift" ||
			scenario === "oversized-control"
		) {
			setTimeout(() => assistant("must not execute"), 50);
			return;
		}
		if (scenario === "ok") {
			assistant("remote ok");
			process.exit(0);
		}
		if (scenario === "oversized-bulk") {
			// One frame far past the bulk lane ceiling, then a normal frame. The
			// oversized line must be discarded and the normal one still delivered.
			process.stdout.write(JSON.stringify({ type: "note", filler: "x".repeat(5 * 1024 * 1024) }) + "\\n");
			assistant("after the oversized frame");
			exitFlushed(0);
			return;
		}
		if (scenario === "display-flood") {
			// More display frames than the queue can hold, then the evidence frame
			// that must survive the drop policy.
			for (let i = 0; i < 6000; i += 1) emit({ type: "message_update", index: i });
			emit({ type: "clio_run_outcome", payload: { outcomeCode: "worker_final_output_missing" } });
			assistant("evidence survives");
			exitFlushed(0);
			return;
		}
		if (scenario === "bulk-flood") {
			// Saturate stdout, then prove the control lane still answers by
			// beating and acknowledging a cancellation on stderr.
			for (let i = 0; i < 4000; i += 1) emit({ type: "message_update", index: i, filler: "y".repeat(512) });
			control({ kind: "heartbeat", at: Date.now() });
			control({ kind: "cancel_ack", at: Date.now() });
			assistant("flood done");
			exitFlushed(0);
			return;
		}
		if (scenario === "deaf-stdin") {
			// Stop consuming stdin without closing it, so writes back up in the
			// orchestrator's queue instead of failing fast with EPIPE.
			rl.pause();
			process.stdin.pause();
			eofExit = false;
			setInterval(() => {}, 1000);
			return;
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
		if (scenario === "group-descendant") {
			// A descendant in the same process group, of the kind a subprocess
			// runtime spawns. Killing only the immediate child would strand it.
			const child = require("node:child_process").spawn(
				process.execPath,
				["-e", "setInterval(() => {}, 1000)"],
				{ stdio: "ignore" },
			);
			fs.appendFileSync(process.env.FAKE_SSH_DESCENDANT_LOG || "/dev/null", child.pid + "\\n");
			eofExit = false;
			process.on("SIGTERM", () => {});
			setInterval(() => {}, 1000);
		}
		// "steer", "permission", "hang", and "deaf-stdin" wait for further lines.
		return;
	}
	let value;
	try {
		value = JSON.parse(line);
	} catch {
		return;
	}
	if (value.type === "steer") {
		control({ kind: "steer_ack", sequence: 1 });
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
	descendantLog: string;
	dir: string;
}

export function installFakeSsh(): FakeSsh {
	const dir = mkdtempSync(join(tmpdir(), "clio-fake-ssh-"));
	const binary = join(dir, "fake-ssh.js");
	const argvLog = join(dir, "argv.log");
	const descendantLog = join(dir, "descendants.log");
	writeFileSync(binary, SHIM_SOURCE, "utf8");
	chmodSync(binary, 0o755);
	writeFileSync(argvLog, "", "utf8");
	writeFileSync(descendantLog, "", "utf8");
	return { binary, argvLog, descendantLog, dir };
}
