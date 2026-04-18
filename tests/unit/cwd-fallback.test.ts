import { deepStrictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { type FsProbe, resolveSessionCwd } from "../../src/domains/session/cwd-fallback.js";

/**
 * Deterministic fsProbe stub. Tests enumerate the paths that exist and
 * whether each is a directory; anything else reports as absent.
 */
function makeFsProbe(entries: Record<string, "dir" | "file">): FsProbe {
	return {
		exists: (p) => Object.hasOwn(entries, p),
		isDirectory: (p) => entries[p] === "dir",
	};
}

describe("session/cwd-fallback resolveSessionCwd", () => {
	it("returns ok when the recorded cwd exists and is a directory", () => {
		const probe = makeFsProbe({ "/workspace/clio": "dir" });
		const result = resolveSessionCwd({ cwd: "/workspace/clio" }, probe);
		deepStrictEqual(result, { ok: true, cwd: "/workspace/clio" });
	});

	it("returns no-cwd when meta.cwd is undefined", () => {
		const probe = makeFsProbe({});
		const result = resolveSessionCwd({}, probe);
		deepStrictEqual(result, { ok: false, reason: "no-cwd" });
	});

	it("returns no-cwd when meta.cwd is null", () => {
		const probe = makeFsProbe({});
		const result = resolveSessionCwd({ cwd: null }, probe);
		deepStrictEqual(result, { ok: false, reason: "no-cwd" });
	});

	it("returns no-cwd when meta.cwd is blank after trimming", () => {
		const probe = makeFsProbe({});
		const result = resolveSessionCwd({ cwd: "   \t\n   " }, probe);
		deepStrictEqual(result, { ok: false, reason: "no-cwd" });
	});

	it("returns missing when cwd is set but the path does not exist", () => {
		const probe = makeFsProbe({});
		const result = resolveSessionCwd({ cwd: "/was/deleted" }, probe);
		deepStrictEqual(result, { ok: false, reason: "missing" });
	});

	it("returns not-a-directory when cwd exists but is a file", () => {
		const probe = makeFsProbe({ "/etc/hosts": "file" });
		const result = resolveSessionCwd({ cwd: "/etc/hosts" }, probe);
		deepStrictEqual(result, { ok: false, reason: "not-a-directory" });
	});

	it("trims whitespace before probing", () => {
		const probe = makeFsProbe({ "/workspace/clio": "dir" });
		const result = resolveSessionCwd({ cwd: "  /workspace/clio  " }, probe);
		deepStrictEqual(result, { ok: true, cwd: "/workspace/clio" });
	});

	it("uses the default fsProbe when none is supplied", () => {
		// The default probe wraps node:fs. /tmp should exist on every test host
		// used by the CI matrix (Linux, macOS). This is the one test that
		// touches the real filesystem; all others run against the stub.
		const result = resolveSessionCwd({ cwd: "/tmp" });
		deepStrictEqual(result, { ok: true, cwd: "/tmp" });
	});
});
