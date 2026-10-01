// The server holds at most a few ACP children at once (`Supervisor.capacity`). A task list makes that
// limit easy to reach, and "At most 4 sessions can be open" is not something an operator can act on.
// So a start or a resume that meets the limit closes the least recently active idle task, says so,
// and tries once more. Closing is not destructive: the ledger stays saved and the task reopens from
// the list. A task that is working or waiting for approval is never chosen.

import type { QueryClient } from "@tanstack/react-query";
import { routes } from "../../contracts/routes.js";
import type { SessionSnapshot } from "../../contracts/sessions.js";
import { ApiProblem, type Client, emptyInput } from "../api/client.js";
import { sessionBuffer } from "../api/sessions.js";
import { notify } from "../design/notifications.js";
import { taskState, taskTitle } from "./shell-model.js";

const CAPACITY = /sessions can be open at once/;

export function isCapacityRefusal(error: unknown): boolean {
	return error instanceof ApiProblem && error.problem.code === "conflict" && CAPACITY.test(error.problem.detail);
}

function lastActive(session: SessionSnapshot): number {
	const turn = session.turns.at(-1);
	const at = Date.parse(turn?.finishedAt ?? turn?.startedAt ?? "");
	return Number.isFinite(at) ? at : 0;
}

/** Oldest first, with an untouched draft ahead of everything because dropping it loses nothing. */
export function evictionOrder(sessions: readonly SessionSnapshot[]): SessionSnapshot[] {
	return sessions
		.filter(
			(session) => session.state === "open" && taskState(session) !== "working" && taskState(session) !== "approval",
		)
		.sort((a, b) => Number(b.turns.length === 0) - Number(a.turns.length === 0) || lastActive(a) - lastActive(b));
}

async function freeOneSlot(client: Client, queries: QueryClient): Promise<string | null> {
	const sessions = await queries.fetchQuery({
		queryKey: ["sessions"],
		queryFn: () => client.call(routes.sessions, emptyInput),
		staleTime: 0,
	});
	const victim = evictionOrder(sessions)[0];
	if (!victim) return null;
	const title = taskTitle(victim);
	const closed = await client.call(routes.closeSession, { params: { id: victim.id }, query: {}, body: {} });
	queries.setQueryData(["session", closed.id], sessionBuffer(closed.id).snapshot(closed) ?? closed);
	void queries.invalidateQueries({ queryKey: ["sessions"] });
	void queries.invalidateQueries({ queryKey: ["session-history", closed.workspaceId] });
	notify({
		tone: "info",
		title: `Closed “${title}” to make room`,
		detail: "It stays in your history. Open it from the task list to continue.",
	});
	return title;
}

/** Run an operation that needs a free session slot, making one when the server says there is none. */
export async function withRoom<T>(client: Client, queries: QueryClient, attempt: () => Promise<T>): Promise<T> {
	try {
		return await attempt();
	} catch (error) {
		if (!isCapacityRefusal(error)) throw error;
		if ((await freeOneSlot(client, queries)) === null)
			throw new ApiProblem({
				type: "urn:clio-coder:problem:conflict",
				title: "Every open task is busy",
				status: 409,
				code: "conflict",
				detail: "Every open task is working or waiting for you. Let one finish, or stop it, then start another.",
				instance: "browser",
			});
		return attempt();
	}
}
