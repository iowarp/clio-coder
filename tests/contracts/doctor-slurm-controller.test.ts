import { match, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { hpcToolchainFindings } from "../../src/cli/doctor-hpc.js";
import { slurmMcpFindings } from "../../src/cli/doctor-slurm.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

it("doctor warns consistently for Slurm clients with no controller configuration", async () => {
	const env = await isolateClioEnv("doctor-slurm-controller-");
	try {
		const bin = join(env.dir, "bin");
		mkdirSync(bin);
		writeFileSync(
			join(bin, "sbatch"),
			`#!/bin/sh\necho call >> '${join(env.dir, "calls")}'\necho "fetch_config: DNS SRV lookup failed" >&2\nexit 1\n`,
			{ mode: 0o755 },
		);
		process.env.PATH = bin;
		const hpc = await hpcToolchainFindings({ workspaceRoot: env.dir });
		const sbatchFinding = hpc.find((row) => row.name === "toolchain sbatch");
		ok(sbatchFinding);
		const rows = [...hpc, ...(await slurmMcpFindings({ untouched: true, sbatchFinding }))];
		strictEqual(readFileSync(join(env.dir, "calls"), "utf8").trim(), "call");
		for (const name of ["toolchain sbatch", "slurm scheduler"]) {
			const row = rows.find((row) => row.name === name);
			strictEqual(row?.level, "warn");
			match(row?.detail ?? "", /no Slurm configuration or controller to reach/);
		}
	} finally {
		env.restore();
	}
});
