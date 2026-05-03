import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionContract, SessionMeta } from "../../src/domains/session/contract.js";
import { type FsProbe, resolveSessionCwd } from "../../src/domains/session/cwd-fallback.js";
import { ESC, handleCwdFallbackCancel, routeCwdFallbackOverlayKey } from "../../src/interactive/index.js";

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

describe("routeCwdFallbackOverlayKey (slice 12.5c)", () => {
	// Esc must NOT be intercepted by the router. The SelectList inside the
	// cwd-fallback overlay owns its own Esc handling and routes it through
	// onCancel (which restores the prior session or reopens /resume). The
	// router intercepting Esc bypassed that path, leaving the user in the
	// broken-cwd session.
	it("is a no-op for Esc so the SelectList can fire onCancel", () => {
		let closed = 0;
		const consumed = routeCwdFallbackOverlayKey(ESC, {
			closeOverlay: () => {
				closed += 1;
			},
		});
		strictEqual(consumed, false);
		strictEqual(closed, 0);
	});

	it("is a no-op for arbitrary input (mirrors routeTreeOverlayKey)", () => {
		let closed = 0;
		const consumed = routeCwdFallbackOverlayKey("\x1b[A", {
			closeOverlay: () => {
				closed += 1;
			},
		});
		strictEqual(consumed, false);
		strictEqual(closed, 0);
	});
});

function makeSessionContract(overrides: {
	current?: SessionMeta | null;
	switchBranch?: (id: string) => SessionMeta;
}): SessionContract {
	const fail = (name: string) => () => {
		throw new Error(`SessionContract.${name} unexpectedly invoked in test`);
	};
	return {
		current: () => overrides.current ?? null,
		create: fail("create"),
		append: fail("append"),
		appendEntry: fail("appendEntry"),
		checkpoint: async () => {},
		resume: fail("resume"),
		fork: fail("fork"),
		tree: fail("tree"),
		switchBranch:
			overrides.switchBranch ??
			((id: string) => {
				throw new Error(`switchBranch(${id}) unexpectedly invoked in test`);
			}),
		editLabel: fail("editLabel"),
		deleteSession: fail("deleteSession"),
		history: () => [],
		close: async () => {},
	} as SessionContract;
}

function meta(id: string): SessionMeta {
	return {
		id,
		cwd: "/tmp/test",
		cwdHash: "deadbeef",
		compiledPromptHash: null,
		staticCompositionHash: null,
		clioVersion: "0.0.0-test",
		piMonoVersion: "0.0.0-test",
		platform: "linux",
		nodeVersion: "v24.0.0",
		createdAt: "2026-04-17T12:00:00.000Z",
		endedAt: null,
		endpoint: null,
		model: null,
	} as SessionMeta;
}

describe("handleCwdFallbackCancel (slice 12.5c)", () => {
	// preResumeSessionId === null means there was no prior session before
	// /resume opened. Cancel reopens the picker so the user can pick again.
	it("opens the resume overlay when preResumeSessionId is null", () => {
		let opened = 0;
		let warnings = "";
		handleCwdFallbackCancel(null, {
			session: makeSessionContract({ current: meta("resumed-1") }),
			openResumeOverlay: () => {
				opened += 1;
			},
			onWarning: (msg) => {
				warnings += msg;
			},
		});
		strictEqual(opened, 1);
		strictEqual(warnings, "");
	});

	// preResumeSessionId set and different from the just-resumed session id
	// triggers switchBranch to restore the prior session.
	it("calls switchBranch(preResumeSessionId) when restoring the prior session", () => {
		let switched: string | null = null;
		let opened = 0;
		handleCwdFallbackCancel("prior-session", {
			session: makeSessionContract({
				current: meta("resumed-1"),
				switchBranch: (id) => {
					switched = id;
					return meta(id);
				},
			}),
			openResumeOverlay: () => {
				opened += 1;
			},
			onWarning: () => {},
		});
		strictEqual(switched, "prior-session");
		strictEqual(opened, 0);
	});

	// Defensive: if the just-resumed session somehow already matches the prior
	// id, fall through to reopening /resume rather than switching to itself.
	it("opens the resume overlay when preResumeSessionId equals the current session id", () => {
		let switched = 0;
		let opened = 0;
		handleCwdFallbackCancel("same-id", {
			session: makeSessionContract({
				current: meta("same-id"),
				switchBranch: () => {
					switched += 1;
					return meta("same-id");
				},
			}),
			openResumeOverlay: () => {
				opened += 1;
			},
			onWarning: () => {},
		});
		strictEqual(switched, 0);
		strictEqual(opened, 1);
	});

	// switchBranch failures must not propagate; surface a warning so the user
	// sees the breadcrumb and the overlay still closes cleanly.
	it("emits a warning when switchBranch throws and does not rethrow", () => {
		let warnings = "";
		handleCwdFallbackCancel("prior-session", {
			session: makeSessionContract({
				current: meta("resumed-1"),
				switchBranch: () => {
					throw new Error("disk gone");
				},
			}),
			openResumeOverlay: () => {},
			onWarning: (msg) => {
				warnings += msg;
			},
		});
		strictEqual(warnings, "[cwd-fallback] could not restore prior session: disk gone\n");
	});
});
