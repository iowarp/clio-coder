import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import path from "node:path";
import { buildBwrapInvocation, DEFAULT_BWRAP_PATH } from "./bwrap.js";
import { buildSeatbeltInvocation, SEATBELT_EXECUTABLE } from "./seatbelt.js";
import type { SandboxAvailability, SandboxInvocation } from "./types.js";

const PROBE_TIMEOUT_MS = 5000;

let cached: SandboxAvailability | null = null;

function executable(candidate: string): boolean {
	try {
		accessSync(candidate, constants.X_OK);
		return true;
	} catch {
		// Missing or not executable; the caller tries the next candidate.
		return false;
	}
}

function findBwrap(env: NodeJS.ProcessEnv): string | null {
	if (executable(DEFAULT_BWRAP_PATH)) return DEFAULT_BWRAP_PATH;
	for (const dir of (env.PATH ?? "").split(path.delimiter)) {
		if (dir.length === 0 || !path.isAbsolute(dir)) continue;
		const candidate = path.join(dir, "bwrap");
		if (executable(candidate)) return candidate;
	}
	return null;
}

/**
 * Run the probe directly rather than through safe-exec: safe-exec is the seam
 * that consults this module, and the probe is a fixed argv with no shell, no
 * model input, and a hard timeout.
 */
function probe(invocation: SandboxInvocation): string | null {
	const result = spawnSync(invocation.file, invocation.args, {
		stdio: ["ignore", "ignore", "pipe"],
		timeout: PROBE_TIMEOUT_MS,
		encoding: "utf8",
	});
	if (result.error) return result.error.message;
	if (result.status === 0) return null;
	const stderr = (result.stderr ?? "").trim().split("\n").slice(-1)[0] ?? "";
	return stderr.length > 0 ? stderr : `probe exited with ${result.status ?? result.signal ?? "unknown status"}`;
}

function detect(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): SandboxAvailability {
	if (platform === "linux") {
		const bwrap = findBwrap(env);
		if (bwrap === null) {
			return { available: false, backend: null, executable: null, reason: "bubblewrap (bwrap) is not installed" };
		}
		// The probe uses the same namespaces a real command does, so a kernel
		// that forbids unprivileged user namespaces (or an outer container that
		// strips them) reports unavailable here instead of failing every call.
		const failure = probe(
			buildBwrapInvocation(
				{ command: { argv: ["/bin/true"] }, cwd: "/", writableRoots: [], network: false, maskedPaths: [] },
				bwrap,
			),
		);
		if (failure !== null) {
			return {
				available: false,
				backend: null,
				executable: null,
				reason: `bubblewrap cannot create a sandbox here: ${failure}`,
			};
		}
		return { available: true, backend: "bwrap", executable: bwrap, reason: null };
	}
	if (platform === "darwin") {
		if (!executable(SEATBELT_EXECUTABLE)) {
			return { available: false, backend: null, executable: null, reason: "sandbox-exec is not present" };
		}
		const failure = probe(
			buildSeatbeltInvocation({
				command: { argv: ["/usr/bin/true"] },
				cwd: "/",
				writableRoots: ["/private/tmp"],
				readOnlyPaths: ["/private/tmp/.clio-coder-probe"],
				network: false,
				maskedPaths: [],
			}),
		);
		if (failure !== null) {
			return {
				available: false,
				backend: null,
				executable: null,
				reason: `sandbox-exec rejected the worker profile: ${failure}`,
			};
		}
		return {
			available: true,
			backend: "seatbelt",
			executable: SEATBELT_EXECUTABLE,
			reason: "seatbelt profile is unverified on macOS",
		};
	}
	return {
		available: false,
		backend: null,
		executable: null,
		reason: `no worker sandbox backend for platform '${platform}'`,
	};
}

/** Probe once per process; the answer does not change while it runs. */
export function sandboxAvailability(
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
): SandboxAvailability {
	// Only the real host answer is cached; an explicit platform or env is a
	// one-off question and must not poison the process-wide probe.
	if (platform !== process.platform || env !== process.env) return detect(platform, env);
	cached ??= detect(platform, env);
	return cached;
}
