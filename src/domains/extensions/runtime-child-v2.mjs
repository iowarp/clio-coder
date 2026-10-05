/** Private Node IPC bootstrap for operator runtime API v2. Shipped as ordinary JS: no runtime compiler or dependency install. */
import { pathToFileURL } from "node:url";

const PROTOCOL = 2;
// The host enforces the same bounds; these only fail an extension early with a clearer message.
const MAX_CONCURRENT = 8;
const MAX_ACTIONS = 64;
const MAX_INTERVIEWS = 16;
const MAX_DISPOSERS = 8;
const FREE_NAME = /^[a-z][a-z0-9_.-]{0,63}$/;

const commands = new Map();
const observers = new Map();
const hooks = new Map();
const tools = new Map();
const actions = new Map();
const interviews = new Map();
const disposers = [];
/** Host requests in flight, by id. A v2 runtime may hold several at once. */
const requests = new Map();
/** This runtime's own calls to host-held state and store, by id. */
const calls = new Map();
let identity;
let snapshot;
let declaration;
let options;
let registering = false;
let active = false;
let disposing = false;
let callSequence = 0;

function send(message) {
	if (process.connected) process.send({ protocol: PROTOCOL, instance: identity, ...message });
}
function register(map, name, handler, allowed) {
	if (!registering || typeof name !== "string" || typeof handler !== "function" || map.has(name))
		throw new Error(`duplicate, late, or invalid registration: ${String(name)}`);
	if (!allowed.includes(name)) throw new Error(`undeclared registration: ${name}`);
	map.set(name, handler);
}
/** Action and interview ids are named by view data, not by the manifest, so only their form and count are bounded. */
function registerFree(map, name, handler, limit) {
	if (!registering || typeof name !== "string" || typeof handler !== "function" || map.has(name))
		throw new Error(`duplicate, late, or invalid registration: ${String(name)}`);
	if (!FREE_NAME.test(name) || map.size >= limit) throw new Error(`registration refused: ${name}`);
	map.set(name, handler);
}
function call(op, payload) {
	if (disposing || !process.connected) return Promise.reject(new Error("runtime is disposing"));
	const id = `call-${++callSequence}`;
	return new Promise((resolve, reject) => {
		calls.set(id, { resolve, reject });
		send({ kind: "call", id, op, ...payload });
	});
}
function keyValue(scope, declared) {
	const guard = (run) => (declared ? run() : Promise.reject(new Error(`runtime did not declare ${scope}`)));
	return Object.freeze({
		get: (key) => guard(() => call(`${scope}.get`, { key })),
		set: (key, value, opts) =>
			guard(() =>
				call(`${scope}.set`, { key, value, ...(opts?.ifVersion !== undefined ? { ifVersion: opts.ifVersion } : {}) }),
			),
		delete: (key) => guard(() => call(`${scope}.delete`, { key })),
		keys: () => guard(() => call(`${scope}.keys`, {})),
	});
}
let state;
let store;

async function dispose(reason) {
	if (disposing) return;
	disposing = true;
	active = false;
	for (const controller of requests.values()) controller.abort();
	for (const pending of calls.values()) pending.reject(new Error("runtime is disposing"));
	calls.clear();
	await Promise.allSettled(disposers.map((handler) => Promise.resolve().then(() => handler(reason))));
	process.exit(0);
}
process.on("disconnect", () => {
	// Parent loss must also stop idle timers, even if a disposer never resolves.
	setTimeout(() => process.exit(1), 250);
	void dispose("parent-disconnected");
});

function sameNames(map, expected) {
	return map.size === expected.length && expected.every((name) => map.has(name));
}

