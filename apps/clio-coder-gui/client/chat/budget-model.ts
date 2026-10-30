// The session cost ceiling banner's decisions, with no React, CSS or API client (#424).

import type { BudgetBlock } from "../../contracts/session-telemetry.js";

export interface BudgetBannerView {
	tone: "warn" | "quiet";
	title: string;
	detail: string;
	/** The raise button, absent once the raise has been written or the setting cannot be written here. */
	raise: { label: string; path: string; value: string } | null;
	/** Where the setting lives in this app, for the operator who wants another value. */
	settingsHref: string;
}

/** `$5.00`, with more digits for a sub-cent ceiling, matching the engine's notice. */
export function formatUsd(amount: number, ceilingUsd: number): string {
	const digits = ceilingUsd < 0.01 ? Math.min(8, Math.max(4, Math.ceil(-Math.log10(ceilingUsd)))) : 2;
	return `$${amount.toFixed(digits)}`;
}

/** The text form the settings write takes; the engine's suggestion is already rounded to four decimals. */
export function raiseSettingWrite(budget: BudgetBlock): { path: string; value: string } {
	return { path: budget.setting, value: String(budget.raiseToUsd) };
}

export function settingsHref(budget: BudgetBlock): string {
	const leaf = budget.setting.split(".").at(-1) ?? budget.setting;
	return `/settings/advanced?q=${encodeURIComponent(leaf)}`;
}

/**
 * What the banner says. While the request is parked it names the spend, the ceiling and the raise;
 * after the operator writes the raise it says so and waits for the turn to move, which clears it.
 */
export function budgetBannerView(
	budget: BudgetBlock,
	outcome: { raisedTo: string | null; error: string | null },
): BudgetBannerView {
	const spend = `${formatUsd(budget.currentUsd, budget.ceilingUsd)} of ${formatUsd(budget.ceilingUsd, budget.ceilingUsd)}`;
	const href = settingsHref(budget);
	if (outcome.raisedTo !== null) {
		return {
			tone: "quiet",
			title: `Ceiling raised to $${outcome.raisedTo}.`,
			detail: "Clio resumes the paused request within a second.",
			raise: null,
			settingsHref: href,
		};
	}
	const perCall =
		budget.contextTokens !== null && budget.contextTokens > 0
			? ` The next call sends about ${budget.contextTokens.toLocaleString("en-US")} context tokens.`
			: "";
	const failure = outcome.error !== null ? ` The raise was not saved: ${outcome.error}` : "";
	return {
		tone: "warn",
		title:
			budget.level === "over"
				? "Paid requests are paused above the session cost ceiling."
				: "Paid requests are paused at the session cost ceiling.",
		detail: `This session spent ${spend}.${perCall} Raise ${budget.setting} to continue.${failure}`,
		raise: { label: `Raise ceiling to $${budget.raiseToUsd}`, ...raiseSettingWrite(budget) },
		settingsHref: href,
	};
}
