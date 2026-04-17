import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classify } from "../src/domains/safety/action-classifier.js";
import { buildAuditRecord } from "../src/domains/safety/audit.js";
import { loadDefaultRuleset, loadRuleset, match } from "../src/domains/safety/damage-control.js";
import { createLoopState, observe } from "../src/domains/safety/loop-detector.js";
import { formatRejection } from "../src/domains/safety/rejection-feedback.js";
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

function runDamageControlFixtures(): void {
	const ruleset = loadDefaultRuleset();
	const gp = match("git push --force origin main", ruleset);
	check("damage-control:git-push-force-main", gp?.ruleId === "git-push-force-main", `got ${String(gp?.ruleId)}`);
	const rm = match("rm -rf /", ruleset);
	check("damage-control:rm-rf-root", rm?.ruleId === "rm-rf-root", `got ${String(rm?.ruleId)}`);
	const benign = match("ls -la", ruleset);
	check("damage-control:benign-null", benign === null);
	check("damage-control:empty-string-null", match("", ruleset) === null);
	const chmodBare = match("chmod -R 755 /", ruleset);
	check(
		"damage-control:chmod-recursive-root-bare-slash",
		chmodBare?.ruleId === "chmod-recursive-root",
		`got ${String(chmodBare?.ruleId)}`,
	);
	const chmodVar = match("chmod -R 755 /var/lib", ruleset);
	check(
		"damage-control:chmod-recursive-root-var",
		chmodVar?.ruleId === "chmod-recursive-root",
		`got ${String(chmodVar?.ruleId)}`,
	);
	const chmodLocal = match("chmod -R 755 ./local", ruleset);
	check(
		"damage-control:chmod-recursive-root-local-path-negative",
		chmodLocal === null,
		`got ${String(chmodLocal?.ruleId)}`,
	);

	const badPath = join(tmpdir(), `clio-diag-safety-bad-${Date.now()}.yaml`);
	writeFileSync(
		badPath,
		[
			"version: 1",
			"rules:",
			"  - description: missing id rule",
			'    pattern: "\\\\bfoo\\\\b"',
			"    class: execute",
			"    block: false",
			"",
		].join("\n"),
	);
	let threw = false;
	let message = "";
	try {
		loadRuleset(badPath);
	} catch (err) {
		threw = true;
		message = err instanceof Error ? err.message : String(err);
	} finally {
		try {
			unlinkSync(badPath);
		} catch {
			// best-effort cleanup
		}
	}
	check(
		"damage-control:loader-rejects-missing-id",
		threw && message.includes("index") && message.includes("id"),
		`threw=${threw} message=${message}`,
	);
}

function runLoopDetectorFixtures(): void {
	let state = createLoopState();
	const now = 1_000_000;
	let verdict = { looping: false, key: "", count: 0 };
	for (let i = 0; i < 5; i += 1) {
		const [next, v] = observe(state, "bash|ls", now + i);
		state = next;
		verdict = v;
	}
	check("loop-detector:5th-call-looping", verdict.looping === true && verdict.count === 5);
	const [, sixth] = observe(state, "bash|ls", now + 5);
	check("loop-detector:6th-call-still-looping", sixth.looping === true && sixth.count === 6);
	const fresh = createLoopState();
	const [, single] = observe(fresh, "bash|ls", now);
	check("loop-detector:single-call-not-looping", single.looping === false && single.count === 1);
}

function runRejectionFeedbackFixtures(): void {
	const msg = formatRejection({
		tool: "bash",
		actionClass: "git_destructive",
		reasons: ["matched git-push-force-main"],
		mode: "default",
	});
	check("rejection:short-has-blocked", msg.short.includes("blocked"));
	check(
		"rejection:hint-hard-block",
		msg.hints.some((h) => h.includes("hard block")),
	);
	const sysMsg = formatRejection({
		tool: "bash",
		actionClass: "system_modify",
		reasons: ["pattern:sudo-or-doas"],
		mode: "default",
	});
	check(
		"rejection:super-mode-hint",
		sysMsg.hints.some((h) => h.includes("super mode")),
	);
}

runClassifyFixtures();
runScopeFixtures();
runAuditFixtures();
runDamageControlFixtures();
runLoopDetectorFixtures();
runRejectionFeedbackFixtures();

if (failures.length > 0) {
	process.stderr.write(`[diag-safety] FAILED ${failures.length} check(s)\n`);
	process.exit(1);
}
process.stdout.write("[diag-safety] PASS\n");
