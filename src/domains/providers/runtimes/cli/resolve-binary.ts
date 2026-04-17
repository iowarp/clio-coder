/**
 * PATH resolver for CLI adapters. Pure filesystem check; no spawn, no network.
 * Returns the resolved absolute path or null when the binary is not on PATH.
 */

import { existsSync } from "node:fs";
import path from "node:path";

export function resolveBinary(bin: string): string | null {
	const envPath = process.env.PATH ?? "";
	for (const dir of envPath.split(path.delimiter)) {
		if (!dir) continue;
		const candidate = path.join(dir, bin);
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

/**
 * Resolves a binary either directly on PATH or via an override env var that
 * names an absolute path to the executable.
 */
export function resolveBinaryWithEnv(bin: string, envVar?: string): string | null {
	if (envVar) {
		const override = process.env[envVar];
		if (override && existsSync(override)) return override;
	}
	return resolveBinary(bin);
}
