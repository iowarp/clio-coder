import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classify } from "../src/domains/safety/action-classifier.js";
import { buildAuditRecord } from "../src/domains/safety/audit.js";
import { loadDefaultRuleset, loadRuleset, match } from "../src/domains/safety/damage-control.js";
import { createLoopState, observe } from "../src/domains/safety/loop-detector.js";
import { formatRejection } from "../src/domains/safety/rejection-feedback.js";
import { DEFAULT_SCOPE, READONLY_SCOPE, isSubset } from "../src/domains/safety/scope.js";

/**
 * Slice 3 diag harness. Exercises pure helpers AND the wired SafetyDomainModule
 * against an ephemeral CLIO_HOME so it can be appended to `npm run ci`. The
 * domain-level section:
 *   - mounts loadDomains([ConfigDomainModule, SafetyDomainModule])
 *   - calls contract.evaluate() across a fixture table
 *   - asserts bus events fire and NDJSON audit lines land on disk
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

function today(): string {
	const fmt = new Intl.DateTimeFormat("en-CA", {
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	});
	return fmt.format(new Date());
}

async function runDomainHarness(): Promise<void> {
	const home = mkdtempSync(join(tmpdir(), "clio-diag-safety-"));
	const ENV_KEYS = ["CLIO_HOME", "CLIO_DATA_DIR", "CLIO_CONFIG_DIR", "CLIO_CACHE_DIR"] as const;
	const snapshot = new Map<string, string | undefined>();
	for (const k of ENV_KEYS) snapshot.set(k, process.env[k]);
	// Clear per-kind overrides BEFORE setting CLIO_HOME so that xdg.ts resolves
	// paths under the ephemeral home. Per-kind env vars take precedence over
	// CLIO_HOME inside xdg.ts, so a poisoned caller env would otherwise redirect
	// audit writes outside `home`.
	for (const k of ["CLIO_DATA_DIR", "CLIO_CONFIG_DIR", "CLIO_CACHE_DIR"] as const) {
		delete process.env[k];
	}
	process.env.CLIO_HOME = home;
	try {
		// Dynamic imports AFTER CLIO_HOME is set so the xdg module caches the
		// ephemeral path rather than the user's real home.
		const { resetXdgCache, clioDataDir } = await import("../src/core/xdg.js");
		resetXdgCache();
		const expectedData = join(home, "data");
		const resolvedData = clioDataDir();
		if (resolvedData !== expectedData) {
			throw new Error(`expected data dir ${expectedData}, got ${resolvedData}`);
		}
		check("xdg:data-dir-matches-home", true);
		const { resetSharedBus, getSharedBus } = await import("../src/core/shared-bus.js");
		resetSharedBus();
		const { loadDomains } = await import("../src/core/domain-loader.js");
		const { ConfigDomainModule } = await import("../src/domains/config/index.js");
		const { SafetyDomainModule } = await import("../src/domains/safety/index.js");
		const { BusChannels } = await import("../src/core/bus-events.js");
		const { resetPackageRootCache } = await import("../src/core/package-root.js");
		resetPackageRootCache();

		// Touch settings.yaml so ConfigDomainModule's fs.watch() has a target.
		// readSettings() falls back to DEFAULT_SETTINGS when the file is absent
		// but the watcher still needs the inode.
		writeFileSync(join(home, "settings.yaml"), "");

		const bus = getSharedBus();
		const seen = { classified: 0, allowed: 0, blocked: 0 };
		bus.on(BusChannels.SafetyClassified, () => {
			seen.classified += 1;
		});
		bus.on(BusChannels.SafetyAllowed, () => {
			seen.allowed += 1;
		});
		bus.on(BusChannels.SafetyBlocked, () => {
			seen.blocked += 1;
		});

		const result = await loadDomains([ConfigDomainModule, SafetyDomainModule]);
		check("domain:loaded", result.loaded.includes("safety"), `loaded=${result.loaded.join(",")}`);

		type SafetyContractType = import("../src/domains/safety/contract.js").SafetyContract;
		const safety = result.getContract<SafetyContractType>("safety");
		check("domain:contract-exposed", safety !== undefined);
		if (!safety) {
			await result.stop();
			return;
		}

		const before = safety.audit.recordCount();

		const readDecision = safety.evaluate({ tool: "read", args: { file_path: "/tmp/ok" } });
		check("evaluate:read-allow", readDecision.kind === "allow" && readDecision.classification.actionClass === "read");
		const readCount = safety.audit.recordCount();
		check("evaluate:read-audit-bumped", readCount === before + 1, `before=${before} after=${readCount}`);

		const writeDecision = safety.evaluate({ tool: "write", args: { path: "./src/foo.ts" } });
		check(
			"evaluate:write-in-cwd-allow",
			writeDecision.kind === "allow" && writeDecision.classification.actionClass === "write",
		);

		const gitDecision = safety.evaluate({ tool: "bash", args: { command: "git push --force origin main" } });
		check(
			"evaluate:git-force-block",
			gitDecision.kind === "block" && gitDecision.classification.actionClass === "git_destructive",
		);
		check(
			"evaluate:git-force-rejection-short",
			gitDecision.kind === "block" && gitDecision.rejection.short.includes("blocked"),
		);

		const sudoDecision = safety.evaluate({ tool: "bash", args: { command: "sudo apt install vim" } });
		check(
			"evaluate:sudo-apt-allow-at-safety",
			sudoDecision.kind === "allow" && sudoDecision.classification.actionClass === "system_modify",
			`kind=${sudoDecision.kind} class=${sudoDecision.classification.actionClass}`,
		);

		const rmDecision = safety.evaluate({ tool: "bash", args: { command: "rm -rf /" } });
		check("evaluate:rm-rf-root-block", rmDecision.kind === "block");

		check("bus:classified-fired", seen.classified >= 5, `count=${seen.classified}`);
		check("bus:allowed-fired", seen.allowed >= 3, `count=${seen.allowed}`);
		check("bus:blocked-fired", seen.blocked >= 2, `count=${seen.blocked}`);

		await result.stop();

		const auditPath = join(home, "data", "audit", `${today()}.jsonl`);
		check("audit:file-exists", existsSync(auditPath), auditPath);
		if (existsSync(auditPath)) {
			const raw = readFileSync(auditPath, "utf8");
			const lines = raw.split("\n").filter((l) => l.length > 0);
			check("audit:at-least-5-lines", lines.length >= 5, `lines=${lines.length}`);
			let parsedOk = true;
			for (const line of lines) {
				try {
					const parsed = JSON.parse(line);
					if (typeof parsed !== "object" || parsed === null) parsedOk = false;
				} catch {
					parsedOk = false;
				}
			}
			check("audit:lines-parse-as-json", parsedOk);
		}
	} finally {
		try {
			rmSync(home, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
		for (const [k, v] of snapshot) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
}

async function main(): Promise<void> {
	runClassifyFixtures();
	runScopeFixtures();
	runAuditFixtures();
	runDamageControlFixtures();
	runLoopDetectorFixtures();
	runRejectionFeedbackFixtures();
	await runDomainHarness();

	if (failures.length > 0) {
		process.stderr.write(`[diag-safety] FAILED ${failures.length} check(s)\n`);
		process.exit(1);
	}
	process.stdout.write("[diag-safety] PASS\n");
}

main().catch((err) => {
	process.stderr.write(`[diag-safety] crashed: ${err instanceof Error ? err.stack : String(err)}\n`);
	process.exit(1);
});
