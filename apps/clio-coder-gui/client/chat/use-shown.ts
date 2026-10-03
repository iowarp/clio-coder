import { useEffect, useState } from "react";
import { routes } from "../../contracts/routes.js";
import type { SessionSnapshot } from "../../contracts/sessions.js";
import type { Client } from "../api/client.js";

/** Well inside the server's parking delay, and above a background tab's once-a-minute timer floor. */
const SHOWN_EVERY_MS = 60_000;

/**
 * Tell the server this window shows the task. That keeps its agent process from being parked, and a
 * parked task is resumed before the call answers. Returns why a resume failed and a way to try again.
 */
export function useShown(client: Client, id: string, state: SessionSnapshot["state"] | undefined) {
	const [failure, setFailure] = useState<string | null>(null);
	const [attempt, setAttempt] = useState(0);
	const parked = state === "parked";
	const held = state === "open" || state === "starting" || parked;
	// biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` reruns the report after a failed resume.
	useEffect(() => {
		if (!held) return;
		let current = true;
		const report = () =>
			client.call(routes.viewSession, { params: { id }, query: {}, body: {} }).then(
				() => {
					if (current) setFailure(null);
				},
				(error: unknown) => {
					// Only a resume that failed needs a reader; a missed sighting is repeated a minute later.
					if (current && parked) setFailure(error instanceof Error ? error.message : String(error));
				},
			);
		void report();
		const timer = setInterval(() => void report(), SHOWN_EVERY_MS);
		return () => {
			current = false;
			clearInterval(timer);
		};
	}, [client, id, held, parked, attempt]);
	return { failure: parked ? failure : null, retry: () => setAttempt((count) => count + 1) };
}
