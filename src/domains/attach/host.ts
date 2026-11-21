/**
 * The host side of an attach: one hub per running session that admits
 * clients, hands each the stream its role may see, and routes the commands its
 * role may send to the session.
 *
 * Three things are deliberately not decided here, each behind its own
 * interface: how bytes travel (`AttachTransport`, which hands the hub one
 * `AttachConnection` per client), who may hold which role (`AttachConsent`,
 * the ceiling the host admits for a client), and what the session does with
 * an answer or a pair message (`AttachSessionPort`). The hub owns only the
 * rules every choice of those shares: the role a client holds is the lower of
 * what it asked for and the ceiling; a command its role does not allow is
 * refused before the session sees it; and every client action, admitted or
 * refused, is put in front of the host as a notice that names the client.
 *
 * Nothing a client sends can throw into the host: a parse failure, a refused
 * command and a session port that throws all end as an `error` event to that
 * client.
 */

import {
	ATTACH_PROTOCOL_VERSION,
	type AttachApprovalView,
	type AttachBlock,
	type AttachCommand,
	type AttachErrorCode,
	type AttachLiveEvent,
	type AttachPresenceEntry,
	type AttachRole,
	type AttachServerEvent,
	type AttachStatus,
	attachBlock,
	attachRoleAllows,
	effectiveAttachRole,
	parseAttachCommand,
} from "./protocol.js";

/** Blocks a joining client is replayed; older ones are counted, not sent. */
const REPLAY_TAIL = 200;
/** Refused or malformed commands a client may send before it is dropped. */
const REFUSAL_LIMIT = 8;
const NOTICE_TEXT_MAX = 120;

/** One attached client's byte stream, already split into lines by the transport. */
export interface AttachConnection {
	/** Send one line (no trailing newline). A throw is treated as the client gone. */
	send(line: string): void;
	close(): void;
}

/** What the transport calls for each line a client sends and when the client goes away. */
export interface AttachChannel {
	receive(line: string): void;
	disconnected(): void;
}

/** A listening transport. It opens when the host admits clients and closes when the host stops. */
export interface AttachTransport {
	listen(accept: (connection: AttachConnection) => AttachChannel): Promise<{ address: string; close(): void }>;
}

/** Who may hold which role. `ceiling` is read at hello and again whenever `subscribe` fires. */
export interface AttachConsent {
	ceiling(clientId: string): AttachRole | null;
	subscribe(listener: () => void): () => void;
}

/** The client a session action is attributed to. */
export interface AttachActor {
	clientId: string;
	role: AttachRole;
	label?: string;
}

export type AttachApprovalOutcome = { status: "resolved" } | { status: "stale" };
export type AttachSayOutcome = { status: "accepted"; via: string } | { status: "refused"; detail: string };

/** The running session, as the hub needs it. */
export interface AttachSessionPort {
	sessionId(): string | null;
	/** The transcript on the active path, oldest first. */
	transcript(): ReadonlyArray<AttachBlock>;
	status(): AttachStatus;
	/** Approval cards waiting for an answer, the one on screen first. */
	pendingApprovals(): ReadonlyArray<AttachApprovalView>;
	/** Answer one card by id. A card already answered, or never shown, is stale. */
	resolveApproval(requestId: string, decision: "approve" | "deny", by: AttachActor): AttachApprovalOutcome;
	/** Settles once the session took the text or declined it; a fresh turn settles at admission. */
	say(text: string, by: AttachActor): AttachSayOutcome | Promise<AttachSayOutcome>;
}

export interface AttachHostDeps {
	session: AttachSessionPort;
	consent: AttachConsent;
	/** Put one line in front of the host operator. */
	notice(level: "info" | "warn", text: string): void;
	newClientId?: () => string;
}

export interface AttachHost {
	connect(connection: AttachConnection): AttachChannel;
	publish(event: AttachLiveEvent): void;
	presence(): AttachPresenceEntry[];
	/** Drop every client with `reason`; the hub admits no one after this. */
	close(reason: string): void;
}

/** What `/attach` asks of the terminal that hosts a session. */
export interface AttachOperations {
	/** Admit clients up to `ceiling`, opening the socket if it is closed; null stops admitting and closes it. */
	admit(ceiling: AttachRole | null): Promise<{ level: "info" | "warn" | "error"; text: string }>;
	status(): string;
}

