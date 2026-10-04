/** How many failed checks a watchdog notice names before it counts the rest. */
export const WATCHDOG_NOTICE_CHECK_LIMIT = 3;

/**
 * The watchdog's finding, as the one transcript line it is allowed.
 *
 * A passing report renders nothing: the operator asked for a warning, not a
 * receipt, and a green line after every mutating turn is noise that trains
 * people to stop reading the channel. Only the failed checks of the
 * `verifier-report` contract reach here, and only their names: the evidence
 * body belongs to the receipt, which the operator can open. Returning null
 * means the turn passed or the report carried nothing usable.
 */
export function watchdogBlockersNotice(
	checks: ReadonlyArray<{ name: string; passed: boolean }>,
): { level: "warn"; text: string } | null {
	const failed = checks.filter((check) => !check.passed && check.name.trim().length > 0);
	if (failed.length === 0) return null;
	const named = failed.slice(0, WATCHDOG_NOTICE_CHECK_LIMIT).map((check) => check.name.trim());
	const rest = failed.length - named.length;
	const more = rest > 0 ? `, and ${rest} more` : "";
	const blockers = failed.length === 1 ? "blocker" : "blockers";
	return {
		level: "warn",
		text: `[watchdog] ${failed.length} ${blockers} after this turn: ${named.join("; ")}${more}. Nothing was changed or queued.`,
	};
}
