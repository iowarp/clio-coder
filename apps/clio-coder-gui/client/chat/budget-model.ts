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
 * `parked` is whether a turn of this session is still running: the block survives a turn boundary
 * (#424), and once the operator has stopped that turn nothing is waiting to resume.
 */
export function budgetBannerView(
	budget: BudgetBlock,
	outcome: { raisedTo: string | null; error: string | null },
	parked: boolean,
): BudgetBannerView {
	const spend = `${budget.currentDisplay ?? "not measured"} of ${budget.ceilingDisplay ?? "not measured"}`;
	const href = settingsHref(budget);
	if (outcome.raisedTo !== null) {
		return {
			tone: "quiet",
			title:
				outcome.raisedTo === String(budget.raiseToUsd) && budget.raiseDisplay
					? `Ceiling raised to ${budget.raiseDisplay}.`
					: "Ceiling updated.",
			detail: parked
				? "CLIO Coder resumes the paused request within a second."
				: "The new ceiling applies to your next message.",
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
		raise: {
			label: budget.raiseDisplay ? `Raise ceiling to ${budget.raiseDisplay}` : "Raise ceiling",
			...raiseSettingWrite(budget),
		},
		settingsHref: href,
	};
}
