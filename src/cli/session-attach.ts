/**
 * `clio-coder session attach <id>`: a second terminal on a running session.
 *
 * It connects to the session's attach socket on this host, which exists only
 * after that session's operator ran `/attach`; from another machine the same
 * command runs over `ssh host clio-coder session attach <id>`. The terminal
 * prints the session's transcript and approval cards as text. A line typed here
 * is a message for the session (pair only); `:approve [id]`, `:deny [id]` and
 * `:quit` are client commands. `--json` prints the host's NDJSON events as they
 * arrive and sends each stdin line as one command.
 */

import { lstatSync } from "node:fs";
import { createInterface } from "node:readline";
import {
	applyAttachEvent,
	attachInputCommand,
	createAttachClientView,
	renderAttachEvent,
} from "../domains/attach/client.js";
import { ATTACH_ROLES, type AttachRole, parseAttachEvent } from "../domains/attach/protocol.js";
import { attachSocketPath, connectAttachSocket } from "../domains/attach/socket.js";

const USAGE = `usage: clio-coder session attach <id> [--role observer|approver|pair] [--label <name>] [--json]

Attach to a session running in an interactive terminal on this host, after its operator ran
/attach observe, /attach approve or /attach pair. You hold the lower of --role (default observer)
and what the host admits. Over the network: ssh <host> clio-coder session attach <id>.
Type to message the session (pair); :approve [id] and :deny [id] answer the card; :quit leaves.
`;

interface AttachArgs {
	id: string;
	role: AttachRole;
	label?: string;
	json: boolean;
}

function parseArgs(args: ReadonlyArray<string>): AttachArgs | string {
	let id: string | undefined;
	let role: AttachRole = "observer";
	let label: string | undefined;
	let json = false;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index] ?? "";
		if (arg === "--json") json = true;
		else if (arg === "--role" || arg === "--label") {
			const value = args[index + 1];
			if (value === undefined) return `${arg} needs a value`;
			index += 1;
			if (arg === "--label") label = value;
			else if ((ATTACH_ROLES as readonly string[]).includes(value)) role = value as AttachRole;
			else return `--role is one of ${ATTACH_ROLES.join(", ")}`;
		} else if (arg.startsWith("-")) return `unexpected flag: ${arg}`;
		else if (id === undefined) id = arg;
		else return `unexpected argument: ${arg}`;
	}
	if (id === undefined) return "name the session to attach to; clio-coder session list shows open sessions";
	return { id, role, json, ...(label !== undefined ? { label } : {}) };
}

export async function runSessionAttach(args: ReadonlyArray<string>): Promise<number> {
	if (args.includes("--help") || args.includes("-h")) {
		process.stdout.write(USAGE);
		return 0;
	}
	const parsed = parseArgs(args);
	if (typeof parsed === "string") {
		process.stderr.write(`clio-coder session attach: ${parsed}\n${USAGE}`);
		return 2;
	}
	let path: string;
	try {
		path = attachSocketPath(parsed.id);
	} catch (error) {
		process.stderr.write(`clio-coder session attach: ${error instanceof Error ? error.message : String(error)}\n`);
		return 2;
	}
	const view = createAttachClientView();
	if (lstatSync(path, { throwIfNoEntry: false })?.isSocket() !== true) {
		process.stderr.write(
			`clio-coder session attach: session ${parsed.id} is not open for attach on this host (${path}); its operator runs /attach observe, /attach approve or /attach pair first\n`,
		);
		return 1;
	}
	return new Promise<number>((resolve) => {
		const socket = connectAttachSocket(parsed.id);
		let attached = false;
		let finished = false;
		let input: ReturnType<typeof createInterface> | null = null;
		const finish = (code: number): void => {
			if (finished) return;
			finished = true;
			input?.close();
			process.off("SIGINT", interrupt);
			socket.destroy();
			resolve(code);
		};
		const send = (value: unknown): void => {
			if (!socket.destroyed) socket.write(`${JSON.stringify(value)}\n`);
		};
		const interrupt = (): void => {
			send({ v: 1, type: "bye" });
			finish(0);
		};
		process.on("SIGINT", interrupt);
		socket.on("error", (error: NodeJS.ErrnoException) => {
			if (attached) {
				finish(1);
				return;
			}
			const closed = error.code === "ENOENT" || error.code === "ECONNREFUSED";
			process.stderr.write(
				closed
					? `clio-coder session attach: session ${parsed.id} is not open for attach on this host (${path}); its operator runs /attach observe, /attach approve or /attach pair first\n`
					: `clio-coder session attach: ${error.message}\n`,
			);
			finish(1);
		});
		socket.on("connect", () => {
			send({ v: 1, type: "hello", role: parsed.role, ...(parsed.label !== undefined ? { label: parsed.label } : {}) });
			input = createInterface({ input: process.stdin, terminal: false });
			input.on("line", (line) => {
				if (parsed.json) {
					if (line.trim().length > 0 && !socket.destroyed) socket.write(`${line}\n`);
					return;
				}
				const typed = attachInputCommand(line, view);
				if ("command" in typed) send({ v: 1, ...typed.command });
				else if ("quit" in typed) interrupt();
				else if ("problem" in typed) process.stderr.write(`attach: ${typed.problem}\n`);
			});
		});
		const lines = createInterface({ input: socket, terminal: false });
		// The socket's own error listener reports a failure; the reader over it re-emits that error and must not throw.
		lines.on("error", () => undefined);
		lines.on("line", (line) => {
			const event = parseAttachEvent(line);
			if (parsed.json) process.stdout.write(`${line}\n`);
			if (event === null) return;
			if (event.type === "hello") attached = true;
			applyAttachEvent(view, event);
			if (!parsed.json) for (const text of renderAttachEvent(event, view)) process.stdout.write(`${text}\n`);
		});
		socket.on("close", () => finish(attached ? 0 : 1));
	});
}
