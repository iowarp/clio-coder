/**
 * Typed tool presentation policy. Answers, per tool, what the transcript's
 * Standard view needs to know: does the block open folded
 * or expanded, does the folded row keep a mutation diff visible, and does a
 * failed folded row carry an output excerpt.
 *
 * The panel must not decide any of that by tool name. It asks this module,
 * which resolves the answer from two inputs: the registered presentation
 * metadata for the tool (declared once here and attached to `ToolMetadata` by
 * the builtin catalog) and the argument-sensitive resource-read rule. The
 * lookup is a plain object read, so it stays cheap enough to call on every
 * frame, and it needs no registry instance: the live chat panel has none.
 *
 * Pure module: no I/O, no registry construction, no UI imports.
 */

import os from "node:os";
import path from "node:path";
import { ToolNames } from "../core/tool-names.js";

export type ToolFoldDefault = "expanded" | "folded";

export interface ToolPresentationPolicy {
	/** How a fresh block for this call renders before the operator touches it. */
	foldDefault: ToolFoldDefault;
	/**
	 * Keep the mutation diff under the folded row. A folded `edit` that hides
	 * what it changed tells the operator nothing they could act on; the diff is
	 * the row's whole point and stays visible, bounded, until the body is opened.
	 */
	showDiffWhenFolded: boolean;
	/**
	 * Carry the last non-empty output line on a failed folded row. Bash pioneered
	 * this so a failed command stays diagnosable without opening its body; every
	 * tool that fails with text gets the same courtesy.
	 */
	failureExcerpt: boolean;
}

const FOLDED: ToolPresentationPolicy = { foldDefault: "folded", showDiffWhenFolded: false, failureExcerpt: true };
const FOLDED_WITH_DIFF: ToolPresentationPolicy = {
	foldDefault: "folded",
	showDiffWhenFolded: true,
	failureExcerpt: true,
};

/**
 * Per-tool presentation declarations. Every builtin folds by default: a
 * routine turn of six reads used to open six bodies, and the one-line row
 * already carries the call, its outcome facts, size, and settlement. Mutations
 * keep their diff under the folded row. Everything unlisted, including dynamic
 * tools, folds the same way.
 */
export const TOOL_PRESENTATION: Readonly<Record<string, ToolPresentationPolicy>> = {
	[ToolNames.Evidence]: FOLDED,
	[ToolNames.Read]: FOLDED,
	[ToolNames.Grep]: FOLDED,
	[ToolNames.Find]: FOLDED,
	[ToolNames.Ls]: FOLDED,
	[ToolNames.CodeNav]: FOLDED,
	[ToolNames.Context]: FOLDED,
	[ToolNames.CredentialPresent]: FOLDED,
	[ToolNames.ClioDocs]: FOLDED,
	[ToolNames.ClioLibrary]: FOLDED,
	[ToolNames.Data]: FOLDED,
	[ToolNames.Write]: FOLDED_WITH_DIFF,
	[ToolNames.Edit]: FOLDED_WITH_DIFF,
	[ToolNames.Bash]: FOLDED,
	[ToolNames.Git]: FOLDED,
	[ToolNames.Verify]: FOLDED,
	[ToolNames.RunScript]: FOLDED,
	[ToolNames.Dispatch]: FOLDED,
	[ToolNames.Monitor]: FOLDED,
	[ToolNames.Steer]: FOLDED,
	[ToolNames.Tasks]: FOLDED,
	[ToolNames.Ledger]: FOLDED,
	[ToolNames.Panes]: FOLDED,
	[ToolNames.Limitation]: FOLDED,
	[ToolNames.Decide]: FOLDED,
	[ToolNames.Consult]: FOLDED,
	[ToolNames.WebRead]: FOLDED,
	[ToolNames.WebFetch]: FOLDED,
	[ToolNames.AskUser]: FOLDED,
	[ToolNames.Artifact]: FOLDED,
	[ToolNames.Gateway]: FOLDED,
};

