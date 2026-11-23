/**
 * A resolved dispatch plan in the words an operator decides on.
 *
 * The plan reaches the permission card as the sealed text the safety layer
 * approved: one `key=value` line per field, digests and all. That text is the
 * exact thing an approval covers, so it stays reachable behind the inspect key,
 * but a council card that led with `task_sha256=…` and `roster=<string 7 bytes>`
 * asked the operator to decide by reading an audit record. This reads the same
 * text back into who runs, on what, for which task, against what limit, and
 * what each route is forecast to cost.
 * Anything it cannot read leaves the card showing the plan text as before.
 */

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { formatLimit } from "../core/format-time.js";

export interface PlanMember {
	/** The council label or role the plan gives the worker, when it has one. */
	label: string | null;
	agent: string;
	target: string | null;
	model: string | null;
	task: string | null;
	/** The bounds the plan signs for this worker's run, in the plan's own words; null when it states none. */
	limits: string | null;
	/** The forecast lines the plan prints beside this worker's route, the one it runs on first; empty when it prints none. */
	forecasts: string[];
	/** Where the run writes, in the plan's own words (`none (read-only)`, `workspace`, `roots src`); null when unstated. */
	writes: string | null;
}

export interface PlanSummary {
	topology: string;
	members: PlanMember[];
	/** The one task every member runs, when they share it. */
	sharedTask: string | null;
	/** The session cost line, in words. */
	cost: string | null;
	/** The deadline line, in words; null when the plan has none. */
	deadline: string | null;
}

const HEAD = /^dispatch plan: topology=(\S+) tasks=(\d+)/u;
const TASK =
	/^\s+\d+\.(?: role=(\S+))? agent=(\S+)(?: target=(\S+))?(?: model=(\S+))?.*? task_preview=("(?:[^"\\]|\\.)*")/u;
const COUNCIL = /^\s+council label=(\S+)/u;
const LIMITS = /^\s+limits: (.+)$/u;
const FORECAST = /^\s+forecast: (.+)$/u;
const WRITES = /^\s+writes: (.+)$/u;
const COST = /^advisory session cost baseline: (.+)$/u;
const DEADLINE = /^deadline: (.+)$/u;

function preview(quoted: string): string | null {
	try {
		const value = JSON.parse(quoted);
		return typeof value === "string" ? value : null;
	} catch {
		// A preview the plan text did not quote as JSON is not one this reader can trust to show.
		return null;
	}
}

/** The plan's fields, or null when the text is not a plan this reader knows. */
export function readDispatchPlan(text: string): PlanSummary | null {
	const lines = text.split(/\r?\n/u);
	let topology: string | null = null;
	let cost: string | null = null;
	let deadline: string | null = null;
	const members: PlanMember[] = [];
	for (const line of lines) {
		const head = HEAD.exec(line);
		if (head) {
			topology = head[1] ?? null;
			continue;
		}
		const task = TASK.exec(line);
		if (task) {
			const role = task[1];
			members.push({
				label: role?.startsWith("member#") === true ? null : (role ?? null),
				agent: task[2] ?? "",
				target: task[3] ?? null,
				model: task[4] ?? null,
				task: preview(task[5] ?? ""),
				limits: null,
				forecasts: [],
				writes: null,
			});
			continue;
		}
		const council = COUNCIL.exec(line);
		const last = members.at(-1);
		if (council && last) {
			last.label = council[1] ?? last.label;
			continue;
		}
		const limits = LIMITS.exec(line);
		if (limits && last) {
			last.limits = limits[1] ?? null;
			continue;
		}
		const writes = WRITES.exec(line);
		if (writes?.[1] && last) {
			last.writes = writes[1];
			continue;
		}
		const forecast = FORECAST.exec(line);
		if (forecast?.[1] && last) {
			last.forecasts.push(forecast[1]);
			continue;
		}
		const costLine = COST.exec(line);
		if (costLine) {
			const value = costLine[1] ?? "";
			cost =
				value === "unavailable"
					? "not estimated"
					: value === "no ceiling"
						? "no session cost limit applies"
						: `counts against this session's ${value} limit`;
			continue;
		}
		const deadlineLine = DEADLINE.exec(line);
		if (deadlineLine) {
			const value = deadlineLine[1] ?? "";
			const ms = /^(\d+)ms whole-plan$/u.exec(value)?.[1];
			deadline = value.startsWith("none")
				? null
				: ms !== undefined
					? `${formatLimit(Number(ms))} for the whole plan`
					: value;
		}
	}
	if (topology === null || members.length === 0 || members.some((member) => member.agent.length === 0)) return null;
	const first = members[0]?.task ?? null;
	const sharedTask = first !== null && members.every((member) => member.task === first) ? first : null;
	return { topology, members, sharedTask, cost, deadline };
}

