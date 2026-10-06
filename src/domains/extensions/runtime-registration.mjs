/** Registration is shared by the private child and the author test host. No host or terminal imports. */
const MAX_ACTIONS = 64;
const MAX_INTERVIEWS = 16;
const MAX_DISPOSERS = 8;
const FREE_NAME = /^[a-z][a-z0-9_.-]{0,63}$/;

export function createRuntimeRegistration(
	declaration,
	tables = {
		commands: new Map(),
		observers: new Map(),
		hooks: new Map(),
		tools: new Map(),
		actions: new Map(),
		interviews: new Map(),
	},
	disposers = [],
) {
	const { commands, observers, hooks, tools, actions, interviews } = tables;
	let registering = true;
	const declared = {
		commands: declaration.commands.map((command) => command.name),
		events: [...declaration.events, ...(declaration.tickMs !== undefined ? ["tick"] : [])],
		hooks: [...new Set(declaration.hooks.map((hook) => hook.on))],
		tools: declaration.tools.map((tool) => tool.name),
	};
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
	function sameNames(map, expected) {
		return map.size === expected.length && expected.every((name) => map.has(name));
	}

	const api = Object.freeze({
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
	});
	return {
		...tables,
		disposers,
		api,
		finish() {
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
		},
	};
}
