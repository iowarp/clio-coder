/**
 * Phase 4 slice 7 diag. Wires Config + Safety + Modes + Agents against an
 * ephemeral CLIO_HOME and asserts the agents contract flows:
 *   - list() returns >= 7 builtin recipes (the seven shipped fleet members)
 *   - each required builtin id is present
 *   - get("scout") returns a recipe with mode === "advise"
 *   - writing a user-level override + calling reload() flips get("scout") to
 *     the override (different name)
 *   - parseFleet("scout -> worker") returns two steps with matching ids
 *
 * Mirrors the hermeticity pattern from diag-modes.ts + diag-providers.ts.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const failures: string[] = [];

function check(label: string, ok: boolean, detail?: string): void {
	if (ok) {
		process.stdout.write(`[diag-agents] OK   ${label}\n`);
		return;
	}
	failures.push(detail ? `${label}: ${detail}` : label);
	process.stderr.write(`[diag-agents] FAIL ${label}${detail ? ` — ${detail}` : ""}\n`);
}

const REQUIRED_BUILTINS = [
	"scout",
	"planner",
	"worker",
	"reviewer",
	"context-builder",
	"researcher",
	"delegate",
] as const;

async function run(): Promise<void> {
	const home = mkdtempSync(join(tmpdir(), "clio-diag-agents-"));
	const ENV_KEYS = ["CLIO_HOME", "CLIO_DATA_DIR", "CLIO_CONFIG_DIR", "CLIO_CACHE_DIR"] as const;
	const snapshot = new Map<string, string | undefined>();
	for (const k of ENV_KEYS) snapshot.set(k, process.env[k]);
	for (const k of ["CLIO_DATA_DIR", "CLIO_CONFIG_DIR", "CLIO_CACHE_DIR"] as const) {
		delete process.env[k];
	}
	process.env.CLIO_HOME = home;

	try {
		writeFileSync(join(home, "settings.yaml"), "");

		const { resetXdgCache, clioDataDir } = await import("../src/core/xdg.js");
		resetXdgCache();
		const { resetSharedBus } = await import("../src/core/shared-bus.js");
		resetSharedBus();
		const { resetPackageRootCache } = await import("../src/core/package-root.js");
		resetPackageRootCache();

		const { loadDomains } = await import("../src/core/domain-loader.js");
		const { ConfigDomainModule } = await import("../src/domains/config/index.js");
		const { SafetyDomainModule } = await import("../src/domains/safety/index.js");
		const { ModesDomainModule } = await import("../src/domains/modes/index.js");
		const { AgentsDomainModule } = await import("../src/domains/agents/index.js");

		const result = await loadDomains([ConfigDomainModule, SafetyDomainModule, ModesDomainModule, AgentsDomainModule]);
		check("domain:loaded", result.loaded.includes("agents"), `loaded=${result.loaded.join(",")}`);

		type AgentsContractType = import("../src/domains/agents/contract.js").AgentsContract;
		const agents = result.getContract<AgentsContractType>("agents");
		check("domain:contract-exposed", agents !== undefined);
		if (!agents) {
			await result.stop();
			return;
		}

		const initial = agents.list();
		check("list:has-at-least-7", initial.length >= 7, `len=${initial.length}`);

		const ids = new Set(initial.map((r) => r.id));
		for (const required of REQUIRED_BUILTINS) {
			check(`list:has-${required}`, ids.has(required), `ids=${Array.from(ids).join(",")}`);
		}

		const scout = agents.get("scout");
		check("get:scout-returned", scout !== null, `got=${scout ? scout.id : "null"}`);
		check("get:scout-mode-advise", scout?.mode === "advise", `mode=${scout?.mode ?? "undefined"}`);
		check("get:scout-name-Scout", scout?.name === "Scout", `name=${scout?.name ?? "undefined"}`);
		check("get:scout-source-builtin", scout?.source === "builtin", `source=${scout?.source ?? "undefined"}`);

		const unknown = agents.get("definitely-not-a-recipe");
		check("get:unknown-null", unknown === null, `got=${JSON.stringify(unknown)}`);

		const userAgentsDir = join(clioDataDir(), "agents");
		mkdirSync(userAgentsDir, { recursive: true });
		const overridePath = join(userAgentsDir, "scout.md");
		writeFileSync(
			overridePath,
			[
				"---",
				"name: Scout-Override",
				"description: User override for scout during diag.",
				"mode: advise",
				"runtime: native",
				"---",
				"",
				"# Scout Override",
				"Diag-only override body.",
				"",
			].join("\n"),
		);

		agents.reload();

		const afterReload = agents.get("scout");
		check("reload:scout-returned", afterReload !== null, `got=${afterReload ? afterReload.id : "null"}`);
		check("reload:scout-source-user", afterReload?.source === "user", `source=${afterReload?.source ?? "undefined"}`);
		check(
			"reload:scout-name-overridden",
			afterReload?.name === "Scout-Override" && afterReload?.name !== "Scout",
			`name=${afterReload?.name ?? "undefined"}`,
		);

		const fleet = agents.parseFleet("scout -> worker");
		check("parseFleet:two-steps", fleet.steps.length === 2, `len=${fleet.steps.length}`);
		check(
			"parseFleet:step-ids",
			fleet.steps[0]?.recipeId === "scout" && fleet.steps[1]?.recipeId === "worker",
			`ids=${fleet.steps.map((s) => s.recipeId).join(",")}`,
		);

		await result.stop();
	} finally {
		for (const [k, v] of snapshot) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		try {
			rmSync(home, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	}
}

async function main(): Promise<void> {
	await run();
	if (failures.length > 0) {
		process.stderr.write(`[diag-agents] FAILED ${failures.length} check(s)\n`);
		process.exit(1);
	}
	process.stdout.write("[diag-agents] PASS\n");
}

main().catch((err) => {
	process.stderr.write(`[diag-agents] crashed: ${err instanceof Error ? err.stack : String(err)}\n`);
	process.exit(1);
});
