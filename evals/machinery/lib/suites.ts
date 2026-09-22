/**
 * The one table every machinery suite is generated from.
 *
 * It carries no implementation, so the suite generator and the contract test
 * can read it without loading the domains a scenario exercises. `suite-gen.ts`
 * renders one YAML file per entry and `driver.ts` resolves a scenario id
 * against the matching entry before it runs anything.
 */

export interface MachinerySuite {
	/** File stem of the suite, its baseline, and the driver's `--suite` value. */
	name: string;
	/** Suite id recorded in the artifact and the baseline file. */
	id: string;
	title: string;
	description: string;
	/** Scenario ids in the order their tasks are written. */
	scenarios: ReadonlyArray<string>;
}

/**
 * Metrics the driver reports that are a property of the harness rather than of
 * the machine it ran on. `task.solved` is the measure command's exit status and
 * the digest fingerprints the observed behavior. Wall time, RSS and CPU are
 * none of those, so the driver never prints them: pinning a machine property
 * would fail the check on a busier laptop and teach everyone to ignore it.
 */
export const BASELINE_PIN = ["task.solved", "custom.digest.behavior"];

export const MACHINERY_SUITES: ReadonlyArray<MachinerySuite> = [
	{
		name: "dispatch-admission",
		id: "machinery-dispatch-admission",
		title: "Machinery, dispatch admission authority",
		description:
			"Worker permission ceilings, approval reuse scoping and deny/stop semantics, measured through the production admission and safety seams with a scripted worker.",
		scenarios: [
			"worker-autonomy-ceiling",
			"autonomy-disposition-matrix",
			"worker-scope-subset",
			"approval-axis-scoping",
			"approval-reuse-scoping",
			"deny-stop-semantics",
			"sealed-autonomy-enforcement",
		],
	},
	{
		name: "prompt-compile",
		id: "machinery-prompt-compile",
		title: "Machinery, prompt compilation layering",
		description:
			"Prompt layer ordering, the layout version its manifest records, and the capability and role guidance that renders only when the surface carries the tool it describes.",
		scenarios: [
			"section-order-volatility",
			"layout-version",
			"conditional-capability-guidance",
			"stable-prefix-invariance",
			"skill-activation-policy",
			"worker-prompt-layers",
		],
	},
];

export function machinerySuite(name: string): MachinerySuite {
	const suite = MACHINERY_SUITES.find((entry) => entry.name === name);
	if (suite === undefined) {
		throw new Error(
			`unknown machinery suite: ${name}; expected one of ${MACHINERY_SUITES.map((s) => s.name).join(", ")}`,
		);
	}
	return suite;
}

/** Task id for one scenario. It names its suite, so ids stay unique across the artifact store. */
export function machineryTaskId(suite: MachinerySuite, scenario: string): string {
	return `${suite.name}.${scenario}`;
}
