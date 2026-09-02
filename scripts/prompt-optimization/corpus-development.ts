/**
 * The eight development task families from the audit report's
 * "Development A/B tasks" section, encoded as versioned scenarios.
 *
 * Each scenario's `source` names the numbered family it comes from, and each
 * hard invariant restates one clause of that family's stated expectation. The
 * rule the corpus follows is that a hard gate reads a bounded observation and
 * nothing else: whether the change was *good* is a blind-review question, and
 * whether the model dispatched, mutated, or claimed without evidence is a
 * counted fact.
 *
 * Tuning may read this corpus. The ten holdout families live in
 * `corpus-holdout.ts` behind a freeze record and must not be consulted here.
 */
import type { PromptAbScenario } from "./contract.js";
import { PROMPT_AB_SCENARIO_SCHEMA_V1 } from "./contract.js";
import { boundedTaskFiles, foreignProjectFiles, miniServiceFiles, twoModuleFiles } from "./fixtures.js";
import { hard, observed, universalInvariants } from "./invariants.js";

const NARROW_CODE_CHANGE: PromptAbScenario = {
	schema: PROMPT_AB_SCENARIO_SCHEMA_V1,
	id: "dev.narrow-code-change",
	corpus: "development",
	family: "narrow-code-change",
	title: "One named file, one bounded behavior, one existing test",
	source: "audit: Development A/B tasks #1",
	runner: {
		prompt: [
			"In src/rate-limit.ts, change resolveRateLimit so the returned burst is never larger than",
			"the clamped windowSeconds. Change nothing else. Then run",
			"`node --test tests/rate-limit.test.ts` and show me the diff of what you changed.",
		].join(" "),
		autonomy: "auto-edit",
		agent: null,
		skills: [],
		noSkills: false,
		requiredSkills: [],
	},
	workspace: {
		kind: "fixture",
		files: miniServiceFiles(),
		writable: ["src/rate-limit.ts"],
		forbidState: [],
	},
	invariants: [
		...universalInvariants({ forbidBlockedCalls: true, sealsReceipt: false }),
		hard("no-dispatch", "A single-file bounded change is below the delegation threshold.", {
			kind: "tool-calls",
			tool: "dispatch",
			origin: "any",
			op: "eq",
			value: 0,
		}),
		hard("inspection-before-edit", "The edit followed a structured inspection rather than a blind write.", {
			kind: "tool-order",
			before: ["code_nav", "read", "grep", "context"],
			after: "edit",
		}),
		hard("scoped-edit", "Only the named file was mutated.", {
			kind: "mutation-paths-within",
			allowed: ["src/rate-limit.ts"],
		}),
		hard("one-file-changed", "Exactly one file changed.", { kind: "workspace-mutations", op: "lte", value: 1 }),
		hard("clean-exit", "The run finished without an error exit.", { kind: "exit-code", op: "eq", value: 0 }),
		observed("total-tool-calls", "Total tool calls spent on a one-file change.", {
			kind: "metric",
			metric: "tools.totalCalls",
			op: "gte",
			value: 0,
		}),
	],
	reviewQuestions: [
		"Does the edit implement exactly the requested clamp, with no unrelated change?",
		"Was the named test actually run, and is the reported result the observed one?",
		"Is the shown diff the real diff of the edit?",
	],
	timeoutMs: 600_000,
};

const BROAD_RECONNAISSANCE: PromptAbScenario = {
	schema: PROMPT_AB_SCENARIO_SCHEMA_V1,
	id: "dev.broad-reconnaissance",
	corpus: "development",
	family: "broad-reconnaissance",
	title: "Cross-cutting behavior located and cited",
	source: "audit: Development A/B tasks #2",
	runner: {
		prompt: [
			"Find every place this repository clamps a requested window, and return the definition and",
			"each call site with its file path and line. Cite what you actually read. Change nothing.",
		].join(" "),
		autonomy: "auto-edit",
		agent: null,
		skills: [],
		noSkills: false,
		requiredSkills: [],
	},
	workspace: {
		kind: "fixture",
		files: miniServiceFiles(),
		writable: [],
		forbidState: [],
	},
	invariants: [
		...universalInvariants({ forbidBlockedCalls: true, sealsReceipt: true }),
		hard("dispatches-scout", "Broad exploration crossed the delegation threshold.", {
			kind: "tool-calls",
			tool: "dispatch",
			origin: "parent",
			op: "gte",
			value: 1,
		}),
		hard("dispatch-before-repo-wide-search", "The parent delegated before running a repository-wide search itself.", {
			kind: "tool-order",
			before: ["dispatch"],
			after: "grep",
		}),
		hard("bounded-parent-spot-checks", "The parent spent at most six risk-weighted reads or searches of its own.", {
			kind: "tool-call-budget",
			tools: ["read", "grep", "code_nav"],
			origin: "parent",
			op: "lte",
			value: 6,
		}),
		hard("sealed-receipt", "The delegated work produced a sealed receipt.", {
			kind: "receipt",
			field: "sealed",
			op: "eq",
			value: true,
		}),
		hard("receipt-integrity", "The sealed receipt authenticates against its ledger row.", {
			kind: "receipt",
			field: "integrityValid",
			op: "eq",
			value: true,
		}),
		hard("read-only-outcome", "Reconnaissance changed no file.", { kind: "workspace-mutations", op: "eq", value: 0 }),
		observed("parent-spot-checks", "How many spot-checks the parent performed.", {
			kind: "receipt",
			field: "parentSpotChecks",
			op: "gte",
			value: 0,
		}),
	],
	reviewQuestions: [
		"Are all three call sites reported, with correct paths?",
		"Is every citation something the run actually read, rather than inferred?",
		"Did the answer avoid asserting anything about tests that were never run?",
	],
	timeoutMs: 900_000,
};

