#!/usr/bin/env node
// node-pty 1.1.0's published tarball ships prebuilds/<platform>-<arch>/spawn-helper
// without the executable bit on macOS targets. Without exec, posix_spawnp from
// the native binding fails with "posix_spawnp failed" the first time the pty
// harness tries to fork a subprocess. Linux dodges this because no Linux
// prebuild exists; node-gyp recompiles the helper, and the compiler emits an
// executable. Windows uses winpty/conpty and never touches spawn-helper.
//
// Idempotent and defensive: we never let postinstall fail.
import { chmodSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

let ptyDir;
try {
	ptyDir = dirname(require.resolve("node-pty/package.json"));
} catch {
	process.exit(0);
}

const candidates = [
	["darwin", "arm64"],
	["darwin", "x64"],
	["linux", "x64"],
	["linux", "arm64"],
];

for (const [platform, arch] of candidates) {
	const helper = join(ptyDir, "prebuilds", `${platform}-${arch}`, "spawn-helper");
	if (existsSync(helper)) {
		try {
			chmodSync(helper, 0o755);
		} catch {
			// ignore; postinstall must not fail.
		}
	}
}
