import { useEffect } from "react";
import { routes } from "../../contracts/routes.js";
import type { SessionSnapshot } from "../../contracts/sessions.js";
import type { Client } from "../api/client.js";

/** Well inside the server's parking delay, and above a background tab's once-a-minute timer floor. */
const SHOWN_EVERY_MS = 60_000;

/**
 * Keep an already live task resident while this window shows it. Viewing a parked transcript does
 * not wake its agent: the conversation's Resume action is the explicit transition back to live work.
 */
export function useShown(client: Client, id: string, state: SessionSnapshot["state"] | undefined) {
	const held = state === "open" || state === "starting";
	useEffect(() => {
		if (!held) return;
		const report = () =>
			client.call(routes.viewSession, { params: { id }, query: {}, body: {} }).catch(() => {
				// A missed sighting is repeated a minute later; it does not change the saved conversation.
			});
		void report();
		const timer = setInterval(() => void report(), SHOWN_EVERY_MS);
		return () => clearInterval(timer);
	}, [client, id, held]);
}
