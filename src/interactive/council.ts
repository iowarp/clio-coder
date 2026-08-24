/**
 * `/council [--roster <name>] [--rounds <n>] [--synthesis judge|vote|none] <task>`:
 * the roster an operator-typed council resolves to and the dispatch-tool
 * arguments it becomes.
 *
 * The command owns no execution path of its own. It shapes the same arguments
 * a model would pass to the dispatch tool and hands them to the tool registry,
 * so admission, the approval overlay under supervised autonomy, receipts, and
 * the Fleet Runs board treat an operator council exactly as they treat one the
 * model asked for.
 *
 * Pure: no I/O, no bus, no session, no dispatch. The caller owns the run.
 */

/**
 * The roster `--roster` falls back to. It is an ordinary roster name, so an
 * operator declares it the same way they declare any other one, and a project
 * with no roster called `default` gets the refusal rather than a guess.
 */
export const COUNCIL_DEFAULT_ROSTER = "default";

/** Synthesis modes the dispatch tool declares, in the order the usage line lists them. */
export const COUNCIL_SYNTHESIS_MODES = ["judge", "vote", "none"] as const;
export type CouncilSynthesisMode = (typeof COUNCIL_SYNTHESIS_MODES)[number];

/** Rounds the dispatch tool admits. The command enforces the same bound where the operator typed it. */
export const COUNCIL_MAX_ROUNDS = 3;

export function isCouncilSynthesisMode(value: string): value is CouncilSynthesisMode {
	return COUNCIL_SYNTHESIS_MODES.some((mode) => mode === value);
}

/** What the command needs to know about a configured roster: that it exists and how many members it seats. */
export interface CouncilRosterFacts {
	members: ReadonlyArray<unknown>;
}

export type CouncilRosters = Readonly<Record<string, CouncilRosterFacts>>;

export interface CouncilCommandOptions {
	roster?: string;
	rounds?: number;
	synthesis?: CouncilSynthesisMode;
}

export type CouncilRosterResolution = { ok: true; roster: string } | { ok: false; reason: string };

/**
 * The notice a session with no roster and no `--roster` gets. It names the
 * setting rather than the failure, because an operator who types `/council`
 * without a roster has not made a mistake. They have not declared one yet.
 */
export const COUNCIL_NO_ROSTER_NOTICE =
	`/council needs a roster. Declare one under workers.rosters in settings.yaml, for example ` +
	`workers.rosters.${COUNCIL_DEFAULT_ROSTER} with two to five members, each with a label and a target, ` +
	`then run /council <task> or name another roster with --roster <name>.`;

function knownRosterNames(rosters: CouncilRosters): string[] {
	return Object.keys(rosters).sort();
}

/**
 * Which roster this council runs. A named roster must exist; an unnamed one
 * resolves to `workers.rosters.default` when that roster exists. Neither is
 * guessed from the roster list: seating a council from whichever roster happens
 * to be first would run models the operator never chose.
 */
export function resolveCouncilRoster(requested: string | undefined, rosters: CouncilRosters): CouncilRosterResolution {
	const known = knownRosterNames(rosters);
	const wanted = requested?.trim();
	if (wanted !== undefined && wanted.length > 0) {
		if (Object.hasOwn(rosters, wanted)) return { ok: true, roster: wanted };
		const names = known.length === 0 ? "none are configured" : `configured rosters: ${known.join(", ")}`;
		return { ok: false, reason: `no roster named "${wanted}" in workers.rosters (${names})` };
	}
	if (Object.hasOwn(rosters, COUNCIL_DEFAULT_ROSTER)) return { ok: true, roster: COUNCIL_DEFAULT_ROSTER };
	return { ok: false, reason: COUNCIL_NO_ROSTER_NOTICE };
}

/**
 * The dispatch-tool arguments this council becomes. Field names and value
 * domains are the tool's own (`mode`, `roster`, `rounds`, `synthesis`), so the
 * command adds no second grammar for the same contract. Defaults are left out
 * rather than restated: the tool declares `rounds` 1 and `synthesis` none, and
 * a caller that repeats them only creates a second place for them to drift.
 */
export function buildCouncilDispatchArgs(
	task: string,
	roster: string,
	options: CouncilCommandOptions = {},
): Record<string, unknown> {
	return {
		mode: "council",
		task,
		roster,
		...(options.rounds !== undefined ? { rounds: options.rounds } : {}),
		...(options.synthesis !== undefined ? { synthesis: options.synthesis } : {}),
	};
}
