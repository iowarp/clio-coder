import { classify } from "../src/domains/safety/action-classifier.js";
import { buildAuditRecord } from "../src/domains/safety/audit.js";
import { DEFAULT_SCOPE, READONLY_SCOPE, isSubset } from "../src/domains/safety/scope.js";

/**
 * Slice 1 self-check. Exercises the pure helpers only:
 *   - classify(): fixture table covering every ActionClass branch
 *   - isSubset(): canonical read-only vs default
 *   - buildAuditRecord(): shape assertions
 *
 * Slice 3 adds a full diag-safety that opens the writer against ~/.clio and
 * wires the domain into the orchestrator. Do NOT touch the filesystem here.
 */

const failures: string[] = [];

function check(label: string, ok: boolean, detail?: string): void {
	if (ok) {
		process.stdout.write(`[diag-safety] OK   ${label}\n`);
		return;
	}
	failures.push(detail ? `${label}: ${detail}` : label);
	process.stderr.write(`[diag-safety] FAIL ${label}${detail ? ` — ${detail}` : ""}\n`);
}

function runClassifyFixtures(): void {
	const cases: { name: string; call: Parameters<typeof classify>[0]; expect: string }[] = [
		{ name: "read-basic", call: { tool: "read" }, expect: "read" },
		{ name: "bash-ls", call: { tool: "bash", args: { command: "ls" } }, expect: "execute" },
		{
			name: "bash-git-push-force",
			call: { tool: "bash", args: { command: "git push --force origin main" } },
			expect: "git_destructive",
		},
		{
			name: "bash-sudo-apt",
			call: { tool: "bash", args: { command: "sudo apt install vim" } },
			expect: "system_modify",
		},
		{
			name: "write-etc-hosts",
			call: { tool: "write", args: { path: "/etc/hosts" } },
			expect: "system_modify",
		},
		{
			name: "write-in-cwd",
			call: { tool: "write", args: { path: "./src/foo.ts" } },
			expect: "write",
		},
		{
			name: "write-relative-dot-dot-escape",
			call: { tool: "write", args: { path: "../outside.txt" } },
			expect: "system_modify",
		},
		{
			name: "bash-rm-rf-tmpfoo",
			call: { tool: "bash", args: { command: "rm -rf /tmpfoo" } },
			expect: "system_modify",
		},
		{
			name: "bash-rm-rf-tmp-safe",
			call: { tool: "bash", args: { command: "rm -rf /tmp/foo" } },
			expect: "execute",
		},
		{ name: "unknown-tool", call: { tool: "mystery" }, expect: "unknown" },
	];
	for (const c of cases) {
		const got = classify(c.call);
		check(`classify:${c.name}`, got.actionClass === c.expect, `expected ${c.expect}, got ${got.actionClass}`);
	}
}

function runScopeFixtures(): void {
	check("isSubset:readonly-in-default", isSubset(READONLY_SCOPE, DEFAULT_SCOPE) === true);
	check("isSubset:default-in-readonly", isSubset(DEFAULT_SCOPE, READONLY_SCOPE) === false);
}

function runAuditFixtures(): void {
	const record = buildAuditRecord({
		tool: "bash",
		classification: { actionClass: "execute", reasons: [] },
		decision: "classified",
		args: { command: "ls" },
		now: new Date("2026-04-16T12:00:00Z"),
	});
	check("audit:ts", typeof record.ts === "string" && record.ts.length > 0);
	check("audit:correlationId", typeof record.correlationId === "string" && record.correlationId.length === 12);
	check("audit:tool", record.tool === "bash");
	check("audit:actionClass", record.actionClass === "execute");
	check("audit:decision", record.decision === "classified");
	check("audit:reasons", Array.isArray(record.reasons));
	check("audit:args-present", record.args !== undefined);
}

runClassifyFixtures();
runScopeFixtures();
runAuditFixtures();

if (failures.length > 0) {
	process.stderr.write(`[diag-safety] FAILED ${failures.length} check(s)\n`);
	process.exit(1);
}
process.stdout.write("[diag-safety] PASS\n");
