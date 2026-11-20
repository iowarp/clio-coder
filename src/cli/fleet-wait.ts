/**
 * `clio-coder fleet wait <fleetRootId>`: block until a fleet root seals, then print the fleet result its owner persisted
 * and exit with that result's own exit code.
 *
 * The waiter never reconstructs an exit from the journal's seal outcome; it prints the document the owner wrote at
 * seal, which is the one a foreground `fleet run --output-format json` printed. A root whose owner died without
 * sealing exits 1 with cause `owner_gone`; `--timeout` expiring while the root still runs exits 75.
 */

import { setTimeout as sleep } from "node:timers/promises";
import {
	type FleetRootRecord,
	fleetRootState,
	matchFleetRootIds,
	readFleetResult,
	readFleetRootRecord,
} from "../domains/dispatch/fleet-root-record.js";
import { ensureClioState } from "../domains/lifecycle/index.js";
import { parseDuration } from "./kit/duration.js";
import { EXIT_CODES } from "./kit/exit-codes.js";
import { writeCliFailure } from "./kit/json-out.js";

const USAGE = "usage: clio-coder fleet wait <fleetRootId> [--timeout <duration>] [--json]";
const POLL_MS = 250;
const PATH = ["fleet", "wait"] as const;

interface WaitArgs {
	token: string;
	json: boolean;
	timeoutMs: number | null;
}

function parseArgs(args: ReadonlyArray<string>): WaitArgs | string {
	let token: string | undefined;
	let json = false;
	let timeout: string | undefined;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === undefined) continue;
		if (arg === "--json") json = true;
		else if (arg === "--timeout" || arg.startsWith("--timeout=")) {
			if (timeout !== undefined) return "--timeout given more than once";
			const value = arg === "--timeout" ? args[index + 1] : arg.slice("--timeout=".length);
			if (value === undefined || value.length === 0 || (arg === "--timeout" && value.startsWith("-"))) {
				return "--timeout requires a value";
			}
			timeout = value;
			if (arg === "--timeout") index += 1;
		} else if (arg.startsWith("-")) return `unknown flag: ${arg}`;
		else if (token === undefined) token = arg;
		else return `unexpected argument: ${arg}`;
	}
	if (token === undefined) return "missing <fleetRootId>";
	let timeoutMs: number | null = null;
	if (timeout !== undefined) {
		const parsed = parseDuration(timeout, { bareUnit: "s" });
		if (!parsed.ok) return `--timeout: ${parsed.message}`;
		timeoutMs = parsed.ms;
	}
	return { token, json, timeoutMs };
}

/** A fleet result for a root that has none persisted: its owner is gone, or the wait gave up while it runs. */
function unsettledDocument(
	record: FleetRootRecord,
	exitCode: number,
	completion: { state: "stopped" | "accepted"; stopReason: string | null },
	cause: Record<string, unknown>,
): Record<string, unknown> {
	return {
		type: "fleet_end",
		schemaVersion: 1,
		rootId: record.rootId,
		playbook: record.playbook,
		planHash: null,
		exitCode,
		completion,
		// Nothing sealed, so there is no verdict to report.
		verdict: null,
		usage: null,
		cost: null,
		causes: [cause],
		limits: null,
	};
}

function writeDocument(document: Record<string, unknown>, json: boolean): void {
	if (json) {
		process.stdout.write(`${JSON.stringify(document)}\n`);
		return;
	}
	const completion = document.completion as { state?: unknown; stopReason?: unknown } | undefined;
	const verdict = document.verdict as { aggregate?: unknown } | null | undefined;
	const causes = Array.isArray(document.causes) ? (document.causes as Array<{ code?: unknown }>) : [];
	const stop = typeof completion?.stopReason === "string" ? ` (${completion.stopReason})` : "";
	process.stdout.write(
		`fleet ${String(document.playbook)}: ${String(completion?.state)}${stop} verdict=${verdict?.aggregate ?? "none"} exit=${String(document.exitCode)} root=${String(document.rootId)}${causes.length > 0 ? ` causes=${causes.map((cause) => String(cause.code)).join(",")}` : ""}\n`,
	);
}

function resultExitCode(document: Record<string, unknown>): number {
	const code = document.exitCode;
	return typeof code === "number" && Number.isInteger(code) && code >= 0 && code <= 255 ? code : 1;
}

export async function runFleetWait(args: ReadonlyArray<string>): Promise<number> {
	const parsed = parseArgs(args);
	if (typeof parsed === "string") {
		const json = args.includes("--json");
		writeCliFailure({
			path: PATH,
			slug: parsed.startsWith("unknown flag") ? "unknown_flag" : "usage",
			message: parsed,
			json,
		});
		if (!json) process.stderr.write(`${USAGE}\n`);
		return 2;
	}
	const { token, json, timeoutMs } = parsed;
	ensureClioState();
	const matches = matchFleetRootIds(token);
	if (matches.length > 1) {
		writeCliFailure({
			path: PATH,
			slug: "ambiguous",
			message: `'${token}' matches ${matches.length} fleet roots: ${matches.slice(0, 5).join(", ")}${matches.length > 5 ? ", ..." : ""}`,
			json,
		});
		return 1;
	}
	const rootId = matches[0];
	if (rootId === undefined) {
		writeCliFailure({ path: PATH, slug: "not_found", message: `no fleet root matches '${token}'`, json });
		return 1;
	}
	const deadline = timeoutMs === null ? null : Date.now() + timeoutMs;
	for (;;) {
		const result = readFleetResult(rootId);
		if (result !== null) {
			writeDocument(result, json);
			return resultExitCode(result);
		}
		const record = readFleetRootRecord(rootId);
		if (record === null) {
			// A root an earlier release started has a plan record but no root record and no persisted result.
			writeCliFailure({
				path: PATH,
				slug: "not_found",
				message: `fleet root ${rootId} has no root record to wait on; it was started by an earlier release`,
				json,
			});
			return 1;
		}
		const state = fleetRootState(record, false);
		if (state === "sealed") {
			// Marked sealed with its document missing or unreadable: the owner is done, so waiting cannot help.
			writeCliFailure({
				path: PATH,
				slug: "io",
				message: `fleet root ${rootId} sealed without a readable fleet result`,
				json,
			});
			return 1;
		}
		if (state === "orphaned") {
			const document = unsettledDocument(
				record,
				1,
				{ state: "stopped", stopReason: "owner_gone" },
				{
					code: "owner_gone",
					pid: record.pid,
					host: record.host,
					message: "the owning process exited before the root sealed",
				},
			);
			process.stderr.write(
				`clio-coder fleet wait: fleet root ${rootId}'s owner (pid ${record.pid} on ${record.host}) is gone and the root never sealed\n`,
			);
			writeDocument(document, json);
			return 1;
		}
		if (deadline !== null && Date.now() >= deadline) {
			const document = unsettledDocument(
				record,
				EXIT_CODES.notReady,
				{ state: "accepted", stopReason: null },
				{ code: "not_ready", timeoutMs, message: "the fleet root is still running" },
			);
			process.stderr.write(`clio-coder fleet wait: --timeout expired; fleet root ${rootId} is still running\n`);
			writeDocument(document, json);
			return EXIT_CODES.notReady;
		}
		await sleep(deadline === null ? POLL_MS : Math.max(1, Math.min(POLL_MS, deadline - Date.now())));
	}
}
