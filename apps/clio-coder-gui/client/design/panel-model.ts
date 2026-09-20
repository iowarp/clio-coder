// The words an inspector panel is made of. Every panel opens with an eyebrow that says whose data
// this is and what the panel may do to it, and closes with a sentence naming what stays on this
// machine. Both live here, as data, so the gate can hold the vocabulary to its own rules and so a
// component never has to invent a sentence.

export interface PanelCopy {
	/** Scope first, mutability last, uppercase, separated by " · ". */
	eyebrow: string;
	title: string;
	/** What stays on this machine, named exactly. Never boilerplate; each panel has its own. */
	boundary: string;
}

/** Uppercase, " · "-joined. The last segment is the mutability, which is why it is a separate argument. */
export function eyebrow(scope: string, ...qualifiers: string[]): string {
	return [scope, ...qualifiers].map((part) => part.toUpperCase()).join(" · ");
}

export const READ_ONLY = "read only";

export const PANELS = {
	evidenceInventory: {
		eyebrow: eyebrow("Evidence bundles", "installation-wide", "collect and recheck"),
		title: "Evidence",
		boundary:
			"Bundles are read from this installation's evidence directory. Collecting or rechecking runs the same Clio command you would run yourself, on this machine; no bundle is edited and nothing is uploaded.",
	},
	evidenceBundle: {
		eyebrow: eyebrow("Evidence bundle", "one dispatch report", "collect and recheck"),
		title: "Evidence",
		boundary:
			"A bundle is reproduced as it was collected. Its files stay in the evidence directory on this machine, and nothing here re-runs the work the bundle describes.",
	},
	evidenceTrust: {
		eyebrow: eyebrow("Trust projection", "one dispatch run", READ_ONLY),
		title: "Trust by run",
		boundary:
			"The receipt itself stays in the bundle on this machine. What this panel shows is the recorded trust projection: its authorities, its artifact digests, and the reason each axis holds or does not.",
	},
	evidenceGates: {
		eyebrow: eyebrow("Gate decisions", "sealed coordinator verdicts", READ_ONLY),
		title: "Authenticated gate decisions",
		boundary:
			"A decision is reproduced from the bundle on this machine, exactly as the coordinator sealed it. Nothing here re-runs a gate, and an intact decision authenticates the record rather than the work it describes.",
	},
	evalReports: {
		eyebrow: eyebrow("Eval reports", "installation-wide", READ_ONLY),
		title: "Evals",
		boundary:
			"Reports are read from the eval store on this machine. This page runs no evaluation and writes no report; every figure is what the run recorded when it finished.",
	},
	evalReport: {
		eyebrow: eyebrow("Eval report", "one suite", READ_ONLY),
		title: "Evaluation results",
		boundary:
			"Every figure is what this run recorded when it finished. Opening the report runs nothing and changes nothing in the eval store on this machine.",
	},
	evalTrials: {
		eyebrow: eyebrow("Trials", "one report", READ_ONLY),
		title: "Trials",
		boundary:
			"Trial attachments, transcripts and prompts stay in the report on this machine. What this panel shows is each trial's recorded verdict and its measurements.",
	},
	usage: {
		eyebrow: eyebrow("Recorded usage", "30-day window", READ_ONLY),
		title: "Usage",
		boundary:
			"Every figure is read from the session and dispatch ledgers on this machine and is Clio's own accounting, never an estimate made here. Conversation text stays in those ledgers.",
	},
	traceRun: {
		eyebrow: eyebrow("Durable accounting", "trace database", READ_ONLY),
		title: "Run accounting",
		boundary:
			"The trace database stays on this machine and this page only reads it. Event payloads and process command lines are shown from that local database; what the histograms cross with is how many of each kind there were.",
	},
	toolchain: {
		eyebrow: eyebrow("Pinned tools", "this installation", "install and remove"),
		title: "Toolchain",
		boundary:
			"Resolution is read from this machine: a compatible copy on PATH first, then the pinned copy Clio vendored. Removing a vendored copy leaves your PATH installation in place.",
	},
	routing: {
		eyebrow: eyebrow("Models", "worker routing", "read offline"),
		title: "Models and routing",
		boundary:
			"This inventory is read from cached configuration on this machine. No endpoint is contacted, so a listed model is a recorded capability and not a live reachability claim.",
	},
} as const satisfies Record<string, PanelCopy>;

export type PanelId = keyof typeof PANELS;

/**
 * The four states a panel distinguishes when it has nothing to show, plus the sentence every
 * bounded list owes. They are different facts and they never share a sentence: a store that was
 * never created is not a store that is empty, and neither one is a health claim.
 */
export const emptyState = {
	/** 1. Nothing has asked for it yet in this session. */
	unread: (subject: string) => `The ${subject} has not been read in this session.`,
	/** 2. The store itself is absent. */
	missingStore: (subject: string, path?: string | null) =>
		`This installation has no ${subject} store at all. That is a missing store, not an empty one.${
			path ? ` Clio Coder looked for it at ${path}.` : ""
		}`,
	/** 3. The store is there and holds nothing. `where` narrows the claim to one record. */
	emptyStore: (subject: string, where = "on this installation") =>
		`Clio Coder has recorded no ${subject} ${where}. This is an empty record, not a health claim.`,
	/** 4. The record is older than the projection being asked for. */
	predatesSchema: (record: string, projection: string, items: string) =>
		`This ${record} predates the canonical ${projection}, so it records no ${items} to open.`,
	/** And the fifth, for every bounded list. */
	bounded: (subject: string, edge: "Older" | "Later" = "Older") => `${edge} ${subject} are outside this bounded view.`,
	/** What a dash in a figure means, wherever a missing store can produce one. */
	dash: () => "A dash means Clio Coder could not find that local history store. It does not mean zero activity.",
} as const;
