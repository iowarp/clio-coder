/**
 * Host and HPC-scheduler identity detection for run receipts.
 *
 * Pure environment inspection, no I/O beyond os module lookups. Scheduler
 * detection order is Slurm, then PBS, then LSF; first match wins. Outside any
 * scheduler allocation `hpc` is null.
 */

import { hostname, userInfo } from "node:os";
import type { RunIdentity } from "./types.js";

function nonEmpty(value: string | undefined): string | null {
	return value !== undefined && value.trim().length > 0 ? value.trim() : null;
}

export function detectRunIdentity(env: NodeJS.ProcessEnv = process.env): RunIdentity {
	let user = "unknown";
	try {
		user = userInfo().username;
	} catch {
		user = nonEmpty(env.USER) ?? nonEmpty(env.LOGNAME) ?? "unknown";
	}
	const identity: RunIdentity = { host: hostname(), user, hpc: null };

	const slurmJobId = nonEmpty(env.SLURM_JOB_ID);
	if (slurmJobId !== null) {
		identity.hpc = {
			scheduler: "slurm",
			jobId: slurmJobId,
			jobName: nonEmpty(env.SLURM_JOB_NAME),
			cluster: nonEmpty(env.SLURM_CLUSTER_NAME),
		};
		return identity;
	}
	const pbsJobId = nonEmpty(env.PBS_JOBID);
	if (pbsJobId !== null) {
		identity.hpc = {
			scheduler: "pbs",
			jobId: pbsJobId,
			jobName: nonEmpty(env.PBS_JOBNAME),
			cluster: nonEmpty(env.PBS_O_HOST),
		};
		return identity;
	}
	const lsfJobId = nonEmpty(env.LSB_JOBID);
	if (lsfJobId !== null) {
		identity.hpc = {
			scheduler: "lsf",
			jobId: lsfJobId,
			jobName: nonEmpty(env.LSB_JOBNAME),
			cluster: nonEmpty(env.LSF_CLUSTER_NAME),
		};
		return identity;
	}
	return identity;
}
