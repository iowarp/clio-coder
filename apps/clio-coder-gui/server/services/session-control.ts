import type { ClientIdentity } from "../../contracts/auth.js";
import type { SessionControl } from "../../contracts/control.js";
import type { ClientRegistry } from "./clients.js";
import type { EventHub } from "./event-hub.js";
import { AppProblem } from "./problem.js";

/**
 * One client drives a session; every other client views it. As with an ACP resume, a live holder is
 * never displaced by an ordinary request, a holder that went away (its window closed, its stream
 * dropped and no request for a while) is claimed by the next client to act, and only an explicit
 * take-over moves control from a present holder, which the event stream tells it about.
 */
const MAX_HELD = 1024;

export class SessionControls {
	private readonly holders = new Map<string, string>();
	constructor(
		private readonly clients: ClientRegistry,
		private readonly hub: EventHub,
	) {}

	/** The present controller of a session, or null when nobody holds it or its holder went away. */
	controller(sessionId: string): ClientIdentity | null {
		const id = this.holders.get(sessionId);
		if (id === undefined || !this.clients.present(id)) return null;
		return this.clients.identity(id);
	}

	view(sessionId: string, clientId: string): SessionControl {
		const you = this.clients.identity(clientId);
		if (!you) throw new AppProblem("unauthorized", "This client is not known to the server.");
		return { sessionId, controller: this.controller(sessionId), you };
	}

	/** Lets `clientId` act on the session, claiming it when free; refuses a viewer with the holder named. */
	admit(sessionId: string, clientId: string) {
		const controller = this.controller(sessionId);
		if (controller?.clientId === clientId) return;
		if (controller) throw refusal(sessionId, controller);
		this.assign(sessionId, clientId);
	}

	/** Claims the session only when nobody present holds it, as opening one already driven elsewhere views it. */
	claimIfFree(sessionId: string, clientId: string) {
		if (!this.controller(sessionId)) this.assign(sessionId, clientId);
	}

	/** The explicit take-over. The previous holder learns of it from the `session.control` event. */
	take(sessionId: string, clientId: string): SessionControl {
		this.assign(sessionId, clientId);
		return this.view(sessionId, clientId);
	}

	/** A fork moves the live session to a new id; control moves with it. */
	move(from: string, to: string, clientId: string) {
		if (from !== to) this.release(from);
		this.assign(to, clientId);
	}

	release(sessionId: string) {
		const previous = this.controller(sessionId);
		if (!this.holders.delete(sessionId)) return;
		this.publish(sessionId, null, previous);
	}

	private assign(sessionId: string, clientId: string) {
		const previous = this.controller(sessionId);
		const held = this.holders.get(sessionId);
		if (held === undefined && this.holders.size >= MAX_HELD) this.forgetAbsent();
		this.holders.set(sessionId, clientId);
		if (held === clientId && previous?.clientId === clientId) return;
		this.publish(sessionId, this.clients.identity(clientId), previous?.clientId === clientId ? null : previous);
	}

	// Ids come from request paths, so a holder that went away is forgotten before the map grows past bound.
	private forgetAbsent() {
		for (const [sessionId, clientId] of this.holders) if (!this.clients.present(clientId)) this.holders.delete(sessionId);
	}

	private publish(sessionId: string, controller: ClientIdentity | null, previous: ClientIdentity | null) {
		this.hub.publish({ type: "session.control", payload: { resource: sessionId, controller, previous } });
	}
}

function refusal(sessionId: string, controller: ClientIdentity) {
	return new AppProblem(
		"conflict",
		`${controller.label} controls this session. Take control to act on it here; ${controller.label} will be told.`,
		undefined,
		undefined,
		{ control: { sessionId, controller } },
	);
}
