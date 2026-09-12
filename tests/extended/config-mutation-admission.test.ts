import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { settingsPath, updateSettings } from "../../src/core/config.js";
import { loadDomains } from "../../src/core/domain-loader.js";
import { AgentsDomainModule } from "../../src/domains/agents/index.js";
import { type ConfigContract, ConfigDomainModule } from "../../src/domains/config/index.js";
import { ensureClioState } from "../../src/domains/lifecycle/index.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

test("config validates the actual mutation result before publishing or writing it", async () => {
	const scratch = await isolateClioEnv("clio-coder-config-admission-");
	const originalCwd = process.cwd();
	try {
		const cwd = join(scratch.dir, "workspace");
		mkdirSync(cwd);
		process.chdir(cwd);
		ensureClioState();
		const loaded = await loadDomains([ConfigDomainModule, AgentsDomainModule]);
		try {
			const config = loaded.getContract<ConfigContract>("config");
			ok(config?.set && config.update);
			const initial = structuredClone(config.get());
			const initialDocument = readFileSync(settingsPath(), "utf8");
			let publications = 0;
			const unsubscribe = config.onChange("nextTurn", () => publications++);
			try {
				const collision = structuredClone(initial);
				collision.integrations.externalAgents.entries = [{ id: "coder", command: "unstarted-fixture", args: [] }];
				for (const mode of ["in-place", "replacement", "set"] as const) {
					throws(() => {
						if (mode === "set") config.set?.(collision);
						else {
							config.update?.((settings) => {
								if (mode === "replacement") return collision;
								settings.integrations.externalAgents.entries = collision.integrations.externalAgents.entries;
								return undefined;
							});
						}
					}, /agent id collision/u);
					deepStrictEqual(config.get(), initial, mode);
					strictEqual(readFileSync(settingsPath(), "utf8"), initialDocument, mode);
					strictEqual(publications, 0, mode);
				}

				// A sibling writer has advanced the document; the domain watcher has
				// not run yet. The mutator must see this value on its only invocation.
				updateSettings((settings) => {
					settings.fleet.history.maxRuns = 37;
				});
				let invocations = 0;
				config.update((settings) => {
					invocations++;
					strictEqual(settings.fleet.history.maxRuns, 37);
					const replacement = structuredClone(settings);
					replacement.integrations.externalAgents.entries = [
						{ id: "valid-fixture", command: "unstarted-fixture", args: [] },
					];
					return replacement;
				});
				strictEqual(invocations, 1);
				strictEqual(publications, 1);
				strictEqual(config.get().fleet.history.maxRuns, 37);
				strictEqual(config.get().integrations.externalAgents.entries[0]?.id, "valid-fixture");
			} finally {
				unsubscribe();
			}
		} finally {
			await loaded.stop();
		}
	} finally {
		process.chdir(originalCwd);
		scratch.restore();
	}
});
