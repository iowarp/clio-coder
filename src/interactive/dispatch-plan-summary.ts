/**
 * A resolved dispatch plan in the words an operator decides on.
 *
 * The plan reaches the permission card as the sealed text the safety layer
 * approved: one `key=value` line per field, digests and all. That text is the
 * exact thing an approval covers, so it stays reachable behind the inspect key,
 * but a council card that led with `task_sha256=…` and `roster=<string 7 bytes>`
 * asked the operator to decide by reading an audit record. This reads the same
 * text back into who runs, on what, for which task, and against what limit.
 * Anything it cannot read leaves the card showing the plan text as before.
 */

export interface PlanMember {
	/** The council label or role the plan gives the worker, when it has one. */
	label: string | null;
	agent: string;
	target: string | null;
	model: string | null;
	task: string | null;
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
			});
			continue;
		}
		const council = COUNCIL.exec(line);
		const last = members.at(-1);
		if (council && last) {
			last.label = council[1] ?? last.label;
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
			deadline = value.startsWith("none") ? null : value.replace(/ms whole-plan$/u, " ms for the whole plan");
		}
	}
	if (topology === null || members.length === 0 || members.some((member) => member.agent.length === 0)) return null;
	const first = members[0]?.task ?? null;
	const sharedTask = first !== null && members.every((member) => member.task === first) ? first : null;
	return { topology, members, sharedTask, cost, deadline };
}

/** One sentence for what the plan does, used where the card names the call. */
export function planHeadline(summary: PlanSummary): string {
	const count = summary.members.length;
	const workers = `${count} ${count === 1 ? "worker" : "workers"}`;
	const labels = summary.members.map((member) => member.label ?? member.agent).join(", ");
	switch (summary.topology) {
		case "council":
			return `Council of ${count} (${labels}) answers the same task`;
		case "compete":
			return `${workers} compete on the same task; you pick the result to keep`;
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

/** Label and value pairs for the card's plan section, member by member. */
export function planFacts(summary: PlanSummary): Array<{ label: string; value: string }> {
	const route = (member: PlanMember): string =>
		[member.target, member.model].filter((part): part is string => part !== null).join(" · ");
	return [
		...(summary.sharedTask !== null ? [{ label: "task", value: summary.sharedTask }] : []),
		...summary.members.map((member, index) => ({
			label: member.label ?? `#${index + 1}`,
			value: [
				`${member.agent}${route(member).length > 0 ? ` on ${route(member)}` : ""}`,
				...(summary.sharedTask === null && member.task !== null ? [member.task] : []),
			].join(": "),
		})),
		...(summary.cost !== null ? [{ label: "cost", value: summary.cost }] : []),
		...(summary.deadline !== null ? [{ label: "deadline", value: summary.deadline }] : []),
	];
}
