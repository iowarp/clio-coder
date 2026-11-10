import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import path from "node:path";
import { buildBwrapInvocation, DEFAULT_BWRAP_PATH } from "./bwrap.js";
import { buildSeatbeltInvocation, SEATBELT_EXECUTABLE } from "./seatbelt.js";
import type { SandboxAvailability, SandboxInvocation } from "./types.js";

const PROBE_TIMEOUT_MS = 5000;

let cached: SandboxAvailability | null = null;
let cachedNetIsolation: string | null | undefined;

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
 * that consults this module, and the probe is a fixed argv with no model
 * input and a hard timeout. Null when it succeeded, else why it failed.
 */
export function probeSandboxInvocation(invocation: SandboxInvocation, input?: Buffer): string | null {
	return probe(invocation, input).failure;
}

/** A timed-out probe says nothing about the host, so callers must not cache it. */
function probe(invocation: SandboxInvocation, input?: Buffer): { failure: string | null; timedOut: boolean } {
	const result = spawnSync(invocation.file, invocation.args, {
		stdio: [input === undefined ? "ignore" : "pipe", "ignore", "pipe"],
		...(input !== undefined ? { input } : {}),
		timeout: PROBE_TIMEOUT_MS,
		encoding: "utf8",
	});
	if (result.error) {
		return { failure: result.error.message, timedOut: (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT" };
	}
	if (result.status === 0) return { failure: null, timedOut: false };
	const stderr = (result.stderr ?? "").trim().split("\n").slice(-1)[0] ?? "";
	return {
		failure: stderr.length > 0 ? stderr : `probe exited with ${result.status ?? result.signal ?? "unknown status"}`,
		timedOut: false,
	};
}

function bwrapProbe(bwrap: string, network: boolean): SandboxInvocation {
	return buildBwrapInvocation(
		{ command: { argv: ["/bin/true"] }, cwd: "/", writableRoots: [], network, maskedPaths: [] },
		bwrap,
	);
}

type Detected = { availability: SandboxAvailability; timedOut: boolean };

function detect(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): Detected {
	if (platform === "linux") {
		const bwrap = findBwrap(env);
		if (bwrap === null) {
			return {
				availability: { available: false, backend: null, executable: null, reason: "bubblewrap (bwrap) is not installed" },
				timedOut: false,
			};
		}
		// The probe uses the namespaces every sandbox does, so a kernel that
		// forbids unprivileged user namespaces (or an outer container that
		// strips them) reports unavailable here instead of failing every call.
		// The network namespace only a network-off sandbox needs is probed
		// separately (sandboxNetworkIsolation), so a main session, whose network
		// stays on, does not lose its sandbox to it.
		const { failure, timedOut } = probe(bwrapProbe(bwrap, true));
		if (failure !== null) {
			// EPERM is policy, not a broken install: bwrap's own line (often
			// `pivot_root: Operation not permitted` in a container) does not say so.
			const cause = /Operation not permitted/u.test(failure)
				? " (the kernel or an enclosing container forbids the namespaces or mounts bubblewrap needs)"
				: "";
			return {
				availability: {
					available: false,
					backend: null,
					executable: null,
					reason: `bubblewrap cannot create a sandbox here: ${failure}${cause}`,
				},
				timedOut,
			};
		}
		return { availability: { available: true, backend: "bwrap", executable: bwrap, reason: null }, timedOut: false };
	}
	if (platform === "darwin") {
		if (!executable(SEATBELT_EXECUTABLE)) {
			return {
				availability: { available: false, backend: null, executable: null, reason: "sandbox-exec is not present" },
				timedOut: false,
			};
		}
		// The network grant and the unix-socket rules ride along, so a kernel
		// that rejects any rule a real launch uses reports unavailable here.
		const { failure, timedOut } = probe(
			buildSeatbeltInvocation({
				command: { argv: ["/usr/bin/true"] },
				cwd: "/",
				writableRoots: ["/private/tmp"],
				readOnlyPaths: ["/private/tmp/.clio-coder-probe"],
				network: true,
				maskedPaths: [],
				denyUnixSockets: true,
			}),
		);
		if (failure !== null) {
			return {
				availability: {
					available: false,
					backend: null,
					executable: null,
					reason: `sandbox-exec rejected the worker profile: ${failure}`,
				},
				timedOut,
			};
		}
		return {
			availability: {
				available: true,
				backend: "seatbelt",
				executable: SEATBELT_EXECUTABLE,
				reason: "seatbelt profile is unverified on macOS",
			},
			timedOut: false,
		};
	}
	return {
		availability: {
			available: false,
			backend: null,
			executable: null,
			reason: `no worker sandbox backend for platform '${platform}'`,
		},
		timedOut: false,
	};
}

/**
 * Probe once per process; a definite answer does not change while it runs.
 * A probe that timed out is not cached: this call reports unavailable and the
 * next one probes again.
 */
export function sandboxAvailability(
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
): SandboxAvailability {
	// Only the real host answer is cached; an explicit platform or env is a
	// one-off question and must not poison the process-wide probe.
	if (platform !== process.platform || env !== process.env) return detect(platform, env).availability;
	if (cached !== null) return cached;
	const detected = detect(platform, env);
	if (!detected.timedOut) cached = detected.availability;
	return detected.availability;
}

/**
 * Null when bubblewrap can also isolate the network (`--unshare-net`), which
 * a network-off sandbox needs; else why not. Cached like the base probe, a
 * timeout excepted. Other backends answer null.
 */
export function sandboxNetworkIsolation(availability: SandboxAvailability = sandboxAvailability()): string | null {
	if (!availability.available || availability.backend !== "bwrap" || availability.executable === null) return null;
	const cacheable = availability === cached;
	if (cacheable && cachedNetIsolation !== undefined) return cachedNetIsolation;
	const { failure, timedOut } = probe(bwrapProbe(availability.executable, false));
	const result = failure === null ? null : `bubblewrap cannot isolate the network here: ${failure}`;
	if (cacheable && !timedOut) cachedNetIsolation = result;
	return result;
}