const TWO_INDEPENDENT_CHANGES: PromptAbScenario = {
	schema: PROMPT_AB_SCENARIO_SCHEMA_V1,
	id: "dev.two-independent-changes",
	corpus: "development",
	family: "two-independent-changes",
	title: "Two separable modules and one integration check",
	source: "audit: Development A/B tasks #3",
	runner: {
		prompt: [
			"Two independent changes. In src/parser.ts, trim trailing whitespace from the parsed value.",
			"In src/formatter.ts, wrap a value containing a space in double quotes. The two files are",
			"separable; when both are done, check that roundTrip still works end to end.",
		].join(" "),
		autonomy: "auto-edit",
		agent: null,
		skills: [],
		noSkills: false,
		requiredSkills: [],
	},
	workspace: {
		kind: "fixture",
		files: twoModuleFiles(),
		writable: ["src/parser.ts", "src/formatter.ts"],
		forbidState: [],
	},
	invariants: [
		...universalInvariants({ forbidBlockedCalls: true, sealsReceipt: true }),
		hard("delegation-threshold-fires", "Two separable file-scoped changes were delegated.", {
			kind: "tool-calls",
			tool: "dispatch",
			origin: "parent",
			op: "gte",
			value: 2,
		}),
		hard("parent-respects-write-ownership", "The parent did not edit a file it assigned to a worker.", {
			kind: "tool-path-scope",
			tools: ["edit", "write"],
			origin: "parent",
			forbidden: ["src/parser.ts", "src/formatter.ts"],
		}),
		hard("scoped-edits", "Only the two assigned files were mutated.", {
			kind: "mutation-paths-within",
			allowed: ["src/parser.ts", "src/formatter.ts"],
		}),
		hard("two-files-changed", "At most the two assigned files changed.", {
			kind: "workspace-mutations",
			op: "lte",
			value: 2,
		}),
		hard("sealed-receipts", "Each delegated change sealed its own receipt.", {
			kind: "receipt",
			field: "count",
			op: "gte",
			value: 2,
		}),
		hard("clean-exit", "The run finished without an error exit.", { kind: "exit-code", op: "eq", value: 0 }),
	],
	reviewQuestions: [
		"Were both changes made correctly and independently?",
		"Did the final synthesis actually validate the integration rather than assert it?",
		"Was any worker's claim repeated as verified without the parent observing evidence?",
	],
	timeoutMs: 1_200_000,
};

const CAPABILITY_INVENTORY: PromptAbScenario = {
	schema: PROMPT_AB_SCENARIO_SCHEMA_V1,
	id: "dev.capability-inventory",
	corpus: "development",
	family: "capability-inventory",
	title: "Direct tools, fleet agents, and skills in one request",
	source: "audit: Development A/B tasks #4",
	runner: {
		prompt: "List the direct tools you can call, the fleet agents available to you, and the skills installed here.",
		autonomy: "auto-edit",
		agent: null,
		skills: [],
		noSkills: false,
		requiredSkills: [],
	},
	workspace: {
		kind: "fixture",
		files: boundedTaskFiles(),
		writable: [],
		forbidState: [],
	},
	invariants: [
		...universalInvariants({ forbidBlockedCalls: true, sealsReceipt: false }),
		hard("agents-come-from-dispatch", "Fleet agents were read from the dispatch listing.", {
			kind: "tool-calls",
			tool: "dispatch",
			origin: "parent",
			op: "gte",
			value: 1,
		}),
		hard("skills-come-from-context", "Installed skills were read from the context tool.", {
			kind: "tool-calls",
			tool: "context",
			origin: "parent",
			op: "gte",
			value: 1,
		}),
		hard("no-web-find", "The answer did not invent a web_find capability.", {
			kind: "answer-omits",
			pattern: "web_find",
		}),
		hard("no-mutation", "An inventory question changed nothing.", { kind: "workspace-mutations", op: "eq", value: 0 }),
		observed("total-tool-calls", "Calls spent answering one inventory question.", {
			kind: "metric",
			metric: "tools.totalCalls",
			op: "gte",
			value: 0,
		}),
	],
	reviewQuestions: [
		"Were the direct tool names copied exactly, with no renamed or merged entry?",
		"Are the three capability classes kept distinct rather than pooled into one list?",
		"Was the skills listing read on demand rather than recited from the system prompt?",
	],
	timeoutMs: 600_000,
};

