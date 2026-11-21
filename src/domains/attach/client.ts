/**
 * The attached terminal's side: what it keeps of the stream, how it prints
 * each event, and how a line the person types becomes a command.
 *
 * The client renders plain text, one event at a time, and needs no TUI. Lines
 * the person types are messages for the session (sent only by a pair client);
 * a line that starts with `:` is a client command: `:approve [id]`, `:deny
 * [id]`, `:quit`. With exactly one card open the id may be left out.
 */

import {
	type AttachApprovalView,
	type AttachBlock,
	type AttachCommand,
	type AttachRole,
	type AttachServerEvent,
	looksLikeSlashCommand,
} from "./protocol.js";

export interface AttachClientView {
	clientId: string | null;
	sessionId: string | null;
	role: AttachRole | null;
	/** Cards waiting for an answer, in the order the host opened them. */
	approvals: Map<string, AttachApprovalView>;
}

export function createAttachClientView(): AttachClientView {
	return { clientId: null, sessionId: null, role: null, approvals: new Map() };
}

/** Fold one event into the view. */
export function applyAttachEvent(view: AttachClientView, event: AttachServerEvent): void {
	switch (event.type) {
		case "hello":
			view.clientId = event.clientId;
			view.sessionId = event.sessionId;
			view.role = event.role;
			break;
		case "role":
			view.role = event.role;
			break;
		case "approval.open":
			view.approvals.set(event.request.requestId, event.request);
			break;
		case "approval.closed":
			view.approvals.delete(event.requestId);
			break;
	}
}

function indent(text: string, prefix = "  "): string[] {
	return text.split("\n").map((line) => `${prefix}${line}`);
}

function blockLines(block: AttachBlock): string[] {
	switch (block.kind) {
		case "request":
			return ["> user", ...indent(block.text)];
		case "response":
			return [
				`< assistant${block.model !== null ? ` (${block.model})` : ""}${block.reasoning ? " [reasoned]" : ""}`,
				...(block.text.length > 0 ? indent(block.text) : []),
			];
		case "tool":
			return [`* ${block.name}${block.viaGateway ? " via gateway" : ""}`, ...indent(block.args)];
		case "result":
			return [`= ${block.name} ${block.failed ? "failed" : "done"}`, ...indent(block.text)];
		case "note":
			return [`# ${block.title}`, ...indent(block.text)];
	}
}

function approvalLines(request: AttachApprovalView): string[] {
	const origin = request.origin.kind === "worker" ? ` from ${request.origin.agentId} (run ${request.origin.runId})` : "";
	return [
		`! approval ${request.requestId}: ${request.tool} (${request.actionClass})${origin}`,
		...(request.target !== undefined ? [`  target: ${request.target}`] : []),
		...(request.consequence ?? []).map((line) => `  ${line}`),
		...(request.mutation !== undefined
			? [
					`  ${request.mutation.kind}: ${request.mutation.bytes} bytes, ${request.mutation.replacements} replacement(s), digest ${request.mutation.digest}`,
				]
			: []),
		`  reason: ${request.reason}`,
	];
}

/** The lines one event prints. `view` is the state after the event was applied. */
export function renderAttachEvent(event: AttachServerEvent, view: AttachClientView): string[] {
	switch (event.type) {
		case "hello": {
			const hint =
				event.role === "observer"
					? "watching; :quit leaves"
					: event.role === "approver"
						? ":approve / :deny answer a card; :quit leaves"
						: "type to message the session; :approve / :deny answer a card; :quit leaves";
			return [`attached to session ${event.sessionId ?? "(none yet)"} as ${event.clientId}, ${event.role}: ${hint}`];
		}
		case "role":
			return [`the host changed your role to ${event.role}`];
		case "presence":
			return [
				`attached: ${event.clients.map((client) => `${client.clientId}${client.label !== undefined ? ` (${client.label})` : ""} ${client.role}`).join(", ")}`,
			];
		case "replay":
			return [
				...(event.omitted > 0 ? [`(${event.omitted} earlier blocks not shown)`] : []),
				...event.blocks.flatMap(blockLines),
			];
		case "block":
			return blockLines(event.block);
		case "status":
			return [`status: ${event.status.phase}`];
		case "approval.open":
			return [
				...approvalLines(event.request),
				...(view.role === "approver" || view.role === "pair"
					? [`  answer with :approve ${event.request.requestId} or :deny ${event.request.requestId}`]
					: []),
			];
		case "approval.closed":
			return [
				`! approval ${event.requestId} ${event.status}${event.decidedBy !== undefined ? ` by ${event.decidedBy}` : ""}`,
			];
		case "ok":
			return [
				event.command === "say"
					? `sent (${event.detail})`
					: `${event.detail} ${event.requestId !== undefined ? `request ${event.requestId}` : ""}`.trim(),
			];
		case "error":
			return [`error ${event.code}${event.command !== undefined ? ` (${event.command})` : ""}: ${event.message}`];
		case "bye":
			return [`detached: ${event.reason}`];
	}
}

export type AttachInput = { command: AttachCommand } | { quit: true } | { problem: string } | { nothing: true };

/** What one typed line means for this client. Nothing a client may not send is turned into a command. */
export function attachInputCommand(line: string, view: AttachClientView): AttachInput {
	const text = line.replace(/\r$/u, "");
	if (text.trim().length === 0) return { nothing: true };
	if (!text.startsWith(":")) {
		if (view.role !== "pair")
			return { problem: `${view.role ?? "a client not yet attached"} cannot message the session` };
		if (looksLikeSlashCommand(text)) return { problem: "slash commands stay with the host operator; send plain text" };
		return { command: { type: "say", text } };
	}
	const [verb = "", id, ...rest] = text.slice(1).trim().split(/\s+/u);
	if (verb === "quit" || verb === "q") return { quit: true };
	if (verb !== "approve" && verb !== "deny") return { problem: "client commands are :approve [id], :deny [id], :quit" };
	if (rest.length > 0) return { problem: `:${verb} takes one request id` };
	if (view.role !== "approver" && view.role !== "pair")
		return { problem: `${view.role ?? "a client not yet attached"} cannot answer a card` };
	if (id !== undefined) return { command: { type: verb, requestId: id } };
	const open = [...view.approvals.keys()];
	if (open.length === 1 && open[0] !== undefined) return { command: { type: verb, requestId: open[0] } };
	return { problem: open.length === 0 ? "no card is open" : `${open.length} cards are open; name one by id` };
}
