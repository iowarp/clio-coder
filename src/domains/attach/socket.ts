/**
 * The attach transport: a Unix domain socket beside the session's live record,
 * `live/<id>.attach.sock`, and nothing else. There is no TCP listener; a person
 * on another machine reaches it with `ssh host clio-coder session attach <id>`,
 * so OpenSSH does the network authentication and the OS account is the only
 * boundary here: the directory is 0700 and the socket 0600, so only processes
 * of the account that runs the host can connect.
 *
 * The socket exists only while the host admits clients (`/attach`); it is
 * removed when the host stops admitting, leaves the session, or exits.
 */

import { chmodSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { assertSafeId } from "../../core/safe-id.js";
import { liveSessionsDir } from "../session/heartbeat.js";
import type { AttachChannel, AttachConnection, AttachTransport } from "./host.js";
import { ATTACH_CLIENT_LINE_MAX_BYTES } from "./protocol.js";

/** sun_path holds 108 bytes on Linux and 104 on macOS, the terminating NUL included. */
const SOCKET_PATH_MAX_BYTES = 103;
/** A client that reads this far behind the host is dropped rather than buffered without bound. */
const CLIENT_BACKLOG_MAX_BYTES = 4 * 1024 * 1024;

export function attachSocketPath(sessionId: string): string {
	assertSafeId(sessionId, "session");
	return join(liveSessionsDir(), `${sessionId}.attach.sock`);
}

/** Why this platform or path cannot carry an attach socket, or null when it can. */
function socketPathProblem(path: string): string | null {
	if (process.platform === "win32") return "attach needs a Unix domain socket, which this build does not use on Windows";
	if (Buffer.byteLength(path, "utf8") > SOCKET_PATH_MAX_BYTES)
		return `the attach socket path is longer than a Unix socket allows (${SOCKET_PATH_MAX_BYTES} bytes): ${path}`;
	return null;
}

/** Make the live directory owner-only, refusing one that another account owns. */
function ownerOnlyDir(dir: string): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const stat = lstatSync(dir);
	if (!stat.isDirectory()) throw new Error(`${dir} is not a directory`);
	const uid = process.getuid?.();
	if (uid !== undefined && stat.uid !== uid) throw new Error(`${dir} belongs to another account`);
	if ((stat.mode & 0o077) !== 0) chmodSync(dir, 0o700);
}

/** Split a byte stream into lines, refusing one longer than the protocol allows. */
function lineReader(onLine: (line: string) => void, onOverflow: () => void): (chunk: Buffer) => void {
	let pending = "";
	return (chunk) => {
		pending += chunk.toString("utf8");
		for (;;) {
			const end = pending.indexOf("\n");
			if (end === -1) break;
			const line = pending.slice(0, end).replace(/\r$/u, "");
			pending = pending.slice(end + 1);
			if (line.length > 0) onLine(line);
		}
		if (Buffer.byteLength(pending, "utf8") > ATTACH_CLIENT_LINE_MAX_BYTES) {
			pending = "";
			onOverflow();
		}
	};
}

export function createUnixSocketTransport(sessionId: string): AttachTransport {
	const path = attachSocketPath(sessionId);
	return {
		listen: (accept) =>
			new Promise((resolve, reject) => {
				const problem = socketPathProblem(path);
				if (problem !== null) {
					reject(new Error(problem));
					return;
				}
				try {
					ownerOnlyDir(liveSessionsDir());
					// One process owns a session, so a socket left at this name is a crashed owner's.
					const existing = lstatSync(path, { throwIfNoEntry: false });
					if (existing !== undefined) {
						if (!existing.isSocket()) throw new Error(`${path} exists and is not a socket`);
						rmSync(path, { force: true });
					}
				} catch (error) {
					reject(error);
					return;
				}
				const sockets = new Set<Socket>();
				const server: Server = createServer((socket) => {
					sockets.add(socket);
					let channel: AttachChannel | null = null;
					let ended = false;
					const end = (): void => {
						if (ended) return;
						ended = true;
						sockets.delete(socket);
						channel?.disconnected();
					};
					const connection: AttachConnection = {
						send: (line) => {
							if (socket.destroyed) throw new Error("client gone");
							if (socket.writableLength > CLIENT_BACKLOG_MAX_BYTES) {
								socket.destroy();
								throw new Error("client is not reading");
							}
							socket.write(`${line}\n`);
						},
						close: () => {
							socket.end();
							setTimeout(() => socket.destroy(), 1_000).unref();
						},
					};
					channel = accept(connection);
					socket.on(
						"data",
						lineReader(
							(line) => channel?.receive(line),
							() => socket.destroy(),
						),
					);
					socket.on("error", () => undefined);
					socket.on("close", end);
				});
				server.on("error", (error) => {
					reject(error);
				});
				server.listen(path, () => {
					let inode: number | null = null;
					try {
						chmodSync(path, 0o600);
						inode = lstatSync(path).ino;
					} catch (error) {
						server.close();
						reject(error);
						return;
					}
					const removeOwnSocket = (): void => {
						// Removed only while it is still the socket this listener bound.
						const now = lstatSync(path, { throwIfNoEntry: false });
						if (now !== undefined && now.ino === inode) rmSync(path, { force: true });
					};
					process.once("exit", removeOwnSocket);
					resolve({
						address: path,
						close: () => {
							process.off("exit", removeOwnSocket);
							server.close();
							for (const socket of sockets) socket.destroy();
							sockets.clear();
							try {
								removeOwnSocket();
							} catch {
								// The live directory went away with the state root; nothing is left to remove.
							}
						},
					});
				});
			}),
	};
}

/** Open the client side of a session's attach socket. */
export function connectAttachSocket(sessionId: string): Socket {
	return connect(attachSocketPath(sessionId));
}