/**
 * One sentence for what the plan does, used where the card names the call.
 * A shared task is named in it, because the card pins this sentence beside the
 * answer keys: at 40x15 the plan section scrolled away and a council card asked
 * for approval without saying what the council would be asked.
 */
export function planHeadline(summary: PlanSummary): string {
	const count = summary.members.length;
	const workers = `${count} ${count === 1 ? "worker" : "workers"}`;
	const labels = summary.members.map((member) => member.label ?? member.agent).join(", ");
	const task = summary.sharedTask;
	switch (summary.topology) {
		case "council":
			return task !== null
				? `Council of ${count} (${labels}) answers: ${task}`
				: `Council of ${count} (${labels}) answers the same task`;
		case "compete":
			return task !== null
				? `${workers} compete on: ${task}; you pick the result to keep`
				: `${workers} compete on the same task; you pick the result to keep`;
		case "sequential":
			return `${workers} run one after another`;
		case "pipeline":
			return `${workers} run as a pipeline, each taking the last one's result`;
		case "review":
			return `A worker runs and a reviewer checks its result`;
		case "detached":
			return `${workers} start in the background`;
		default:
			return `${workers} run in parallel`;
	}
}

/** Whether the headline already names the shared task, so the plan section need not repeat it. */
function headlineNamesTask(summary: PlanSummary): boolean {
	return summary.sharedTask !== null && (summary.topology === "council" || summary.topology === "compete");
}

/** The route one task runs on, `target · model`, or the empty string when the plan names neither. */
export function planRoute(member: PlanMember): string {
	return [member.target, member.model].filter((part): part is string => part !== null).join(" · ");
}

/** Where one task may write, read from its `writes:` line (`writeModeLine`). */
type WriteBoundary = "read-only" | "workspace" | "outside" | "unstated";

/** A path with its symlinks resolved through its nearest existing ancestor, so a root not yet created still resolves. */
function realPath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		const parent = dirname(path);
		return parent === path ? path : join(realPath(parent), basename(path));
	}
}

