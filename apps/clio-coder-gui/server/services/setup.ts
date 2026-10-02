import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { Value } from "typebox/value";
import { type SetupAnswer, type SetupStart, SetupState, SetupStatus } from "../../contracts/setup.js";
import { startConfigureChild, stopClioCommand } from "../process-policy.js";
import type { WorkerHost } from "../worker/host.js";
import { AppProblem } from "./problem.js";

type Running = {
	state: SetupState;
	child: Awaited<ReturnType<typeof startConfigureChild>>;
	timer: NodeJS.Timeout;
	keys: Set<string>;
	done: Promise<void>;
	submittedPrompt: SetupState["prompt"];
};
/** Ephemeral setup, separate from operations/history so credential replies are never persisted. */
export class SetupService {
	private running: Running | undefined;
	private starting = false;
	constructor(
		private readonly reads: WorkerHost,
		private readonly env: NodeJS.ProcessEnv = process.env,
	) {}
	get busy() {
		return this.starting || (!!this.running && ["working", "prompt"].includes(this.running.state.status));
	}
	async status() {
		const result = await this.reads.call("setup.status", {});
		if (!Value.Check(SetupStatus, result)) throw new AppProblem("unavailable", "Saved setup could not be read.");
		return result;
	}
	async start(input: SetupStart, key: string): Promise<SetupState> {
		if (this.running?.keys.has(key)) return this.snapshot(this.running.state.id);
		if (this.starting) throw new AppProblem("conflict", "Setup is already starting. Wait a moment and try again.");
		this.starting = true;
		try {
			// The newest view wins. A page that was reloaded or closed mid-setup leaves its child running, and
			// refusing the next start would strand the person on a button that can never work. The older
			// view's next read answers "no longer available", which it already shows as a recoverable error.
			if (this.running) {
				if (["working", "prompt"].includes(this.running.state.status)) this.cancel(this.running.state.id);
				else this.stop(this.running);
				await this.running.done;
			}
			const child = await startConfigureChild(this.env);
			const state: SetupState = { id: randomUUID(), status: "working", prompt: null, messages: [], problem: null };
			const fail = () => {
				if (!["saved", "cancelled"].includes(state.status)) {
					state.status = "failed";
					state.prompt = null;
					state.problem = "Setup stopped before completion. Refresh saved settings before retrying.";
					this.stop(running);
				}
			};
			const lines = createInterface({ input: child.child.stdout });
			const running: Running = {
				state,
				child,
				keys: new Set([key]),
				submittedPrompt: null,
				timer: setTimeout(() => this.cancel(state.id), 15 * 60_000),
				done: new Promise((resolve) => {
					child.child.once("close", () => {
						fail();
						lines.close();
						clearTimeout(running.timer);
						resolve();
					});
				}),
			};
			this.running = running;
			child.child.once("error", fail);
			child.child.stdin.on("error", fail);
			// Runtime/provider stderr is deliberately not copied into logs or public state.
			child.child.stderr.resume();
			lines.on("line", (line) => {
				if (!["working", "prompt"].includes(state.status)) return;
				if (line.length > 256_000) {
					this.cancel(state.id);
					return;
				}
				try {
					const event = JSON.parse(line) as { kind: string; prompt?: unknown; text?: string };
					if (event.kind === "clear") state.messages = [];
					else if (event.kind === "message" && typeof event.text === "string")
						state.messages = [...state.messages, event.text.slice(0, 4096)].slice(-80);
					else if (event.kind === "problem") {
						state.problem = event.text?.slice(0, 4096) ?? "Check this answer.";
						state.prompt = running.submittedPrompt;
						state.status = state.prompt ? "prompt" : "working";
						running.submittedPrompt = null;
					} else if (event.kind === "prompt") {
						state.status = "prompt";
						state.prompt = event.prompt as SetupState["prompt"];
						running.submittedPrompt = null;
						state.problem = null;
					} else if (["working", "saved", "cancelled", "failed"].includes(event.kind)) {
						state.status = event.kind as SetupState["status"];
						state.prompt = null;
						state.problem = event.kind === "failed" ? (event.text ?? "Setup failed.") : null;
					}
					if (!Value.Check(SetupState, state)) {
						fail();
						this.stop(running);
					}
				} catch {
					fail();
					this.stop(running);
				}
			});
			child.child.stdin.write(`${JSON.stringify({ kind: "start", ...input })}\n`);
			return this.snapshot(state.id);
		} finally {
			this.starting = false;
		}
	}
	private get(id: string) {
		if (!this.running || this.running.state.id !== id)
			throw new AppProblem("not_found", "This setup is no longer available. Start it again.");
		return this.running;
	}
	snapshot(id: string): SetupState {
		return structuredClone(this.get(id).state);
	}
	answer(id: string, answer: SetupAnswer, key: string): SetupState {
		const running = this.get(id);
		if (running.keys.has(key)) return this.snapshot(id);
		if (running.state.status !== "prompt" || running.state.prompt?.id !== answer.promptId)
			throw new AppProblem("conflict", "This prompt has changed. Read the current step and try again.");
		if (running.keys.size >= 2000)
			throw new AppProblem("unavailable", "Setup has reached its reply limit. Cancel and start again.");

		const prompt = running.state.prompt;
		if (
			(answer.action === "select" &&
				(prompt?.kind !== "select" || !prompt.choices.some((choice) => choice.id === answer.choice))) ||
			(answer.action === "text" && prompt?.kind !== "text")
		)
			throw new AppProblem("validation", "Choose an answer offered by this prompt.");
		running.submittedPrompt = prompt;
		running.state.status = "working";
		running.state.prompt = null;
		running.keys.add(key);
		running.child.child.stdin.write(`${JSON.stringify(answer)}\n`);
		// The child restores the prompt on a validation refusal; concurrent replies see working.
		running.state.problem = null;
		return this.snapshot(id);
	}
	cancel(id: string): SetupState {
		const running = this.get(id);
		if (!["working", "prompt"].includes(running.state.status)) return this.snapshot(id);
		running.state.status = "cancelled";
		running.state.prompt = null;
		running.state.messages = [];
		running.state.problem = null;
		running.child.child.stdin.write(`${JSON.stringify({ kind: "cancel" })}\n`);
		this.stop(running);
		return this.snapshot(id);
	}
	private stop(running: Running) {
		stopClioCommand(running.child.child, running.child.birthToken, "SIGTERM");
		clearTimeout(running.timer);
		running.timer = setTimeout(() => stopClioCommand(running.child.child, running.child.birthToken, "SIGKILL"), 1500);
	}

	async close() {
		if (this.running) {
			this.cancel(this.running.state.id);
			this.stop(this.running);
			await this.running.done;
		}
	}
}
