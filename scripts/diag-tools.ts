import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Phase 5 slice 6 consolidated diag. Boots the config + safety + modes domains
 * against an ephemeral CLIO_HOME, wires every tool onto a fresh registry via
 * registerAllTools, and asserts the admission contract across modes: 11 tools
 * registered, 9 visible in default, 8 visible in advise, bash rejected in
 * advise, write admitted in default, write_plan's path guard produces a
 * tool-level error while still admitting the call.
 */

const failures: string[] = [];

function check(label: string, ok: boolean, detail?: string): void {
	if (ok) {
		process.stdout.write(`[diag-tools] OK   ${label}\n`);
		return;
	}
	failures.push(detail ? `${label}: ${detail}` : label);
	process.stderr.write(`[diag-tools] FAIL ${label}${detail ? ` — ${detail}` : ""}\n`);
}

async function runDomainHarness(): Promise<void> {
	const home = mkdtempSync(join(tmpdir(), "clio-diag-tools-"));
	const ENV_KEYS = ["CLIO_HOME", "CLIO_DATA_DIR", "CLIO_CONFIG_DIR", "CLIO_CACHE_DIR"] as const;
	const snapshot = new Map<string, string | undefined>();
	for (const k of ENV_KEYS) snapshot.set(k, process.env[k]);
	for (const k of ["CLIO_DATA_DIR", "CLIO_CONFIG_DIR", "CLIO_CACHE_DIR"] as const) {
		delete process.env[k];
	}
	process.env.CLIO_HOME = home;
	const originalCwd = process.cwd();
	try {
		const { resetXdgCache } = await import("../src/core/xdg.js");
		resetXdgCache();
		const { resetSharedBus } = await import("../src/core/shared-bus.js");
		resetSharedBus();
		const { loadDomains } = await import("../src/core/domain-loader.js");
		const { ConfigDomainModule } = await import("../src/domains/config/index.js");
		const { SafetyDomainModule } = await import("../src/domains/safety/index.js");
		const { ModesDomainModule } = await import("../src/domains/modes/index.js");
		const { resetPackageRootCache } = await import("../src/core/package-root.js");
		resetPackageRootCache();
		const { createRegistry } = await import("../src/tools/registry.js");
		const { registerAllTools } = await import("../src/tools/bootstrap.js");
		const { ToolNames } = await import("../src/core/tool-names.js");

		writeFileSync(join(home, "settings.yaml"), "");

		const result = await loadDomains([ConfigDomainModule, SafetyDomainModule, ModesDomainModule]);
		check("domain:loaded", result.loaded.includes("modes"), `loaded=${result.loaded.join(",")}`);

		type SafetyContractType = import("../src/domains/safety/contract.js").SafetyContract;
		type ModesContractType = import("../src/domains/modes/contract.js").ModesContract;
		const safety = result.getContract<SafetyContractType>("safety");
		const modes = result.getContract<ModesContractType>("modes");
		if (!safety || !modes) {
			await result.stop();
			check("domain:contracts-exposed", false, "missing safety or modes contract");
			return;
		}

		const registry = createRegistry({ safety, modes });
		registerAllTools(registry);

		// --- test 1: listAll length ---
		const all = registry.listAll();
		check("registry:listAll-length-11", all.length === 11, `len=${all.length}`);

		// --- test 2: default mode → 9 visible (all except write_plan/write_review) ---
		check("mode:default-at-boot", modes.current() === "default", `got ${modes.current()}`);
		const defaultVisible = registry.listVisible().map((t) => t.name);
		check("registry:default-visible-length-9", defaultVisible.length === 9, `visible=${defaultVisible.join(",")}`);
		check(
			"registry:default-excludes-write_plan",
			!defaultVisible.includes(ToolNames.WritePlan),
			`visible=${defaultVisible.join(",")}`,
		);
		check(
			"registry:default-excludes-write_review",
			!defaultVisible.includes(ToolNames.WriteReview),
			`visible=${defaultVisible.join(",")}`,
		);

		// --- switch to advise ---
		const afterCycle = modes.cycleNormal();
		check("mode:advise-after-cycle", afterCycle === "advise", `got ${afterCycle}`);

		// --- test 3: advise mode → 8 tools with the expected name set ---
		const adviseVisible = registry.listVisible().map((t) => t.name);
		const expectedAdvise = new Set<string>([
			ToolNames.Read,
			ToolNames.Grep,
			ToolNames.Glob,
			ToolNames.Ls,
			ToolNames.WebFetch,
			ToolNames.WebSearch,
			ToolNames.WritePlan,
			ToolNames.WriteReview,
		]);
		const adviseSet = new Set<string>(adviseVisible);
		const sameSet = adviseSet.size === expectedAdvise.size && [...expectedAdvise].every((n) => adviseSet.has(n));
		check("registry:advise-visible-matches-expected-8", sameSet, `visible=${adviseVisible.join(",")}`);

		// --- test 4: bash in advise → not_visible ---
		const bashAdvise = await registry.invoke({ tool: ToolNames.Bash, args: { command: "ls" } });
		check("invoke:advise-bash-not-visible", bashAdvise.kind === "not_visible", `verdict=${JSON.stringify(bashAdvise)}`);

		// --- chdir into hermetic home so write paths resolve inside cwd ---
		process.chdir(home);

		// --- test 6: write_plan with wrong path in advise → ok verdict, tool error ---
		const writePlanBad = await registry.invoke({
			tool: ToolNames.WritePlan,
			args: { path: "other.md", content: "x" },
		});
		check(
			"invoke:advise-write_plan-wrong-path-admitted",
			writePlanBad.kind === "ok",
			`verdict=${JSON.stringify(writePlanBad)}`,
		);
		check(
			"invoke:advise-write_plan-wrong-path-tool-error",
			writePlanBad.kind === "ok" &&
				writePlanBad.result.kind === "error" &&
				/only accepts[^"]*"?PLAN\.md"?/i.test(writePlanBad.result.message),
			`verdict=${JSON.stringify(writePlanBad)}`,
		);

		// --- test 7: write_plan with PLAN.md in advise → ok, file written ---
		const writePlanGood = await registry.invoke({
			tool: ToolNames.WritePlan,
			args: { path: "PLAN.md", content: "# plan\n" },
		});
		const planPath = join(home, "PLAN.md");
		check(
			"invoke:advise-write_plan-ok",
			writePlanGood.kind === "ok" && writePlanGood.result.kind === "ok",
			`verdict=${JSON.stringify(writePlanGood)}`,
		);
		check(
			"invoke:advise-write_plan-file-written",
			existsSync(planPath) && readFileSync(planPath, "utf8") === "# plan\n",
			`planPath=${planPath}`,
		);

		// --- cycle back to default for write test ---
		const afterCycle2 = modes.cycleNormal();
		check("mode:default-after-cycle-back", afterCycle2 === "default", `got ${afterCycle2}`);

		// --- test 5: write in default → ok ---
		const writeVerdict = await registry.invoke({
			tool: ToolNames.Write,
			args: { path: "./tmp-x", content: "x" },
		});
		check(
			"invoke:default-write-ok",
			writeVerdict.kind === "ok" && writeVerdict.result.kind === "ok",
			`verdict=${JSON.stringify(writeVerdict)}`,
		);
		check(
			"invoke:default-write-file-written",
			existsSync(join(home, "tmp-x")) && readFileSync(join(home, "tmp-x"), "utf8") === "x",
		);

		await result.stop();
	} finally {
		try {
			process.chdir(originalCwd);
		} catch {
			// best-effort restore
		}
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
	await runDomainHarness();

	if (failures.length > 0) {
		process.stderr.write(`[diag-tools] FAILED ${failures.length} check(s)\n`);
		process.exit(1);
	}
	process.stdout.write("[diag-tools] PASS\n");
}

main().catch((err) => {
	process.stderr.write(`[diag-tools] crashed: ${err instanceof Error ? err.stack : String(err)}\n`);
	process.exit(1);
});
