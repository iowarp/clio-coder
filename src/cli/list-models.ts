import chalk from "chalk";

import { PROVIDER_CATALOG, type ProviderSpec } from "../domains/providers/catalog.js";
import { resolveModelPattern } from "../domains/providers/resolver.js";

export interface ListModelsOptions {
	search?: string;
	stdout?: (line: string) => void;
}

export function listModels(options: ListModelsOptions = {}): number {
	const write = options.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
	const search = (options.search ?? "").trim();
	if (search.length === 0) {
		for (const provider of PROVIDER_CATALOG) {
			writeProviderBlock(provider, write);
		}
		return 0;
	}
	const { matches, diagnostic } = resolveModelPattern(search, { fuzzy: true });
	if (matches.length === 0) {
		process.stderr.write(`${chalk.red("no matches")}: ${diagnostic ?? search}\n`);
		return 1;
	}
	const byProvider = new Map<string, string[]>();
	for (const ref of matches) {
		const bucket = byProvider.get(ref.providerId) ?? [];
		bucket.push(ref.modelId);
		byProvider.set(ref.providerId, bucket);
	}
	for (const [providerId, models] of byProvider) {
		write(chalk.bold(providerId));
		for (const id of models) write(`  ${id}`);
	}
	return 0;
}

function writeProviderBlock(provider: ProviderSpec, write: (line: string) => void): void {
	write(chalk.bold(`${provider.id} (${provider.tier})`));
	if (provider.models.length === 0) {
		write(chalk.dim("  (no baked models; configure endpoints in settings.yaml)"));
		return;
	}
	for (const model of provider.models) {
		const ctx = `${Math.round(model.contextWindow / 1000)}k`;
		const thinking = model.thinkingCapable ? "thinking" : "";
		const price =
			model.pricePer1MInput !== undefined && model.pricePer1MOutput !== undefined
				? `$${model.pricePer1MInput}/${model.pricePer1MOutput} per 1M`
				: "";
		const labels = [ctx, thinking, price].filter(Boolean).join("  ");
		write(`  ${model.id.padEnd(32)} ${chalk.dim(labels)}`);
	}
}
