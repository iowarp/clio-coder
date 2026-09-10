/** Private Node IPC bootstrap. Shipped as ordinary JS: no runtime compiler or dependency install. */
import { pathToFileURL } from "node:url";

const commands = new Map();
const observers = new Map();
const disposers = [];
let identity;
let snapshot;
let declaration;
let registering = false;
let active = false;
let request;
let disposing = false;

function send(message) {
	if (process.connected) process.send({ protocol: 1, instance: identity, ...message });
}
function register(map, name, handler, allowed) {
	if (!registering || !allowed.includes(name) || map.has(name) || typeof handler !== "function") {
		throw new Error(`undeclared, duplicate, or late registration: ${name}`);
	}
	map.set(name, handler);
}
async function dispose(reason) {
	if (disposing) return;
	disposing = true;
	active = false;
	request?.controller.abort();
	await Promise.allSettled(disposers.map((handler) => Promise.resolve().then(() => handler(reason))));
	process.exit(0);
}
process.on("disconnect", () => {
	// Parent loss must also stop idle timers, even if a disposer never resolves.
	setTimeout(() => process.exit(1), 250);
	void dispose("parent-disconnected");
});
process.on("message", async (message) => {
	try {
		if (message?.protocol !== 1 || typeof message.instance !== "string") throw new Error("invalid host protocol");
		if (message.kind === "init") {
			if (identity) throw new Error("duplicate initialization");
			identity = message.instance;
			snapshot = Object.freeze(message.snapshot);
			declaration = message.declaration;
			registering = true;
			const module = await import(pathToFileURL(message.entrypoint).href);
			if (typeof module.default !== "function") throw new Error("runtime must export a default factory");
			await module.default(
				Object.freeze({
					apiVersion: 1,
					handle: (name, handler) =>
						register(
							commands,
							name,
							handler,
							declaration.commands.map((command) => command.name),
						),
					on: (event, handler) => register(observers, event, handler, declaration.events),
					onDispose: (handler) => {
						if (!registering || typeof handler !== "function" || disposers.length >= 8)
							throw new Error("invalid or late disposer registration");
						disposers.push(handler);
					},
				}),
			);
			registering = false;
			if (commands.size !== declaration.commands.length || observers.size !== declaration.events.length)
				throw new Error("missing declared runtime handlers");
			send({
				kind: "ready",
				commands: [...commands.keys()],
				events: [...observers.keys()],
				rss: process.memoryUsage().rss,
			});
			return;
		}
		if (message.instance !== identity || disposing) return;
		if (message.kind === "activate") {
			if (registering || !declaration || active) throw new Error("invalid activation");
			active = true;
			send({ kind: "active" });
			return;
		}
		if (message.kind === "dispose") {
			await dispose(message.reason);
			return;
		}
		if (message.kind === "cancel") {
			if (request?.id === message.id) request.controller.abort();
			return;
		}
		if (message.kind !== "command" && message.kind !== "observe") throw new Error("unknown host message");
		if (!active || request) throw new Error("runtime not ready or busy");
		const handler = message.kind === "command" ? commands.get(message.name) : observers.get(message.observation.event);
		if (!handler) throw new Error("handler unavailable");
		const current = { id: message.id, controller: new AbortController() };
		request = current;
		try {
			const output = await handler(
				message.kind === "command" ? message.args : Object.freeze(message.observation),
				Object.freeze({ snapshot, requestId: current.id, signal: current.controller.signal }),
			);
			if (!current.controller.signal.aborted && !disposing)
				send({ kind: "result", id: current.id, output: output ?? { text: "" } });
		} catch (error) {
			send({ kind: "error", id: current.id, error: String(error).slice(0, 512) });
		} finally {
			if (request === current) request = undefined;
		}
	} catch (error) {
		send({ kind: "fatal", error: String(error).slice(0, 512) });
		void dispose("protocol-or-startup-failure");
	}
});
