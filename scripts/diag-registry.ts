import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Slice 6 diag harness. Wires Config + Safety + Modes domains against an
 * ephemeral CLIO_HOME, registers two fixture tools (read and bash), and
 * exercises the registry's allow + block + not_visible verdict paths across
 * the default and advise modes. Mirrors the hermeticity pattern from
 * diag-safety.ts and diag-modes.ts so it can be appended to `npm run ci`.
 */

const failures: string[] = [];

function check(label: string, ok: boolean, detail?: string): void {
	if (ok) {
		process.stdout.write(`[diag-registry] OK   ${label}\n`);
		return;
	}
	failures.push(detail ? `${label}: ${detail}` : label);
	process.stderr.write(`[diag-registry] FAIL ${label}${detail ? ` — ${detail}` : ""}\n`);
}

async function runDomainHarness(): Promise<void> {
	const home = mkdtempSync(join(tmpdir(), "clio-diag-registry-"));
	const ENV_KEYS = ["CLIO_HOME", "CLIO_DATA_DIR", "CLIO_CONFIG_DIR", "CLIO_CACHE_DIR"] as const;
	const snapshot = new Map<string, string | undefined>();
	for (const k of ENV_KEYS) snapshot.set(k, process.env[k]);
	// Clear per-kind overrides BEFORE setting CLIO_HOME so xdg resolves inside
	// the ephemeral home rather than any inherited override.
	for (const k of ["CLIO_DATA_DIR", "CLIO_CONFIG_DIR", "CLIO_CACHE_DIR"] as const) {
		delete process.env[k];
	}
	process.env.CLIO_HOME = home;
	try {
		const { resetXdgCache, clioDataDir } = await import("../src/core/xdg.js");
		resetXdgCache();
		const expectedData = join(home, "data");
		const resolvedData = clioDataDir();
		if (resolvedData !== expectedData) {
			throw new Error(`expected data dir ${expectedData}, got ${resolvedData}`);
		}
		check("xdg:data-dir-matches-home", true);

		const { resetSharedBus } = await import("../src/core/shared-bus.js");
		resetSharedBus();
		const { loadDomains } = await import("../src/core/domain-loader.js");
		const { ConfigDomainModule } = await import("../src/domains/config/index.js");
		const { SafetyDomainModule } = await import("../src/domains/safety/index.js");
		const { ModesDomainModule } = await import("../src/domains/modes/index.js");
		const { resetPackageRootCache } = await import("../src/core/package-root.js");
		resetPackageRootCache();
		const { createRegistry } = await import("../src/tools/registry.js");
		type ToolSpec = import("../src/tools/registry.js").ToolSpec;
		const { ToolNames } = await import("../src/core/tool-names.js");

		// Touch settings.yaml so the config watcher has a target inode.
		writeFileSync(join(home, "settings.yaml"), "");

		const result = await loadDomains([ConfigDomainModule, SafetyDomainModule, ModesDomainModule]);
		check("domain:loaded", result.loaded.includes("modes"), `loaded=${result.loaded.join(",")}`);

		type SafetyContractType = import("../src/domains/safety/contract.js").SafetyContract;
		type ModesContractType = import("../src/domains/modes/contract.js").ModesContract;
		const safety = result.getContract<SafetyContractType>("safety");
		const modes = result.getContract<ModesContractType>("modes");
		check("domain:safety-contract-exposed", safety !== undefined);
		check("domain:modes-contract-exposed", modes !== undefined);
		if (!safety || !modes) {
			await result.stop();
			return;
		}

		const fixtureRead: ToolSpec = {
			name: ToolNames.Read,
			description: "fixture read tool",
			baseActionClass: "read",
			async run(args) {
				return { kind: "ok", output: `read ${(args.path as string) ?? "?"}` };
			},
		};
		const fixtureBash: ToolSpec = {
			name: ToolNames.Bash,
			description: "fixture bash tool",
			baseActionClass: "execute",
			async run(args) {
				return { kind: "ok", output: `bash ${(args.command as string) ?? ""}` };
			},
		};

		const registry = createRegistry({ safety, modes });
		registry.register(fixtureRead);
		registry.register(fixtureBash);

		check("registry:listAll-has-two", registry.listAll().length === 2, `len=${registry.listAll().length}`);

		// --- mode default ---
		check("mode:default-at-boot", modes.current() === "default", `got ${modes.current()}`);
		const visibleDefault = registry.listVisible().map((t) => t.name);
		check(
			"registry:visible-default-includes-bash",
			visibleDefault.includes(ToolNames.Bash),
			`visible=${visibleDefault.join(",")}`,
		);
		check(
			"registry:visible-default-includes-read",
			visibleDefault.includes(ToolNames.Read),
			`visible=${visibleDefault.join(",")}`,
		);

		const readVerdict = await registry.invoke({ tool: "read", args: { path: "./foo" } });
		check(
			"invoke:default-read-ok",
			readVerdict.kind === "ok" && readVerdict.result.kind === "ok" && readVerdict.result.output.includes("./foo"),
			`verdict=${JSON.stringify(readVerdict)}`,
		);

		const gitVerdict = await registry.invoke({
			tool: "bash",
			args: { command: "git push --force origin main" },
		});
		check(
			"invoke:default-bash-git-force-blocked",
			gitVerdict.kind === "blocked" && gitVerdict.decision.kind === "block",
			`verdict=${JSON.stringify(gitVerdict)}`,
		);
		check(
			"invoke:default-bash-git-force-reason-mentions-blocked",
			gitVerdict.kind === "blocked" && gitVerdict.reason.includes("blocked"),
			`reason=${gitVerdict.kind === "blocked" ? gitVerdict.reason : "n/a"}`,
		);

		const mysteryVerdict = await registry.invoke({ tool: "mystery" });
		check(
			"invoke:default-mystery-not-visible",
			mysteryVerdict.kind === "not_visible",
			`verdict=${JSON.stringify(mysteryVerdict)}`,
		);

		// --- cycleNormal -> advise ---
		const afterCycle = modes.cycleNormal();
		check("mode:advise-after-cycle", afterCycle === "advise", `got ${afterCycle}`);

		const adviseRead = await registry.invoke({ tool: "read", args: { path: "./foo" } });
		check(
			"invoke:advise-read-ok",
			adviseRead.kind === "ok" && adviseRead.result.kind === "ok",
			`verdict=${JSON.stringify(adviseRead)}`,
		);

		const adviseBash = await registry.invoke({ tool: "bash", args: { command: "ls" } });
		check("invoke:advise-bash-not-visible", adviseBash.kind === "not_visible", `verdict=${JSON.stringify(adviseBash)}`);

		const visibleAdvise = registry.listVisible().map((t) => t.name);
		check(
			"registry:visible-advise-excludes-bash",
			!visibleAdvise.includes(ToolNames.Bash),
			`visible=${visibleAdvise.join(",")}`,
		);

		await result.stop();

		const today = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(
			new Date(),
		);
		const auditPath = join(home, "data", "audit", `${today}.jsonl`);
		check("audit:file-exists", existsSync(auditPath), auditPath);
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
	await runDomainHarness();

	if (failures.length > 0) {
		process.stderr.write(`[diag-registry] FAILED ${failures.length} check(s)\n`);
		process.exit(1);
	}
	process.stdout.write("[diag-registry] PASS\n");
}

main().catch((err) => {
	process.stderr.write(`[diag-registry] crashed: ${err instanceof Error ? err.stack : String(err)}\n`);
	process.exit(1);
});
