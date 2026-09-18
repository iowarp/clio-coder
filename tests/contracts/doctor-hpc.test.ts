import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { HPC_TOOLS, hpcToolchainFindings } from "../../src/cli/doctor-hpc.js";
import { formatDoctorReport } from "../../src/domains/lifecycle/doctor.js";

let root: string;
let bin: string;
let workspace: string;
let savedPath: string | undefined;

function fakeTool(name: string, body: string): void {
	const file = path.join(bin, name);
	writeFileSync(file, `#!/bin/sh\n${body}\n`);
	chmodSync(file, 0o755);
}

function contract(yaml: string): void {
	mkdirSync(path.join(workspace, ".clio-coder"), { recursive: true });
	writeFileSync(path.join(workspace, ".clio-coder", "validation.yaml"), yaml);
}

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "clio-doctor-hpc-"));
	bin = path.join(root, "bin");
	workspace = path.join(root, "ws");
	mkdirSync(bin);
	mkdirSync(workspace);
	savedPath = process.env.PATH;
	// Only the fixture directory: no dependence on this host's compilers.
	process.env.PATH = bin;
});

afterEach(() => {
	if (savedPath === undefined) delete process.env.PATH;
	else process.env.PATH = savedPath;
	rmSync(root, { recursive: true, force: true });
});

describe("doctor HPC toolchain probes", () => {
	it("reports path and first version line, falls back cc to gcc, and marks absent tools info", async () => {
		fakeTool("gcc", 'echo "gcc (Fixture) 13.2.0"; echo "Copyright line"');
		fakeTool(
			"nvcc",
			'echo "nvcc: NVIDIA (R) Cuda compiler driver" >&2; echo "" >&2; echo "Cuda compilation tools, release 12.4" >&2',
		);
		fakeTool("sbatch", 'echo "sbatch: error: fetch_config: DNS SRV lookup failed" >&2; exit 1');
		const findings = await hpcToolchainFindings({ workspaceRoot: workspace });
		deepStrictEqual(
			findings.map((f) => f.name),
			HPC_TOOLS.map((tool) => `toolchain ${tool.name}`),
		);
		const byName = new Map(findings.map((f) => [f.name, f]));
		deepStrictEqual(byName.get("toolchain cc"), {
			ok: true,
			name: "toolchain cc",
			level: "ok",
			detail: `${path.join(bin, "gcc")}: gcc (Fixture) 13.2.0`,
		});
		strictEqual(byName.get("toolchain nvcc")?.detail, `${path.join(bin, "nvcc")}: Cuda compilation tools, release 12.4`);
		// Installed but unable to answer, as an unconfigured Slurm client is.
		deepStrictEqual(byName.get("toolchain sbatch"), {
			ok: true,
			name: "toolchain sbatch",
			level: "warn",
			detail: `${path.join(bin, "sbatch")}: --version exited 1: sbatch: error: fetch_config: DNS SRV lookup failed`,
		});
		deepStrictEqual(byName.get("toolchain mpirun"), {
			ok: true,
			name: "toolchain mpirun",
			level: "info",
			detail: "not on PATH",
		});
		ok(findings.every((f) => f.ok));
		match(formatDoctorReport(findings), /^INFO toolchain meson\s+not on PATH$/m);
	});

	it("bounds a version spawn that never answers and runs the probes in parallel", async () => {
		// PATH is the fixture directory, so the hung fakes name sleep absolutely.
		const sleep = ["/bin/sleep", "/usr/bin/sleep"].find((file) => existsSync(file)) ?? "sleep";
		for (const name of ["mpirun", "cmake", "ninja"]) fakeTool(name, `exec ${sleep} 30`);
		const startedAt = performance.now();
		const findings = await hpcToolchainFindings({ workspaceRoot: workspace, timeoutMs: 400 });
		const elapsedMs = performance.now() - startedAt;
		const mpirun = findings.find((f) => f.name === "toolchain mpirun");
		strictEqual(mpirun?.level, "ok");
		match(mpirun?.detail ?? "", /: no version line \(--version did not answer within 400ms\)$/);
		// Three hung tools in series would take at least 1200ms.
		ok(elapsedMs < 1_150, `probes took ${elapsedMs}ms`);
	});

	it("warns for an absent tool the validation contract names or a slurm runtime needs", async () => {
		fakeTool("make", 'echo "GNU Make 4.3"');
		contract(
			[
				"version: 1",
				"runtime:",
				"  kind: slurm",
				"validators:",
				'  - "cmake --build build && make check"',
				'  - "/opt/tools/bin/mpicc -o probe probe.c"',
			].join("\n"),
		);
		const findings = await hpcToolchainFindings({ workspaceRoot: workspace });
		const byName = new Map(findings.map((f) => [f.name, f]));
		deepStrictEqual(byName.get("toolchain sbatch"), {
			ok: true,
			name: "toolchain sbatch",
			level: "warn",
			detail: "not on PATH; runtime.kind slurm needs it",
		});
		strictEqual(byName.get("toolchain cmake")?.level, "warn");
		strictEqual(byName.get("toolchain cmake")?.detail, "not on PATH; the validation contract names it");
		strictEqual(byName.get("toolchain mpicc")?.level, "warn");
		strictEqual(byName.get("toolchain make")?.level, "ok");
		strictEqual(byName.get("toolchain nvcc")?.level, "info");
		ok(findings.every((f) => f.ok));
	});
});