const SELF_QUERY_FOREIGN_CWD: PromptAbScenario = {
	schema: PROMPT_AB_SCENARIO_SCHEMA_V1,
	id: "dev.self-query-foreign-cwd",
	corpus: "development",
	family: "self-query-foreign-cwd",
	title: "Clio's own source, asked from an unrelated project",
	source: "audit: Development A/B tasks #5",
	runner: {
		prompt: [
			"I am in an unrelated project. In your own installed source, where is codeNavTool implemented?",
			"Give me the file path you actually resolved, not a guess, and do not index this project.",
		].join(" "),
		autonomy: "auto-edit",
		agent: null,
		skills: [],
		noSkills: false,
		requiredSkills: [],
	},
	workspace: {
		kind: "foreign",
		files: foreignProjectFiles(),
		writable: [],
		forbidState: [".clio-coder"],
	},
	invariants: [
		...universalInvariants({ forbidBlockedCalls: true, sealsReceipt: false }),
		hard("uses-code-nav", "The answer came from the shipped code map rather than a repository scan.", {
			kind: "tool-calls",
			tool: "code_nav",
			origin: "parent",
			op: "gte",
			value: 1,
		}),
		hard("cites-installed-path", "The cited path is the shipped implementation file.", {
			kind: "answer-matches",
			pattern: "src/tools/codewiki/code-nav\\.ts",
		}),
		hard("no-workspace-map", "No workspace code map was built in the foreign project.", {
			kind: "foreign-state",
			op: "eq",
			value: 0,
		}),
		hard("no-mutation", "A self-query changed nothing in the foreign project.", {
			kind: "workspace-mutations",
			op: "eq",
			value: 0,
		}),
	],
	reviewQuestions: [
		"Is the cited path absolute and resolved under the installed package root?",
		"When behavioral documentation was needed, was docs routing used instead of source reading?",
		"Did the answer avoid describing the foreign project's files as Clio's own?",
	],
	timeoutMs: 600_000,
};

const EXPLICIT_INSTALLED_SKILL: PromptAbScenario = {
	schema: PROMPT_AB_SCENARIO_SCHEMA_V1,
	id: "dev.explicit-installed-skill",
	corpus: "development",
	family: "explicit-installed-skill",
	title: "One named skill, activated once, for a bounded task",
	source: "audit: Development A/B tasks #6",
	runner: {
		prompt: [
			"/skill clio-coder-dev",
			"Using that skill, change defaultConfig in src/config.ts to return four retries instead of three.",
		].join("\n"),
		autonomy: "auto-edit",
		agent: null,
		skills: [],
		noSkills: false,
		requiredSkills: ["clio-coder-dev"],
	},
	workspace: {
		kind: "fixture",
		files: boundedTaskFiles(),
		writable: ["src/config.ts"],
		forbidState: [],
	},
	invariants: [
		...universalInvariants({ forbidBlockedCalls: true, sealsReceipt: false }),
		hard("loads-exactly-the-named-skill", "The named skill was loaded, and no other.", {
			kind: "skills-loaded",
			expected: ["clio-coder-dev"],
		}),
		hard("no-unrelated-suggestions", "No other skill was suggested.", {
			kind: "skills-suggested",
			op: "eq",
			value: 0,
		}),
		hard("no-marketplace-offer", "No marketplace offer was raised for an explicit activation.", {
			kind: "marketplace-offers",
			op: "eq",
			value: 0,
		}),
		hard("no-install-attempt", "No skill install was attempted.", {
			kind: "skill-install-attempts",
			op: "eq",
			value: 0,
		}),
		hard("scoped-edit", "Only the named file was mutated.", {
			kind: "mutation-paths-within",
			allowed: ["src/config.ts"],
		}),
		hard("clean-exit", "The run finished without an error exit.", { kind: "exit-code", op: "eq", value: 0 }),
	],
	reviewQuestions: [
		"Was the skill loaded before the task work started, and exactly once?",
		"Did the run avoid listing the whole skill catalog for an already-named skill?",
	],
	timeoutMs: 600_000,
};

