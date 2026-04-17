import chalk from "chalk";
import { loadDomains } from "../core/domain-loader.js";
import { ConfigDomainModule } from "../domains/config/index.js";
import { ensureInstalled } from "../domains/lifecycle/index.js";
import type { ProviderListEntry, ProvidersContract } from "../domains/providers/contract.js";
import { ProvidersDomainModule } from "../domains/providers/index.js";

export async function runProvidersCommand(args: ReadonlyArray<string>): Promise<number> {
	const json = args.includes("--json");
	ensureInstalled();
	const result = await loadDomains([ConfigDomainModule, ProvidersDomainModule]);
	const providers = result.getContract<ProvidersContract>("providers");
	if (!providers) {
		process.stderr.write("providers: domain not loaded\n");
		await result.stop();
		return 1;
	}
	const entries = providers.list();
	if (json) {
		process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`);
	} else {
		for (const e of entries) {
			renderLine(e);
		}
	}
	await result.stop();
	return 0;
}

function renderLine(e: ProviderListEntry): void {
	const badge = e.available ? chalk.green("ok ") : chalk.dim("off");
	const status =
		e.health.status === "healthy"
			? chalk.green(e.health.status)
			: e.health.status === "degraded"
				? chalk.yellow(e.health.status)
				: e.health.status === "down"
					? chalk.red(e.health.status)
					: chalk.dim(e.health.status);
	process.stdout.write(`${badge}  ${e.id.padEnd(12)} ${status.padEnd(16)} ${e.displayName}\n`);
}