function readStringField(args: unknown, key: string): string | null {
	if (typeof args !== "object" || args === null || Array.isArray(args)) return null;
	const value = (args as Record<string, unknown>)[key];
	return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Compact resource-read classification. Reads of skill/handbook/agent
 * instruction files and docs pages collapse to one labeled line and never
 * auto-expand; their bodies are reference material, not task output.
 */
export function classifyResourceRead(toolName: string, args: unknown): string | null {
	if (toolName !== ToolNames.Read) return null;
	const path = readStringField(args, "path");
	if (path === null) return null;
	const normalized = path.replace(/\\/g, "/");
	const base = normalized.split("/").pop() ?? "";
	if (base === "SKILL.md") return "skill";
	if (base === "CLIO-CODER.md") return "handbook";
	if (base === "AGENTS.md") return "agents";
	if (/(^|\/)docs\//.test(normalized)) return "docs";
	return null;
}

/**
 * Resolve the presentation policy for one call. Argument-sensitive rules win
 * over the per-tool declaration because a resource read is a property of the
 * path, not of the `read` tool.
 */
export function toolPresentationPolicy(toolName: string, args: unknown): ToolPresentationPolicy {
	if (classifyResourceRead(toolName, args) !== null) return FOLDED;
	return TOOL_PRESENTATION[toolName] ?? FOLDED;
}

/**
 * What kind of act a call is, as the transcript shows it. Each class owns a
 * gutter mark, a pair of verbs and the facts its row states, so a read, a
 * write, a command, a fetch, a delegation, a question to the operator and a
 * call outside Clio each look different at a glance, with or without color.
 */
export type ToolClass =
	| "observe"
	| "search"
	| "knowledge"
	| "mutate"
	| "execute"
	| "network"
	| "delegate"
	| "interaction"
	| "external";

/** A call's arguments as the row composer sees them: always an object. */
export type ToolRowArgs = Readonly<Record<string, unknown>>;

/**
 * How one tool's action row reads. The renderer composes every row from this
 * and from the call's structured result; it never branches on a tool name.
 */
export interface ToolRowSpec {
	class: ToolClass;
	/** Progressive and past tense of the action, for a running and a settled row. */
	verbs: readonly [running: string, settled: string];
	/**
	 * Verbs that depend on the call's arguments: a steer that cancels, a fetch
	 * that posts, a monitor call that waits. Null keeps `verbs`.
	 */
	verbsFor?: (args: ToolRowArgs) => readonly [running: string, settled: string] | null;
	/**
	 * The row's object, from the arguments: a path, a command, a pattern, a
	 * host and path. `code` renders in backticks; `url` is shortened to its host
	 * and path tail, never the whole URL; a `path` that must be cut keeps its
	 * tail, where the file name is.
	 */
	object?: (args: ToolRowArgs, context: ToolRowContext) => { text: string; style?: "code" | "url" | "path" } | null;
	/** A qualifier after the object: a search's scope (`in src`). */
	scope?: (args: ToolRowArgs, context: ToolRowContext) => string | null;
	/** Argument fields the row states, so they are never repeated inline or as `key ›` rows. */
	consumes: readonly string[];
	/**
	 * False when a settled observation's size is not a fact worth stating. A
	 * listing counts its entries; the bytes of the listing text say nothing.
	 */
	statesSize?: false;
	/** What a folded Compact row counts this call as; the class supplies it when absent. */
	nouns?: readonly [singular: string, plural: string];
	/**
	 * The question and answer pairs a settled call resolved, from its arguments
	 * and structured result: an interview round's answers, or the decisions an
	 * interview closed with.
	 */
	pairs?: (args: ToolRowArgs, details: Readonly<Record<string, unknown>> | null) => ReadonlyArray<ToolRowPair>;
}

/** What the transcript knows about a call beyond its arguments. */
export interface ToolRowContext {
	/** A worker card sits under this call and states the run's task and outcome. */
	cardAttached?: boolean;
	/**
	 * The session workspace. A command already runs there, so a leading `cd`
	 * into it is dropped from the row and a `cd` into a subdirectory becomes the
	 * row's scope; a path inside it reads relative to it.
	 */
	cwd?: string;
}

/** One question the operator answered, or one decision recorded, as a row states it. */
export interface ToolRowPair {
	question: string;
	answer: string;
}

/** What a folded Compact row counts a call as, by class. */
export const CLASS_NOUNS: Readonly<Record<ToolClass, readonly [string, string]>> = {
	observe: ["file", "files"],
	search: ["search", "searches"],
	knowledge: ["source", "sources"],
	mutate: ["file", "files"],
	execute: ["command", "commands"],
	network: ["page", "pages"],
	delegate: ["run", "runs"],
	interaction: ["question", "questions"],
	external: ["call", "calls"],
};

const CLASS_VERBS: Readonly<Record<ToolClass, readonly [string, string]>> = {
	observe: ["reading", "read"],
	search: ["searching", "searched"],
	knowledge: ["consulting", "consulted"],
	mutate: ["editing", "edited"],
	execute: ["running", "ran"],
	network: ["fetching", "fetched"],
	delegate: ["delegating", "delegated"],
	interaction: ["asking", "asked"],
	external: ["calling", "called"],
};

function text(args: ToolRowArgs, key: string): string | null {
	const value = args[key];
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function joinDefined(...parts: ReadonlyArray<string | null | undefined>): string | null {
	const kept = parts.filter((part): part is string => typeof part === "string" && part.length > 0);
	return kept.length > 0 ? kept.join(" ") : null;
}

/**
 * A path as a row states it: relative to the workspace when it lies inside it,
 * `root` for the workspace itself, and as written anywhere else. A model that
 * sends absolute paths would otherwise start every row with the same long
 * prefix and cut the part that tells two files apart.
 */
function workspacePath(value: string | null, context: ToolRowContext, root: string | null): string | null {
	if (value === null) return null;
	const relative = workspaceRelative(value, context.cwd);
	if (relative === null) return value;
	return relative === "" ? root : relative;
}

/**
 * A path argument as a row states it. The workspace itself reads `workspace`
 * where the path is the object, and says nothing where it only narrows a
 * subject (`git status`, not `git status workspace`).
 */
function pathArg(
	args: ToolRowArgs,
	key: string,
	context: ToolRowContext,
	root: string | null = "workspace",
): string | null {
	return workspacePath(text(args, key), context, root);
}

/** The workspace root is the default scope and stays implicit. */
function searchScope(args: ToolRowArgs, context: ToolRowContext): string | null {
	const scope = text(args, "path");
	if (scope === null || scope === "." || scope === "./") return null;
	const relative = workspaceRelative(scope, context.cwd);
	return relative === "" ? null : (relative ?? scope);
}

const plain = (value: string | null) => (value === null ? null : { text: value });
const code = (value: string | null) => (value === null ? null : { text: value, style: "code" as const });
const pathObject = (value: string | null) => (value === null ? null : { text: value, style: "path" as const });

const quoted = (value: string | null) => (value === null ? null : `\`${value}\``);

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function words(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((part): part is string => typeof part === "string") : [];
}

/** A script's command line as it ran: interpreter, its flags, the script, its arguments. */
function scriptCommand(args: ToolRowArgs): string | null {
	const script = text(args, "script");
	if (script === null) return null;
	const interpreter = text(args, "interpreter");
	return [...(interpreter === null ? [] : [interpreter]), ...words(args.interpreter_args), script, ...words(args.args)]
		.map((part) => (/[\s"'`$]/u.test(part) ? JSON.stringify(part) : part))
		.join(" ");
}

function askedQuestions(args: ToolRowArgs): string | null {
	if (args.action === "complete") return "the interview";
	const questions = Array.isArray(args.questions) ? args.questions : [];
	if (questions.length > 1) return `${questions.length} questions`;
	const first = record(questions[0]);
	return first === null ? null : text(first, "question");
}

/**
 * An interview round's answers (`details.answers[{question, answer}]`), or,
 * for `action=complete`, the decisions it recorded (`details.decisions[{key,
 * value, label?}]`), which read label first.
 */
function interviewPairs(args: ToolRowArgs, details: Readonly<Record<string, unknown>> | null): ToolRowPair[] {
	const complete = args.action === "complete";
	const list = details?.[complete ? "decisions" : "answers"];
	if (!Array.isArray(list)) return [];
	const pairs: ToolRowPair[] = [];
	for (const entry of list) {
		const fields = record(entry);
		if (fields === null) continue;
		const question = complete ? (text(fields, "label") ?? text(fields, "key")) : text(fields, "question");
		const answer = text(fields, complete ? "value" : "answer");
		if (question !== null && answer !== null) pairs.push({ question, answer });
	}
	return pairs;
}

/**
 * What a dispatch call hands off. A single task reads `to <agent>: <task>`; a
 * card under the call states the task, so the row keeps only the agent. A
 * council names its roster, a compete its candidates, a batch its size.
 */
function dispatchObject(args: ToolRowArgs, context: ToolRowContext): string | null {
	if (args.list === true) return "fleet agents";
	const winner = record(args.apply_winner);
	if (winner !== null) return joinDefined("winner", text(winner, "branch"));
	const scout = record(args.from_scout);
	if (scout !== null) return joinDefined("from scout run", text(scout, "run_id"));
	const tasks = Array.isArray(args.tasks) ? args.tasks : null;
	const mode = text(args, "mode");
	const first = tasks?.[0];
	const firstRecord = record(first);
	const agent = (firstRecord === null ? null : text(firstRecord, "agent")) ?? text(args, "agent");
	const task =
		typeof first === "string"
			? first.trim() || null
			: ((firstRecord === null ? null : text(firstRecord, "task")) ?? text(args, "task"));
	const withTask = (lead: string) => (task === null || context.cardAttached === true ? lead : `${lead}: ${task}`);
	if (mode === "council") {
		const members = Array.isArray(args.members) ? args.members.length : 0;
		const who = text(args, "roster") ?? (members > 0 ? `${members} members` : null);
		return withTask(who === null ? "a council" : `a council of ${who}`);
	}
	if (mode === "compete") {
		const candidates = typeof args.candidates === "number" ? args.candidates : 2;
		return withTask(`${candidates} competing ${agent ?? "coder"}s`);
	}
	if (tasks !== null && tasks.length > 1) {
		return `${tasks.length} tasks${mode === "pipeline" ? " as a pipeline" : mode === "sequential" ? " in sequence" : ""}`;
	}
	if (agent === null && task === null) return null;
	return withTask(`to ${agent ?? "coder"}`);
}

/**
 * A plain leading `cd <dir> &&` (or `cd <dir>;`) and the command after it.
 * Anything fancier (a subshell, `pushd`, a `cd` mid-pipeline) is left alone.
 */
const LEADING_CD = /^\s*cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))\s*(?:&&|;)\s*([\s\S]+)$/u;

/** `dir` relative to the workspace: "" for the workspace itself, null outside it or when unknown. */
function workspaceRelative(dir: string, cwd: string | undefined): string | null {
	if (cwd === undefined || cwd.length === 0) return null;
	const expanded = dir.startsWith("~") ? path.join(os.homedir(), dir.slice(1)) : dir;
	const relative = path.relative(cwd, path.resolve(cwd, expanded));
	if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
	return relative;
}

/**
 * The command a bash row states and where it ran. Bash already runs at the
 * workspace root, so a model's `cd /abs/workspace && npm test` reads `npm test`
 * rather than a row that shows the path and cuts the command; a `cd` into a
 * subdirectory, or an explicit `cwd` argument, reads as ` in <dir>`. A `cd`
 * anywhere else stays in the command, where it is a fact worth seeing.
 */
function commandPlacement(
	args: ToolRowArgs,
	context: ToolRowContext,
): { command: string | null; scope: string | null } {
	const command = text(args, "command");
	const cwdArg = text(args, "cwd");
	const explicit = cwdArg === null ? null : (workspaceRelative(cwdArg, context.cwd) ?? cwdArg);
	const match = command === null ? null : LEADING_CD.exec(command);
	const dir = match === null ? undefined : (match[1] ?? match[2] ?? match[3]);
	const rest = match?.[4]?.trim();
	if (dir === undefined || rest === undefined || rest.length === 0 || cwdArg !== null) {
		return { command, scope: explicit === "" ? null : explicit };
	}
	const relative = workspaceRelative(dir, context.cwd);
	if (relative === null) return { command, scope: null };
	return { command: rest, scope: relative === "" ? null : relative };
}

const TASK_VERBS: Readonly<Record<string, readonly [string, string]>> = {
	plan: ["planning", "planned"],
	add: ["adding", "added"],
	start: ["starting", "started"],
	done: ["completing", "completed"],
	block: ["blocking", "blocked"],
	list: ["listing", "listed"],
	pick: ["picking", "picked"],
	drop: ["dropping", "dropped"],
};

const DATA_VERBS: Readonly<Record<string, readonly [string, string]>> = {
	inspect: ["inspecting", "inspected"],
	select: ["selecting from", "selected from"],
	validate: ["validating", "validated"],
};

const MONITOR_VERBS: Readonly<Record<string, readonly [string, string]>> = {
	status: ["checking", "checked"],
	peek: ["peeking at", "peeked at"],
	receipt: ["reading the receipt of", "read the receipt of"],
	tools: ["listing the tools of", "listed the tools of"],
	list: ["listing", "listed"],
	wait: ["waiting on", "waited on"],
	collect: ["collecting", "collected"],
};

const url = (args: ToolRowArgs) => {
	const value = text(args, "url");
	return value === null ? null : { text: value, style: "url" as const };
};

/**
 * The builtin table. Every builtin has exactly one row here; the class
 * decides its mark and the facts its row may state.
 */
export const TOOL_ROWS: Readonly<Record<string, ToolRowSpec>> = {
	[ToolNames.Read]: {
		class: "observe",
		verbs: CLASS_VERBS.observe,
		object: (args, context) => pathObject(pathArg(args, "path", context)),
		consumes: ["path"],
	},
	[ToolNames.Ls]: {
		class: "observe",
		verbs: ["listing", "listed"],
		nouns: ["directory", "directories"],
		object: (args, context) => pathObject(pathArg(args, "path", context) ?? "workspace"),
		consumes: ["path"],
		statesSize: false,
	},
	[ToolNames.Data]: {
		class: "observe",
		verbs: ["inspecting", "inspected"],
		verbsFor: (args) => DATA_VERBS[text(args, "op") ?? ""] ?? null,
		object: (args, context) => pathObject(pathArg(args, "path", context)),
		consumes: ["op", "path"],
	},
	[ToolNames.CredentialPresent]: {
		class: "observe",
		verbs: ["checking", "checked"],
		nouns: ["credential", "credentials"],
		object: (args) => plain(joinDefined("credential", text(args, "name"))),
		consumes: ["name"],
	},
	[ToolNames.Grep]: {
		class: "search",
		verbs: ["searching for", "searched for"],
		object: (args) => code(text(args, "pattern")),
		scope: searchScope,
		consumes: ["pattern", "path"],
	},
	[ToolNames.Find]: {
		class: "search",
		verbs: ["finding", "found"],
		object: (args) => code(text(args, "pattern")),
		scope: searchScope,
		consumes: ["pattern", "path"],
	},
	[ToolNames.CodeNav]: {
		class: "search",
		verbs: ["navigating", "navigated"],
		object: (args) => plain(joinDefined(text(args, "mode"), quoted(text(args, "query")))),
		consumes: ["mode", "query"],
	},
	[ToolNames.Context]: {
		class: "knowledge",
		verbs: CLASS_VERBS.knowledge,
		verbsFor: (args) => (args.scope === "skills" && text(args, "name") !== null ? ["loading", "loaded"] : null),
		object: (args) => {
			const scope = text(args, "scope");
			const query = quoted(text(args, "query"));
			const name = text(args, "name");
			if (scope === "skills") return plain(name === null ? joinDefined("skills", query) : `skill ${name}`);
			if (scope === "recall") return plain(joinDefined("recall", text(args, "ref") ?? query));
			return plain(joinDefined(scope, query));
		},
		consumes: ["scope", "query", "name", "ref"],
	},
	[ToolNames.ClioDocs]: {
		class: "knowledge",
		verbs: CLASS_VERBS.knowledge,
		object: (args) => plain(joinDefined("Clio docs", quoted(text(args, "query")))),
		consumes: ["query"],
	},
	[ToolNames.ClioLibrary]: {
		class: "knowledge",
		verbs: CLASS_VERBS.knowledge,
		object: (args) => plain(joinDefined("library", text(args, "ref") ?? quoted(text(args, "query")))),
		consumes: ["query", "ref"],
	},
	[ToolNames.Evidence]: {
		class: "knowledge",
		verbs: CLASS_VERBS.knowledge,
		object: (args) => plain(joinDefined("evidence", text(args, "mode"), text(args, "id") ?? text(args, "runId"))),
		consumes: ["mode", "id", "runId"],
	},
	[ToolNames.Ledger]: {
		class: "knowledge",
		verbs: CLASS_VERBS.knowledge,
		object: (args, context) => {
			const path = pathArg(args, "path", context, null);
			const line = typeof args.line === "number" ? args.line : null;
			const subject = text(args, "target") ?? (path === null || line === null ? path : `${path}:${line}`);
			return plain(joinDefined("ledger", text(args, "action"), text(args, "kind"), subject));
		},
		consumes: ["action", "kind", "target", "path", "line"],
	},
	[ToolNames.SelfCompact]: {
		class: "knowledge",
		verbs: ["compacting", "compacted"],
		object: () => plain("context"),
		// The note is the model's own reminder; /view keeps it.
		consumes: ["note_to_self"],
	},
	[ToolNames.Edit]: {
		class: "mutate",
		verbs: ["editing", "edited"],
		object: (args, context) => pathObject(pathArg(args, "path", context)),
		consumes: ["path"],
	},
	[ToolNames.Write]: {
		class: "mutate",
		verbs: ["writing", "wrote"],
		object: (args, context) => pathObject(pathArg(args, "path", context)),
		consumes: ["path"],
	},
	[ToolNames.Artifact]: {
		class: "mutate",
		verbs: ["writing", "wrote"],
		object: (args, context) => {
			const title = text(args, "title");
			const path = pathArg(args, "path", context, null);
			return plain(
				joinDefined(
					text(args, "kind") ?? "artifact",
					title === null ? null : `"${title}"`,
					path === null ? null : title === null ? path : `to ${path}`,
				),
			);
		},
		consumes: ["kind", "title", "path"],
	},
	[ToolNames.Bash]: {
		class: "execute",
		verbs: CLASS_VERBS.execute,
		object: (args, context) => code(commandPlacement(args, context).command),
		scope: (args, context) => commandPlacement(args, context).scope,
		// A timeout is stated only when the command hit it (`timed out after 30s`).
		consumes: ["command", "cwd", "timeout_ms"],
	},
	[ToolNames.RunScript]: {
		class: "execute",
		verbs: CLASS_VERBS.execute,
		object: (args) => code(scriptCommand(args)),
		consumes: ["interpreter", "interpreter_args", "script", "args"],
	},
	[ToolNames.Verify]: {
		class: "execute",
		verbs: ["checking", "checked"],
		verbsFor: (args) => (text(args, "check") === null ? ["listing", "listed"] : null),
		object: (args, context) => {
			const check = text(args, "check");
			return plain(check === null ? "checks" : joinDefined(check, pathArg(args, "path", context, null)));
		},
		consumes: ["check", "path"],
	},
	[ToolNames.Git]: {
		class: "execute",
		verbs: CLASS_VERBS.execute,
		object: (args, context) => plain(joinDefined("git", text(args, "op"), pathArg(args, "path", context, null))),
		consumes: ["op", "path"],
	},
	[ToolNames.Panes]: {
		class: "execute",
		verbs: CLASS_VERBS.execute,
		object: (args) => plain(joinDefined("panes", text(args, "action"), text(args, "target") ?? text(args, "preset"))),
		consumes: ["action", "target", "preset"],
	},
	[ToolNames.WebFetch]: {
		class: "network",
		verbs: CLASS_VERBS.network,
		// A request that writes is sent, not fetched; its method rides the row.
		verbsFor: (args) => {
			const method = text(args, "method")?.toUpperCase();
			return method === undefined || method === "GET" || method === "HEAD" ? null : ["sending", "sent"];
		},
		object: url,
		consumes: ["url"],
	},
	[ToolNames.WebRead]: {
		class: "network",
		verbs: ["reading", "read"],
		object: url,
		consumes: ["url"],
	},
	[ToolNames.Dispatch]: {
		class: "delegate",
		verbs: CLASS_VERBS.delegate,
		verbsFor: (args) =>
			args.list === true
				? ["listing", "listed"]
				: record(args.apply_winner) !== null
					? ["applying", "applied"]
					: record(args.from_scout) !== null
						? ["planning", "planned"]
						: null,
		object: (args, context) => plain(dispatchObject(args, context)),
		consumes: ["agent", "task", "tasks", "list", "mode", "roster", "members", "candidates", "from_scout", "apply_winner"],
	},
	[ToolNames.Monitor]: {
		class: "delegate",
		verbs: ["checking", "checked"],
		verbsFor: (args) => MONITOR_VERBS[text(args, "mode") ?? ""] ?? null,
		object: (args) => {
			const run = text(args, "run_id");
			const batch = text(args, "batch_id");
			const runs = words(args.run_ids).length;
			return plain(run !== null ? `run ${run}` : batch !== null ? `batch ${batch}` : runs > 0 ? `${runs} runs` : "runs");
		},
		consumes: ["run_id", "mode", "batch_id", "run_ids"],
	},
	[ToolNames.Steer]: {
		class: "delegate",
		verbs: ["steering", "steered"],
		verbsFor: (args) => (args.action === "cancel" ? ["cancelling", "cancelled"] : null),
		object: (args) => plain(text(args, "run_id") === null ? "a run" : `run ${text(args, "run_id")}`),
		consumes: ["run_id", "action"],
	},
	[ToolNames.Tasks]: {
		class: "delegate",
		verbs: ["updating", "updated"],
		verbsFor: (args) => TASK_VERBS[text(args, "action") ?? ""] ?? null,
		object: (args) => {
			const title = text(args, "title");
			return plain(joinDefined("tasks", title === null ? text(args, "id") : `"${title}"`));
		},
		consumes: ["action", "title", "id"],
	},
	[ToolNames.Consult]: {
		class: "delegate",
		verbs: CLASS_VERBS.knowledge,
		object: (args) => {
			const count = Array.isArray(args.questions) ? args.questions.length : 0;
			return plain(count === 0 ? "an advisor" : `an advisor · ${count} question${count === 1 ? "" : "s"}`);
		},
		consumes: ["questions"],
	},
	[ToolNames.AskUser]: {
		class: "interaction",
		verbs: CLASS_VERBS.interaction,
		verbsFor: (args) => (args.action === "complete" ? ["completing", "completed"] : null),
		object: (args) => plain(askedQuestions(args)),
		consumes: ["action", "mode", "questions", "max_rounds", "decisions", "summary"],
		pairs: interviewPairs,
	},
	[ToolNames.Decide]: {
		class: "interaction",
		verbs: ["deciding", "decided"],
		object: (args) => {
			const subject = text(args, "label") ?? text(args, "key");
			const value = text(args, "value");
			return plain(subject === null ? value : value === null ? subject : `${subject} → ${value}`);
		},
		consumes: ["key", "label", "value"],
	},
	[ToolNames.Limitation]: {
		class: "interaction",
		verbs: ["noting", "noted"],
		object: (args) => plain(joinDefined("limitation:", text(args, "scope"))),
		consumes: ["scope"],
	},
	[ToolNames.Gateway]: {
		class: "external",
		verbs: CLASS_VERBS.external,
		object: (args) => {
			const query = text(args, "query");
			const server = text(args, "server");
			if (args.op === "find") {
				return plain(
					joinDefined(
						"capabilities",
						server === null ? null : `on ${server}`,
						quoted(query) === null ? null : `for ${quoted(query)}`,
					),
				);
			}
			return plain(text(args, "capability"));
		},
		consumes: ["op", "query", "server", "capability", "args"],
	},
};

/** `mcp_github__search_issues` as `github › search_issues`; extensions the same way. */
function externalToolLabel(name: string): string | null {
	const match = /^(?:mcp|extension)_([a-z0-9][a-z0-9_-]*)__(.+)$/u.exec(name);
	return match?.[1] !== undefined && match[2] !== undefined ? `${match[1]} › ${match[2]}` : null;
}

const EXTERNAL_ROW: ToolRowSpec = {
	class: "external",
	verbs: CLASS_VERBS.external,
	consumes: [],
};

const ACTION_CLASS_FALLBACK: Readonly<Record<string, ToolClass>> = {
	read: "observe",
	write: "mutate",
	execute: "execute",
	system_modify: "execute",
	git_destructive: "execute",
	dispatch: "delegate",
};

export interface ResolvedToolRow {
	spec: ToolRowSpec;
	/** The capability the row is about: the gateway call's inner tool, or the tool itself. */
	toolName: string;
	/** Arguments of that capability. */
	args: ToolRowArgs;
	/** A builtin or an external capability reached through `gateway`. */
	viaGateway: boolean;
	/** `server › tool` for an MCP or extension capability. */
	externalLabel: string | null;
	/** What the transcript knows about the call beyond its arguments. */
	context: ToolRowContext;
}

function rowArgs(value: unknown): ToolRowArgs {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as ToolRowArgs) : {};
}

/**
 * Resolve the row for one call. A gateway `call` reads as the capability it
 * reached: a builtin keeps its own class and gains `via gateway`, an MCP or
 * extension capability is external. Names in the MCP and extension namespaces
 * are external wherever they appear. An unknown dynamic tool falls back by the
 * action class admission gave it, and to external when it has none.
 */
export function resolveToolRow(
	toolName: string,
	args: unknown,
	details?: unknown,
	actionClass?: string,
	context: ToolRowContext = {},
): ResolvedToolRow {
	const record = rowArgs(args);
	if (toolName === ToolNames.Gateway) {
		const op = record.op;
		const fromDetails =
			details !== null &&
			typeof details === "object" &&
			typeof (details as { capability?: unknown }).capability === "string"
				? (details as { capability: string }).capability
				: null;
		const capability = (
			fromDetails ?? (op === "call" && typeof record.capability === "string" ? record.capability : "")
		).trim();
		if (capability.length > 0 && capability !== ToolNames.Gateway && op !== "describe" && op !== "find") {
			const inner = rowArgs(record.args);
			const resolved = resolveToolRow(capability, inner, undefined, actionClass, context);
			return { ...resolved, viaGateway: true };
		}
		const spec = TOOL_ROWS[ToolNames.Gateway] as ToolRowSpec;
		if (op === "describe") {
			const described = typeof record.capability === "string" ? record.capability : "";
			return {
				spec: { ...spec, verbs: ["describing", "described"] },
				toolName,
				args: record,
				viaGateway: false,
				externalLabel: externalToolLabel(described),
				context,
			};
		}
		if (op === "find") {
			return {
				spec: { ...spec, verbs: ["searching", "searched"] },
				toolName,
				args: record,
				viaGateway: false,
				externalLabel: null,
				context,
			};
		}
		return { spec, toolName, args: record, viaGateway: false, externalLabel: null, context };
	}
	const builtin = TOOL_ROWS[toolName];
	if (builtin !== undefined) {
		const verbs = builtin.verbsFor?.(record) ?? builtin.verbs;
		return {
			spec: verbs === builtin.verbs ? builtin : { ...builtin, verbs },
			toolName,
			args: record,
			viaGateway: false,
			externalLabel: null,
			context,
		};
	}
	const label = externalToolLabel(toolName);
	if (label !== null)
		return { spec: EXTERNAL_ROW, toolName, args: record, viaGateway: false, externalLabel: label, context };
	const fallback = actionClass === undefined ? undefined : ACTION_CLASS_FALLBACK[actionClass];
	if (fallback === undefined)
		return { spec: EXTERNAL_ROW, toolName, args: record, viaGateway: false, externalLabel: null, context };
	return {
		spec: { class: fallback, verbs: CLASS_VERBS[fallback], consumes: [] },
		toolName,
		args: record,
		viaGateway: false,
		externalLabel: null,
		context,
	};
}
