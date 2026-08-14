import { strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ToolNames } from "../../src/core/tool-names.js";
import { classify } from "../../src/domains/safety/action-classifier.js";

/**
 * Both sides of the `/var` line. `/var/tmp` and `/var/folders` are scratch
 * space and classify like `/tmp`; every other directory under `/var` stays a
 * system root. The workspace side is exercised from a real cwd under
 * `/var/tmp`, because that is the shape that failed live: a headless run whose
 * workspace sat there had all 23 of its mutating calls denied.
 */
describe("contracts/safety /var/tmp carve-out", () => {
	let sandbox: string;
	let originalCwd: string;

	beforeEach(() => {
		originalCwd = process.cwd();
		sandbox = mkdtempSync("/var/tmp/clio-var-carveout-");
		process.chdir(sandbox);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		rmSync(sandbox, { recursive: true, force: true });
	});

	it("classifies a write inside a /var/tmp workspace as an ordinary write", () => {
		strictEqual(classify({ tool: ToolNames.Write, args: { path: "PROBE.txt" } }).actionClass, "write");
		strictEqual(classify({ tool: ToolNames.Write, args: { path: join(sandbox, "src", "a.ts") } }).actionClass, "write");
		strictEqual(classify({ tool: ToolNames.Edit, args: { path: "PROBE.txt" } }).actionClass, "write");
	});

	it("classifies a bash write inside a /var/tmp workspace as execute", () => {
		strictEqual(classify({ tool: ToolNames.Bash, args: { command: 'echo "ok" > PROBE.txt' } }).actionClass, "execute");
		strictEqual(
			classify({ tool: ToolNames.Bash, args: { command: "mkdir -p src && touch src/a.ts" } }).actionClass,
			"execute",
		);
	});

	it("keeps every other directory under /var a system root", () => {
		for (const target of [
			"/var/log/clio.log",
			"/var/lib/clio/state.db",
			"/var/spool/mail/root",
			"/var/cache/apt/x",
			"/var/db/entry",
			"/var/mail/root",
			"/var/opt/pkg/file",
			"/var/www/index.html",
			"/var/anything-unlisted/file",
			"/var/tmpfiles/not-tmp",
		]) {
			const decision = classify({ tool: ToolNames.Write, args: { path: target } });
			strictEqual(decision.actionClass, "system_modify", `${target} must stay system_modify`);
			strictEqual(decision.reasons[0], "write-path-system-root: /var", `${target} reason`);
		}
	});

	it("protects the runtime tree /var/run and /var/lock resolve to", () => {
		// Both are symlinks into /run on systemd hosts, and path canonicalization
		// follows them before the prefix check runs.
		for (const target of ["/var/run/clio.pid", "/var/lock/clio.lock", "/run/systemd/x", "/run/lock/x"]) {
			const decision = classify({ tool: ToolNames.Write, args: { path: target } });
			strictEqual(decision.actionClass, "system_modify", target);
			strictEqual(decision.reasons[0], "write-path-system-root: /run", target);
		}
	});

	it("keeps the other system roots protected from a /var/tmp workspace", () => {
		for (const target of ["/etc/hosts", "/usr/bin/clio", "/bin/sh", "/sbin/init"]) {
			strictEqual(classify({ tool: ToolNames.Write, args: { path: target } }).actionClass, "system_modify", target);
		}
		strictEqual(
			classify({ tool: ToolNames.Bash, args: { command: "echo x > /var/log/clio.log" } }).actionClass,
			"system_modify",
		);
	});

	it("exempts /var/folders, the macOS temp tree, from the system-root rule", () => {
		// Off-cwd, so the remaining escalation is the ordinary outside-workspace
		// one rather than the system-root rule this exemption removes.
		const decision = classify({ tool: ToolNames.Write, args: { path: "/var/folders/xy/T/scratch/a.txt" } });
		strictEqual(decision.actionClass, "system_modify");
		strictEqual(decision.reasons[0], "write-path-outside-cwd: /var/folders/xy/T/scratch/a.txt");
	});

	it("still escalates a /var/tmp path outside the workspace", () => {
		const decision = classify({ tool: ToolNames.Write, args: { path: "/var/tmp/some-other-sandbox/a.txt" } });
		strictEqual(decision.actionClass, "system_modify");
		strictEqual(decision.reasons[0], "write-path-outside-cwd: /var/tmp/some-other-sandbox/a.txt");
	});

	it("classifies the artifact tool by the file name it will write", () => {
		// Inside the workspace it is an ordinary write, as before.
		strictEqual(classify({ tool: ToolNames.Artifact, args: { kind: "report" } }).actionClass, "write");
		// Aimed at a system root it is not. Observed live: with write, edit and
		// every bash redirect refused, artifact still wrote its REPORT.md.
		const decision = classify({ tool: ToolNames.Artifact, args: { kind: "report", path: "/etc/REPORT.md" } });
		strictEqual(decision.actionClass, "system_modify");
		// The pathless call is the one that used to slip: its target is the
		// default file name resolved against the cwd, which no path argument
		// carries. /etc is only read here, never written.
		process.chdir("/etc");
		try {
			strictEqual(classify({ tool: ToolNames.Artifact, args: { kind: "report" } }).actionClass, "system_modify");
			strictEqual(classify({ tool: ToolNames.Artifact, args: {} }).actionClass, "system_modify");
		} finally {
			process.chdir(sandbox);
		}
	});

	it("reads a write target through an sh -c wrapper", () => {
		// The wrapper used to hide the redirect from the scanner entirely, so a
		// system-root write one `sh -c` deep classified as plain execute.
		strictEqual(
			classify({ tool: ToolNames.Bash, args: { command: `sh -c 'echo "ok" > /etc/clio-probe'` } }).actionClass,
			"system_modify",
		);
		strictEqual(
			classify({ tool: ToolNames.Bash, args: { command: `bash -lc "touch /var/log/clio-probe"` } }).actionClass,
			"system_modify",
		);
		strictEqual(
			classify({ tool: ToolNames.Bash, args: { command: `sh -c 'cd /etc && touch clio-probe'` } }).actionClass,
			"system_modify",
		);
		// The same wrapper aimed inside the workspace stays execute.
		strictEqual(
			classify({ tool: ToolNames.Bash, args: { command: `sh -c 'echo ok > PROBE.txt'` } }).actionClass,
			"execute",
		);
	});
});
