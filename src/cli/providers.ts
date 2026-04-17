import chalk from "chalk";
import { loadDomains } from "../core/domain-loader.js";
import { ConfigDomainModule } from "../domains/config/index.js";
import { ensureInstalled } from "../domains/lifecycle/index.js";
import type { ProviderEndpointEntry, ProviderListEntry, ProvidersContract } from "../domains/providers/contract.js";
import { ProvidersDomainModule } from "../domains/providers/index.js";

export async function runProvidersCommand(args: ReadonlyArray<string>): Promise<number> {
	const json = args.includes("--json");
	const skipProbe = args.includes("--no-probe");
	ensureInstalled();
	const result = await loadDomains([ConfigDomainModule, ProvidersDomainModule]);
	const providers = result.getContract<ProvidersContract>("providers");
	if (!providers) {
		process.stderr.write("providers: domain not loaded\n");
		await result.stop();
		return 1;
	}
	if (!skipProbe) {
		try {
			await providers.probeEndpoints();
		} catch (err) {
			process.stderr.write(`providers: endpoint probe failed: ${err instanceof Error ? err.message : String(err)}\n`);
		}
	}
	const entries = providers.list();
	if (json) {
		process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`);
	} else {
		for (const e of entries) {
			renderEntry(e);
		}
	}
	await result.stop();
	return 0;
}

function renderEntry(e: ProviderListEntry): void {
	if (e.endpoints !== undefined) {
		renderLocalEngine(e);
		return;
	}
	renderRemoteProvider(e);
}

function renderRemoteProvider(e: ProviderListEntry): void {
	const badge = e.available ? chalk.green("ok ") : chalk.dim("off");
	const status =
		e.health.status === "healthy"
			? chalk.green(e.health.status)
			: e.health.status === "degraded"
				? chalk.yellow(e.health.status)
				: e.health.status === "down"
					? chalk.red(e.health.status)
					: chalk.dim(e.health.status);
	process.stdout.write(`${badge}  ${e.id.padEnd(14)} ${status.padEnd(16)} ${e.displayName}\n`);
}

function renderLocalEngine(e: ProviderListEntry): void {
	const endpoints = e.endpoints ?? [];
	const total = endpoints.length;
	const healthy = endpoints.filter((ep) => ep.probe?.ok === true).length;
	const unreachable = endpoints.filter((ep) => ep.probe && ep.probe.ok === false).length;
	const summary =
		total === 0
			? `${e.id} (0 endpoints)`
			: `${e.id} (${total} endpoint${total === 1 ? "" : "s"}, ${healthy} healthy${
					unreachable > 0 ? `, ${unreachable} unreachable` : ""
				})`;
	process.stdout.write(`${chalk.bold(summary)}\n`);
	for (const ep of endpoints) {
		process.stdout.write(`  ${formatEndpoint(ep)}\n`);
	}
}

function formatEndpoint(ep: ProviderEndpointEntry): string {
	const name = ep.name.padEnd(14);
	const url = ep.url.padEnd(32);
	if (!ep.probe) {
		return `${name} ${url} ${chalk.dim("not probed")}`;
	}
	if (ep.probe.ok) {
		const models = ep.probe.models ?? [];
		const sample = models.slice(0, 3).join(", ");
		const more = models.length > 3 ? `, +${models.length - 3} more` : "";
		return `${name} ${url} ${chalk.green("ok")}, ${models.length} models${models.length > 0 ? ` (${sample}${more})` : ""}`;
	}
	return `${name} ${url} ${chalk.red(ep.probe.error ?? "unreachable")}`;
}