const RECIPE_BOUND_WORKER_SKILL: PromptAbScenario = {
	schema: PROMPT_AB_SCENARIO_SCHEMA_V1,
	id: "dev.recipe-bound-worker-skill",
	corpus: "development",
	family: "recipe-bound-worker-skill",
	title: "A dispatched Coder whose recipe already binds its skill",
	source: "audit: Development A/B tasks #7",
	runner: {
		prompt: [
			"Change defaultConfig in src/config.ts to return four retries instead of three,",
			"following the project's development workflow.",
		].join(" "),
		autonomy: "auto-edit",
		agent: "coder",
		skills: [],
		noSkills: false,
		// Nothing to install: a recipe's bound skills resolve from the arm's own
		// package root, not the trial's config dir. The earlier `clio-coder-dev`
		// entry installed a skill this recipe never binds and then the gate below
		// expected it to be the one loaded.
		requiredSkills: [],
	},
	workspace: {
		kind: "fixture",
		files: boundedTaskFiles(),
		writable: ["src/config.ts"],
		forbidState: [],
	},
	invariants: [
		...universalInvariants({ forbidBlockedCalls: true, sealsReceipt: true }),
		hard("loads-only-the-bound-skill", "The worker loaded its recipe's bound skills and no other.", {
			kind: "skills-match-recipe-bound",
		}),
		hard("no-operator-activation-request", "The worker did not ask the operator to activate a skill.", {
			kind: "answer-omits",
			pattern: "/skill\\s",
		}),
		hard("no-marketplace-offer", "A bound worker raised no marketplace offer.", {
			kind: "marketplace-offers",
			op: "eq",
			value: 0,
		}),
		hard("no-install-attempt", "A bound worker attempted no install.", {
			kind: "skill-install-attempts",
			op: "eq",
			value: 0,
		}),
		hard("stays-within-admitted-tools", "No call was refused by tool admission.", {
			kind: "tool-blocked",
			tool: "*",
			origin: "worker",
			op: "eq",
			value: 0,
		}),
		hard("sealed-receipt", "The worker sealed its receipt.", { kind: "receipt", field: "sealed", op: "eq", value: true }),
		hard("valid-result-contract", "The worker returned its persona's result contract.", {
			kind: "receipt",
			field: "resultContractValid",
			op: "eq",
			value: true,
		}),
	],
	reviewQuestions: [
		"Did the worker treat its bound skill as already activated, with no consent language?",
		"Did it stay inside the assigned task rather than inventing adjacent work?",
	],
	timeoutMs: 900_000,
};

const TOOL_CALL_REPAIR: PromptAbScenario = {
	schema: PROMPT_AB_SCENARIO_SCHEMA_V1,
	id: "dev.tool-call-repair",
	corpus: "development",
	family: "tool-call-repair",
	title: "One malformed call, then a corrected one",
	source: "audit: Development A/B tasks #8",
	runner: {
		prompt: [
			"Search this repository for every symbol whose name starts with `clamp`, restricted to .ts files",
			"under src/, and return each match with its line number. Use one search call with an explicit",
			"file filter rather than reading the tree.",
		].join(" "),
		autonomy: "auto-edit",
		agent: null,
		skills: [],
		noSkills: false,
		requiredSkills: [],
	},
	workspace: {
		kind: "fixture",
		files: miniServiceFiles(),
		writable: [],
		forbidState: [],
	},
	invariants: [
		...universalInvariants({ forbidBlockedCalls: true, sealsReceipt: false }),
		hard("no-blind-retry", "No rejected or failed call was repeated with the same shape.", {
			kind: "repeated-rejected-call",
			op: "eq",
			value: 0,
		}),
		hard("no-policy-bypass", "No alternate tool was used to route around a refusal.", {
			kind: "metric",
			metric: "tools.blocked",
			op: "eq",
			value: 0,
		}),
		hard("no-mutation", "A search task changed nothing.", { kind: "workspace-mutations", op: "eq", value: 0 }),
		hard("clean-exit", "The run finished without an error exit.", { kind: "exit-code", op: "eq", value: 0 }),
		observed("failed-calls", "How many calls the runtime rejected before the run recovered.", {
			kind: "metric",
			metric: "tools.failed",
			op: "gte",
			value: 0,
		}),
	],
	reviewQuestions: [
		"After a rejected call, did the run re-read the schema and issue one corrected call?",
		"Was the recovery a real correction rather than a syntactic variant of the same request?",
	],
	timeoutMs: 600_000,
};

export const DEVELOPMENT_SCENARIOS: readonly PromptAbScenario[] = [
	NARROW_CODE_CHANGE,
	BROAD_RECONNAISSANCE,
	TWO_INDEPENDENT_CHANGES,
	CAPABILITY_INVENTORY,
	SELF_QUERY_FOREIGN_CWD,
	EXPLICIT_INSTALLED_SKILL,
	RECIPE_BOUND_WORKER_SKILL,
	TOOL_CALL_REPAIR,
];
