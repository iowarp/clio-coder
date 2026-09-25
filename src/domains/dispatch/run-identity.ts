/**
 * Host and user identity for run receipts.
 *
 * Pure environment inspection, no I/O beyond os module lookups. Builds before
 * 0.5.6 also stamped Slurm, PBS or LSF allocation identity into `hpc`; nothing
 * read it, so the scheduler variables are no longer consulted.
 */

import { hostname, userInfo } from "node:os";
import type { RunIdentity } from "./types.js";

function nonEmpty(value: string | undefined): string | null {
	return value !== undefined && value.trim().length > 0 ? value.trim() : null;
}

export function detectRunIdentity(env: NodeJS.ProcessEnv = process.env): RunIdentity {
	let user = "unknown";
	try {
		user =
			nonEmpty(userInfo().username) ?? nonEmpty(env.USER) ?? nonEmpty(env.LOGNAME) ?? nonEmpty(env.USERNAME) ?? "unknown";
	} catch {
		user = nonEmpty(env.USER) ?? nonEmpty(env.LOGNAME) ?? nonEmpty(env.USERNAME) ?? "unknown";
	}
	let host = "unknown";
	try {
		host = hostname() || "unknown";
	} catch {
		// Restricted environments may not expose a host identity.
	}
	return { host, user };
}