/** Whether one stated write root lands in the workspace once `~`, `..` and symlinks are resolved. */
function rootInside(root: string, workspace: string): boolean {
	// A drive or UNC root another platform's plan states never resolves under this workspace.
	if (win32.isAbsolute(root) && !isAbsolute(root)) return false;
	const expanded = root === "~" ? homedir() : root.startsWith("~/") ? join(homedir(), root.slice(2)) : root;
	const path = relative(realPath(resolve(workspace)), realPath(resolve(workspace, expanded)));
	return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function writeBoundary(writes: string | null, workspace: string): WriteBoundary {
	if (writes === null) return "unstated";
	if (writes.startsWith("none")) return "read-only";
	const roots = /^(?:roots |own worktree, merges back only )(.+)$/u.exec(writes)?.[1];
	return roots?.split(", ").some((root) => !rootInside(root.trim(), workspace)) === true ? "outside" : "workspace";
}

const BOUNDARY_WORDS: Readonly<Record<WriteBoundary, string>> = {
	"read-only": "read-only",
	workspace: "writes in the workspace",
	outside: "writes outside the workspace",
	unstated: "write boundary not stated",
};

/** Whether one task's limits line prices its route: `cost …` is priced, `unpriced route: …` is not. */
function pricing(limits: string | null): "priced" | "unpriced" | "unknown" {
	if (limits === null) return "unknown";
	if (limits.startsWith("unpriced route")) return "unpriced";
	return limits.startsWith("cost ") ? "priced" : "unknown";
}

/** What a dispatch approval grants, built from every task and never from the first alone. */
export interface PlanScope {
	/** `read-only · unpriced route · copilot · gpt-6-luna`, `writes in the workspace · mixed pricing · 2 routes`. */
	text: string;
	/** A task writes outside the workspace, which the card states in the error role. */
	outside: boolean;
	/** Tasks run on different routes, so each plan row carries its own. */
	routesDiffer: boolean;
}

/** `workspace` is the session's working directory, which relative roots resolve against. */
export function planScope(summary: PlanSummary, workspace: string): PlanScope {
	const boundaries = new Set(summary.members.map((member) => writeBoundary(member.writes, workspace)));
	const boundary: WriteBoundary = boundaries.has("outside")
		? "outside"
		: boundaries.has("workspace")
			? "workspace"
			: boundaries.has("unstated")
				? "unstated"
				: "read-only";
	const prices = new Set(summary.members.map((member) => pricing(member.limits)));
	const price =
		prices.size > 1
			? "mixed pricing"
			: prices.has("priced")
				? "priced"
				: prices.has("unpriced")
					? "unpriced route"
					: null;
	const routes = [...new Set(summary.members.map(planRoute).filter((route) => route.length > 0))];
	const route = routes.length === 0 ? null : routes.length === 1 ? (routes[0] ?? null) : `${routes.length} routes`;
	return {
		text: [BOUNDARY_WORDS[boundary], price, route].filter((part): part is string => part !== null).join(" · "),
		outside: boundary === "outside",
		routesDiffer: routes.length > 1,
	};
}

/**
 * One task's limits line as card units (`10m per response · 30m per run · about 18 tool calls`), read from the
 * durations the plan wrote through `formatLimit`.
 */
function limitUnits(limits: string): string[] {
	const units: string[] = [];
	const cost = /^cost (\S+) per model call/u.exec(limits)?.[1];
	if (cost !== undefined) units.push(`${cost} per model call`);
	const response = /each response stops at (\S+), and /u.exec(limits)?.[1];
	if (response !== undefined) units.push(`${response} per response`);
	const wall =
		/the run stops at its (\S+) wall clock/u.exec(limits)?.[1] ?? /stops the run within ([^\s;]+)/u.exec(limits)?.[1];
	if (wall !== undefined) units.push(`${wall} per run`);
	const planned = /planned for about (\d+) tool calls/u.exec(limits)?.[1];
	const stop = /stops it at (\d+) tool calls/u.exec(limits)?.[1];
	if (planned !== undefined) units.push(`about ${planned} tool calls`);
	else if (stop !== undefined) units.push(`${stop} tool calls`);
	else if (/cannot count/u.test(limits)) units.push("tool calls not counted");
	return units;
}

/** Quoted previews are the task's own words and keep their bytes; only the fields before them are read for units. */
const QUOTED_PREVIEW = / (?:task|briefing)_preview=/u;

/**
 * The sealed plan text for the every-field view, its deadline fields in configured units: the plan states them in
 * milliseconds (`deadlineMs=none`, `timeout_ms=120000`), which no card row shows. Its limits lines already carry
 * `formatLimit` durations, and every other field keeps its sealed words.
 */
export function planDetailText(text: string): string {
	return text
		.split(/(\r?\n)/u)
		.map((line) => {
			const cut = QUOTED_PREVIEW.exec(line)?.index ?? line.length;
			const fields = line
				.slice(0, cut)
				.replace(
					/^deadline: (\d+)ms whole-plan$/u,
					(_match, ms: string) => `deadline: ${formatLimit(Number(ms))} whole-plan`,
				)
				.replace(/\bdeadlineMs=none\b/gu, "no deadline")
				.replace(/\bdeadlineMs=(\d+)\b/gu, (_match, ms: string) => `deadline ${formatLimit(Number(ms))}`)
				.replace(/\btimeout_ms=(\d+)$/u, (_match, ms: string) => `timeout ${formatLimit(Number(ms))}`);
			return `${fields}${line.slice(cut)}`;
		})
		.join("");
}

/** The plan's limits row: one value when every task shares it, else one per task in plan order. */
export function planLimits(summary: PlanSummary): { shared: string | null; perTask: Array<string | null> } {
	const perTask = summary.members.map((member) =>
		member.limits === null ? null : limitUnits(member.limits).join(" · ") || null,
	);
	const first = perTask[0] ?? null;
	return { shared: first !== null && perTask.every((value) => value === first) ? first : null, perTask };
}

/** Label and value pairs for the card's plan section, member by member. */
export function planFacts(summary: PlanSummary): Array<{ label: string; value: string }> {
	const route = planRoute;
	// Bounds every worker shares are stated once under the members; differing ones follow their worker.
	const firstLimits = summary.members[0]?.limits ?? null;
	const sharedLimits =
		firstLimits !== null && summary.members.every((member) => member.limits === firstLimits) ? firstLimits : null;
	return [
		...(summary.sharedTask !== null && !headlineNamesTask(summary) ? [{ label: "task", value: summary.sharedTask }] : []),
		...summary.members.flatMap((member, index) => [
			{
				label: member.label ?? `#${index + 1}`,
				value: [
					`${member.agent}${route(member).length > 0 ? ` on ${route(member)}` : ""}`,
					...(summary.sharedTask === null && member.task !== null ? [member.task] : []),
				].join(": "),
			},
			...(sharedLimits === null && member.limits !== null ? [{ label: "limits", value: member.limits }] : []),
			// Each route's forecast stays beside the worker it was made for, as the plan prints it.
			...member.forecasts.map((value) => ({ label: "forecast", value })),
		]),
		...(sharedLimits !== null ? [{ label: "limits", value: sharedLimits }] : []),
		...(summary.cost !== null ? [{ label: "cost", value: summary.cost }] : []),
		...(summary.deadline !== null ? [{ label: "deadline", value: summary.deadline }] : []),
	];
}
