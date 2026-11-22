/**
 * Check the public API reference tariff (models/economy-rates.json) and print witness quotes.
 * Run with `pnpm economy:check`; `--as-of YYYY-MM-DD` audits row coverage on another day (default: today, UTC).
 *
 * Errors (exit 1): malformed rows, wrong units, unsourced rates or tier predicates, bad thresholds, overlapping
 * rows, gaps between a model's standard rows, a model with no current or future standard row. Warnings: a model
 * whose list price starts later (future-only), an ended promotion, a row verified more than 30 days ago.
 * Reads only the packaged file; no network.
 */

import type { TariffTokens } from "../src/domains/providers/reference-tariff.js";
import { auditReferenceTariff, quoteReferenceTariff } from "../src/domains/providers/reference-tariff.js";

function argValue(name: string): string | undefined {
	const at = process.argv.indexOf(name);
	return at >= 0 ? process.argv[at + 1] : undefined;
}

const asOf = argValue("--as-of") ?? new Date().toISOString().slice(0, 10);
const audit = auditReferenceTariff(asOf);
const models = new Set(audit.rows.map((row) => row.model));
console.log(
	`models/economy-rates.json as of ${asOf}: ${audit.rows.length} rows, ${models.size} models, errors ${audit.errors.length}, warnings ${audit.warnings.length}`,
);
for (const error of audit.errors) console.log(`  error: ${error}`);
for (const warning of audit.warnings) console.log(`  warning: ${warning}`);

const count = (n: number): string => n.toLocaleString("en-US");
function describe(tokens: TariffTokens): string {
	const parts = [];
	if (tokens.fresh > 0) parts.push(`${count(tokens.fresh)} fresh`);
	if (tokens.read > 0) parts.push(`${count(tokens.read)} read`);
	for (const [retention, n] of Object.entries(tokens.write)) if (n > 0) parts.push(`${count(n)} write ${retention}`);
	parts.push(`${count(tokens.output)} output`);
	const prompt = tokens.fresh + tokens.read + Object.values(tokens.write).reduce((sum, n) => sum + n, 0);
	return `${parts.join(" + ")} (prompt ${count(prompt)})`;
}

const witness: TariffTokens = { fresh: 0, read: 45_000, write: { "30m": 5_000 }, output: 2_000 };
const atBoundary: TariffTokens = { ...witness, fresh: 222_000 };
const overBoundary: TariffTokens = { ...witness, fresh: 222_001 };
const gemini: TariffTokens = { fresh: 5_000, read: 45_000, write: {}, output: 2_000 };
const carbonPromo = "gemini-4-carbon-introductory";
const quotes: Array<[label: string, model: string, day: string, tokens: TariffTokens, scenario?: string]> = [
	["Luna witness", "gpt-6-luna", "2026-11-22", witness],
	["Luna at the 272K short-context limit", "gpt-6-luna", "2026-11-22", atBoundary],
	["Luna one token past it", "gpt-6-luna", "2026-11-22", overBoundary],
	["Carbon last introductory day, list price", "gemini-4-carbon", "2026-11-30", gemini],
	["Carbon last introductory day, promo scenario", "gemini-4-carbon", "2026-11-30", gemini, carbonPromo],
	["Carbon first standard day, list price", "gemini-4-carbon", "2026-12-01", gemini],
	["Carbon first standard day, promo scenario", "gemini-4-carbon", "2026-12-01", gemini, carbonPromo],
	["Unpublished model", "gpt-6.2-terra", "2026-11-22", witness],
];
console.log("quotes (USD at public API list price, unrounded; an estimate, never a route price):");
for (const [label, model, day, tokens, scenario] of quotes) {
	const quote = quoteReferenceTariff(model, day, tokens, scenario !== undefined ? { scenario } : {});
	console.log(`  ${label}: ${model} on ${day}${scenario ? ` scenario ${scenario}` : ""}, ${describe(tokens)}`);
	console.log(
		quote.kind === "quoted"
			? `    = $${quote.usd}  row ${quote.rowId}  tier ${quote.tier}  verified ${quote.verifiedAt}  ${quote.source}`
			: `    = unknown: ${quote.reason}`,
	);
}
if (audit.errors.length > 0) process.exitCode = 1;