interface Client {
	id: string;
	connection: AttachConnection;
	asked: AttachRole | null;
	role: AttachRole | null;
	label?: string;
	refusals: number;
	gone: boolean;
}

function who(client: Pick<Client, "id" | "label">): string {
	return `attach ${client.id}${client.label !== undefined ? ` (${client.label})` : ""}`;
}

function oneLine(text: string): string {
	const flat = text.replace(/\s+/gu, " ").trim();
	return flat.length <= NOTICE_TEXT_MAX ? flat : `${flat.slice(0, NOTICE_TEXT_MAX - 1)}…`;
}

export function createAttachHost(deps: AttachHostDeps): AttachHost {
	let sequence = 0;
	const newClientId = deps.newClientId ?? ((): string => `c${++sequence}`);
	const clients = new Map<string, Client>();
	let closed = false;

	const send = (client: Client, event: AttachServerEvent): void => {
		if (client.gone) return;
		try {
			client.connection.send(JSON.stringify(event));
		} catch {
			drop(client, null);
		}
	};
	const error = (client: Client, code: AttachErrorCode, message: string, command?: string): void => {
		send(client, { v: 1, type: "error", code, message, ...(command !== undefined ? { command } : {}) });
	};
	const presence = (): AttachPresenceEntry[] =>
		[...clients.values()].flatMap((client) =>
			client.role === null
				? []
				: [{ clientId: client.id, role: client.role, ...(client.label !== undefined ? { label: client.label } : {}) }],
		);
	const broadcastPresence = (): void => {
		const event: AttachServerEvent = { v: 1, type: "presence", clients: presence() };
		for (const client of clients.values()) if (client.role !== null) send(client, event);
	};
	/** End one client. `reason` null means the client went away by itself; nothing is sent to it. */
	function drop(client: Client, reason: string | null): void {
		if (client.gone) return;
		if (reason !== null) send(client, { v: 1, type: "bye", reason });
		client.gone = true;
		clients.delete(client.id);
		try {
			client.connection.close();
		} catch {
			// The stream is already gone; there is nothing more to release.
		}
		if (client.role !== null) {
			deps.notice("info", `${who(client)} left${reason !== null ? `: ${reason}` : ""}`);
			broadcastPresence();
		}
	}
	const refuse = (client: Client, code: AttachErrorCode, message: string, command?: string): void => {
		error(client, code, message, command);
		client.refusals += 1;
		if (client.refusals >= REFUSAL_LIMIT) drop(client, "too many refused commands");
	};

	const hello = (client: Client, command: Extract<AttachCommand, { type: "hello" }>): void => {
		if (command.label !== undefined) client.label = command.label;
		const role = effectiveAttachRole(command.role, deps.consent.ceiling(client.id));
		if (role === null) {
			error(client, "not-admitted", "the host admits no attach clients right now", "hello");
			deps.notice("warn", `${who(client)} asked to attach as ${command.role}; refused, the host admits no clients`);
			drop(client, "not admitted");
			return;
		}
		// Read before the client counts as attached: a port that publishes the blocks it has not sent yet does so to
		// the clients already here, and this one gets them once, in its replay.
		const transcript = deps.session.transcript();
		client.asked = command.role;
		client.role = role;
		send(client, { v: 1, type: "hello", clientId: client.id, sessionId: deps.session.sessionId(), role });
		const tail = transcript.slice(-REPLAY_TAIL);
		send(client, {
			v: 1,
			type: "replay",
			blocks: tail.map(attachBlock),
			omitted: transcript.length - tail.length,
		});
		send(client, { v: 1, type: "status", status: deps.session.status() });
		for (const request of deps.session.pendingApprovals()) send(client, { v: 1, type: "approval.open", request });
		const narrowed = role !== command.role ? ` (asked for ${command.role})` : "";
		deps.notice("info", `${who(client)} joined as ${role}${narrowed}`);
		broadcastPresence();
	};

	const answer = (client: Client, actor: AttachActor, command: Extract<AttachCommand, { type: "approve" | "deny" }>) => {
		const card = deps.session.pendingApprovals().find((request) => request.requestId === command.requestId);
		const verb = command.type === "approve" ? "approved" : "denied";
		// Only a card the session lists as waiting can be answered; the port is the last word on whether it still is.
		const outcome =
			card === undefined
				? { status: "stale" as const }
				: deps.session.resolveApproval(command.requestId, command.type, actor);
		if (outcome.status === "stale" || card === undefined) {
			error(client, "stale", `request ${command.requestId} is not waiting for an answer`, command.type);
			deps.notice("info", `${who(client)} tried to answer request ${command.requestId}, which is not pending`);
			return;
		}
		send(client, { v: 1, type: "ok", command: command.type, requestId: command.requestId, detail: verb });
		const origin = card.origin.kind === "worker" ? `${card.origin.agentId}'s ` : "";
		deps.notice(
			command.type === "approve" ? "warn" : "info",
			`${who(client)} ${verb} ${origin}${card.tool} call (request ${card.requestId})`,
		);
	};

	const say = (client: Client, actor: AttachActor, text: string): void => {
		const settle = (outcome: AttachSayOutcome): void => {
			if (outcome.status === "refused") {
				error(client, "refused", outcome.detail, "say");
				deps.notice("info", `${who(client)} message not taken: ${outcome.detail}`);
				return;
			}
			send(client, { v: 1, type: "ok", command: "say", detail: outcome.via });
			deps.notice("info", `${who(client)} said (${outcome.via}): ${oneLine(text)}`);
		};
		const outcome = deps.session.say(text, actor);
		if (!(outcome instanceof Promise)) {
			settle(outcome);
			return;
		}
		outcome.then(settle, (thrown: unknown) =>
			error(client, "internal", thrown instanceof Error ? thrown.message : String(thrown), "say"),
		);
	};

	const receive = (client: Client, line: string): void => {
		if (client.gone) return;
		const parsed = parseAttachCommand(line);
		if (!parsed.ok) {
			refuse(client, parsed.code, parsed.message);
			return;
		}
		const command = parsed.value;
		if (command.type === "bye") {
			drop(client, null);
			return;
		}
		if (client.role === null) {
			if (command.type === "hello") hello(client, command);
			else refuse(client, "not-ready", "send hello first", command.type);
			return;
		}
		if (command.type === "hello") {
			refuse(client, "already-ready", "this client already said hello", "hello");
			return;
		}
		if (!attachRoleAllows(client.role, command.type)) {
			refuse(client, "forbidden", `role ${client.role} cannot ${command.type}`, command.type);
			const what = command.type === "say" ? "send a message" : `${command.type} request ${command.requestId}`;
			deps.notice("warn", `${who(client)} (${client.role}) tried to ${what}; refused`);
			return;
		}
		const actor: AttachActor = {
			clientId: client.id,
			role: client.role,
			...(client.label !== undefined ? { label: client.label } : {}),
		};
		if (command.type === "say") say(client, actor, command.text);
		else answer(client, actor, command);
	};

	/** Consent changed: every client holds the role the new ceiling admits, or leaves. */
	const reconsider = (): void => {
		for (const client of [...clients.values()]) {
			if (client.role === null || client.asked === null) continue;
			const role = effectiveAttachRole(client.asked, deps.consent.ceiling(client.id));
			if (role === null) {
				drop(client, "the host stopped admitting attach clients");
				continue;
			}
			if (role === client.role) continue;
			client.role = role;
			send(client, { v: 1, type: "role", role });
			deps.notice("info", `${who(client)} is now ${role}`);
		}
		broadcastPresence();
	};
	const unsubscribe = deps.consent.subscribe(reconsider);

	return {
		connect(connection) {
			const client: Client = {
				id: newClientId(),
				connection,
				asked: null,
				role: null,
				refusals: 0,
				gone: false,
			};
			if (closed) {
				client.gone = true;
				try {
					connection.send(JSON.stringify({ v: ATTACH_PROTOCOL_VERSION, type: "bye", reason: "the host has stopped" }));
					connection.close();
				} catch {
					// Nothing to release on a stream that is already gone.
				}
			} else clients.set(client.id, client);
			return {
				receive: (line) => {
					try {
						receive(client, line);
					} catch (thrown) {
						// A session port that throws is answered, never carried into the host loop.
						error(client, "internal", thrown instanceof Error ? thrown.message : String(thrown));
					}
				},
				disconnected: () => drop(client, null),
			};
		},
		publish(event) {
			if (closed) return;
			const sent: AttachServerEvent = event.type === "block" ? { ...event, block: attachBlock(event.block) } : event;
			for (const client of clients.values()) if (client.role !== null) send(client, sent);
		},
		presence,
		close(reason) {
			if (closed) return;
			closed = true;
			unsubscribe();
			for (const client of [...clients.values()]) drop(client, reason);
		},
	};
}