async function initialize(message) {
	if (identity) throw new Error("duplicate initialization");
	identity = message.instance;
	snapshot = Object.freeze(message.snapshot);
	declaration = message.declaration;
	options = Object.freeze({ ...message.options });
	state = keyValue("state", declaration.state.session === true);
	store = keyValue("store", declaration.state.store === true);
	const declared = {
		commands: declaration.commands.map((command) => command.name),
		events: [...declaration.events, ...(declaration.tickMs !== undefined ? ["tick"] : [])],
		hooks: [...new Set(declaration.hooks.map((hook) => hook.on))],
		tools: declaration.tools.map((tool) => tool.name),
	};
	registering = true;
	const module = await import(pathToFileURL(message.entrypoint).href);
	if (typeof module.default !== "function") throw new Error("runtime must export a default factory");
	await module.default(
		Object.freeze({
			apiVersion: 2,
			handle: (name, handler) => register(commands, name, handler, declared.commands),
			on: (event, handler) => register(observers, event, handler, declared.events),
			hook: (point, handler) => register(hooks, point, handler, declared.hooks),
			tool: (name, handler) => register(tools, name, handler, declared.tools),
			action: (id, handler) => registerFree(actions, id, handler, MAX_ACTIONS),
			interview: (id, handler) => registerFree(interviews, id, handler, MAX_INTERVIEWS),
			onDispose: (handler) => {
				if (!registering || typeof handler !== "function" || disposers.length >= MAX_DISPOSERS)
					throw new Error("invalid or late disposer registration");
				disposers.push(handler);
			},
		}),
	);
	registering = false;
	if (
		!sameNames(commands, declared.commands) ||
		!sameNames(observers, declared.events) ||
		!sameNames(hooks, declared.hooks) ||
		!sameNames(tools, declared.tools)
	)
		throw new Error("missing declared runtime handlers");
	// A leader key bound to an action nobody registered would press into nothing.
	for (const workspace of declaration.workspaces)
		for (const binding of workspace.keys ?? [])
			if (!actions.has(binding.action)) throw new Error(`workspace key names an unregistered action: ${binding.action}`);
	send({
		kind: "ready",
		commands: [...commands.keys()],
		events: [...observers.keys()],
		hooks: [...hooks.keys()],
		tools: [...tools.keys()],
		actions: [...actions.keys()],
		interviews: [...interviews.keys()],
		rss: process.memoryUsage().rss,
	});
}

const TABLES = {
	command: commands,
	observe: observers,
	hook: hooks,
	tool: tools,
	action: actions,
	interview: interviews,
};

async function serve(message) {
	if (!active) throw new Error("runtime not active");
	if (typeof message.id !== "string" || requests.has(message.id)) throw new Error("invalid request id");
	const name =
		message.kind === "observe" ? message.event?.event : message.kind === "hook" ? message.event?.point : message.name;
	const handler = TABLES[message.kind].get(name);
	if (requests.size >= MAX_CONCURRENT || !handler) {
		send({
			kind: "error",
			id: message.id,
			error: handler ? "runtime is busy" : `no handler for ${message.kind} ${String(name)}`,
		});
		return;
	}
	const controller = new AbortController();
	requests.set(message.id, controller);
	const context = Object.freeze({
		snapshot,
		requestId: message.id,
		signal: controller.signal,
		options,
		state,
		store,
	});
	const input =
		message.kind === "command" ? message.args : message.kind === "tool" ? message.input : Object.freeze(message.event);
	try {
		const output = await handler(input, context);
		// A cancelled request has no authority; its late answer is dropped here and again by the host.
		if (!controller.signal.aborted && !disposing) send({ kind: "result", id: message.id, output: output ?? null });
	} catch (error) {
		if (!controller.signal.aborted && !disposing)
			send({ kind: "error", id: message.id, error: String(error).slice(0, 512) });
	} finally {
		requests.delete(message.id);
	}
}

process.on("message", async (message) => {
	try {
		if (message?.protocol !== PROTOCOL || typeof message.instance !== "string") throw new Error("invalid host protocol");
		if (message.kind === "init") {
			await initialize(message);
			return;
		}
		if (message.instance !== identity || disposing) return;
		switch (message.kind) {
			case "activate":
				if (registering || !declaration || active) throw new Error("invalid activation");
				active = true;
				send({ kind: "active" });
				return;
			case "dispose":
				await dispose(message.reason);
				return;
			case "cancel":
				requests.get(message.id)?.abort();
				return;
			case "snapshot":
				snapshot = Object.freeze(message.snapshot);
				return;
			case "returned": {
				const pending = calls.get(message.id);
				if (!pending) return;
				calls.delete(message.id);
				if (typeof message.error === "string") pending.reject(new Error(message.error));
				else pending.resolve(message.value);
				return;
			}
			case "command":
			case "observe":
			case "hook":
			case "tool":
			case "action":
			case "interview":
				await serve(message);
				return;
			default:
				throw new Error("unknown host message");
		}
	} catch (error) {
		send({ kind: "fatal", error: String(error).slice(0, 512) });
		void dispose("protocol-or-startup-failure");
	}
});
