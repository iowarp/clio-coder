import type { AskUserHandler } from "../../tools/ask-user.js";

const EGGS = [
	{
		id: "duck",
		label: "Rubber duck badge",
		aliases: ["where is your rubber duck", "clio, where is your rubber duck"],
	},
] as const;

function normalize(text: string): string {
	return text
		.toLowerCase()
		.trim()
		.replace(/\s+/gu, " ")
		.replace(/[.!?,;:… ]+$/u, "");
}

/** Ephemeral presentation opt-in; neither discovery nor consent admits any tool action. */
export function createConversationEggs(deps: {
	identity(): string | null;
	ensureConversation?(): void;
	changed(active: readonly string[]): void;
	notice(text: string): void;
}) {
	const active = new Set<string>();
	let identity = deps.identity();
	let generation = 0;
	let pending: { id: string; controller: AbortController } | null = null;
	const cancel = () => {
		generation += 1;
		const old = pending;
		pending = null;
		old?.controller.abort();
	};
	const reset = () => {
		cancel();
		identity = deps.identity();
		active.clear();
		deps.changed([]);
	};
	const syncConversation = () => {
		if (identity !== deps.identity()) reset();
	};
	return {
		active: () => {
			syncConversation();
			return [...active];
		},
		reset,
		syncConversation,
		command(action: "status" | "off", id?: string): string {
			syncConversation();
			if (action === "status") return active.size ? `Active eggs: ${[...active].join(", ")}` : "No active eggs.";
			if (id === undefined || id === pending?.id) cancel();
			if (id === undefined) active.clear();
			else active.delete(id);
			deps.changed([...active]);
			return "Eggs turned off.";
		},
		async discover(text: string, ask?: AskUserHandler): Promise<boolean> {
			syncConversation();
			const egg = EGGS.find((entry) => entry.aliases.some((alias) => alias === normalize(text)));
			if (!egg) return false;
			if (active.has(egg.id)) {
				deps.notice("She’s already beside our conversation. 🦆");
				return true;
			}
			if (pending) return true;
			if (!ask) {
				deps.notice("The duck badge needs an interview-capable client to activate.");
				return true;
			}
			// Bind consent before the first model turn lazily creates a session.
			deps.ensureConversation?.();
			syncConversation();
			const origin = deps.identity();
			const version = generation;
			const request = new AbortController();
			pending = { id: egg.id, controller: request };
			try {
				const result = await ask(
					[
						{
							header: egg.label,
							question: "You found her. Want a little duck beside our conversation for this session?",
							options: [
								{ label: "Leave her sleeping" },
								{ label: "Invite her in", description: "Show a small duck badge beside this conversation." },
							],
						},
					],
					{ signal: request.signal },
				);
				const answer = result.answers[0];
				if (
					version !== generation ||
					origin !== deps.identity() ||
					request.signal.aborted ||
					result.cancelled ||
					result.unavailable
				)
					return true;
				if (
					result.answers.length === 1 &&
					answer?.options?.length === 1 &&
					answer.options[0] === "Invite her in" &&
					answer.answer === "Invite her in" &&
					!answer.value?.trim()
				) {
					active.add(egg.id);
					deps.changed([...active]);
					deps.notice("She’s beside our conversation now. 🦆 Use /eggs off to let her sleep.");
				} else deps.notice("She’ll keep sleeping. Ask again whenever you like.");
			} catch {
				// An unavailable confirmation surface cannot confer consent.
			} finally {
				if (pending?.controller === request) pending = null;
			}
			return true;
		},
	};
}
