import { createInterface } from "node:readline";
import { stripVTControlCharacters } from "node:util";
import { readSettings } from "../core/config.js";
import { getRuntimeRegistry } from "../domains/providers/registry.js";
import { type ConfigureWizardHost, runHostedTargetWizard } from "./configure-host.js";
import type { SelectOptions, SelectResult, TextPromptOptions, TextResult } from "./select.js";

/** Private line transport. Choice values and credentials never appear in a prompt snapshot. */
export async function runBrowserConfigure(
	input: NodeJS.ReadableStream,
	output: NodeJS.WritableStream,
): Promise<number> {
	const abort = new AbortController();
	let revision = 0;
	let started = false;
	let saved = false;
	let result: Promise<number> | undefined;
	const secrets = new Set<string>();
	let pending: { id: number; accept: (answer: Record<string, unknown>) => boolean; quit: () => void } | undefined;
	const send = (value: unknown) => output.write(`${JSON.stringify(value)}\n`);
	const clean = (text: string) => {
		let value = stripVTControlCharacters(text);
		for (const secret of secrets) value = value.split(secret).join("[hidden]");
		return value.slice(0, 4096);
	};
	const instructions = (text: string) =>
		clean(text)
			.replaceAll("press Escape", "choose Back")
			.replaceAll("Escape goes back.", "Back returns to the previous step.");
	const headings = (heading: string | readonly string[] | undefined) =>
		(typeof heading === "string" ? [heading] : [...(heading ?? [])]).map(clean).filter((line) => line.trim() !== "");
	const cancel = () => {
		abort.abort();
		pending?.quit();
		pending = undefined;
	};
	const host: ConfigureWizardHost = {
		signal: abort.signal,
		onTargetSaved: () => {
			saved = true;
			send({ kind: "saved", text: "Connection saved." });
		},
		cancelled: () => abort.signal.aborted,
		dismissPrompt: () => {
			pending?.quit();
			pending = undefined;
			send({ kind: "working" });
		},
		clearMessages: () => send({ kind: "clear" }),
		report: (text) => {
			const value = instructions(text);
			send({ kind: "message", text: value });
		},
		select: <T>(options: SelectOptions<T>) =>
			new Promise<SelectResult<T>>((resolve) => {
				if (abort.signal.aborted) return resolve({ kind: "quit" });
				const id = ++revision;
				pending = {
					id,
					quit: () => resolve({ kind: "quit" }),
					accept: (answer) => {
						if (answer.action === "back") {
							resolve({ kind: "back" });
							return true;
						}
						if (answer.action !== "select" || !Number.isInteger(answer.choice)) return false;
						const choice = options.choices[answer.choice as number];
						if (!choice) return false;
						resolve({ kind: "selected", value: choice.value });
						return true;
					},
				};
				send({
					kind: "prompt",
					prompt: {
						id,
						kind: "select",
						heading: headings(options.heading),
						choices: options.choices.map((choice, index) => ({
							id: index,
							label: clean(choice.label),
							hint: clean(choice.hint ?? ""),
						})),
						initial: options.initialIndex ?? 0,
						searchable: options.searchable ?? false,
					},
				});
			}),
		text: (options: TextPromptOptions) =>
			new Promise<TextResult>((resolve) => {
				if (abort.signal.aborted) return resolve({ kind: "quit" });
				const id = ++revision;
				pending = {
					id,
					quit: () => resolve({ kind: "quit" }),
					accept: (answer) => {
						if (answer.action === "back") {
							resolve({ kind: "back" });
							return true;
						}
						if (answer.action !== "text" || typeof answer.value !== "string" || answer.value.length > 4096) return false;
						if (options.mask && answer.value) secrets.add(answer.value);
						const problem = options.validate?.(answer.value);
						if (problem) {
							send({ kind: "problem", text: instructions(problem) });
							return false;
						}
						resolve({ kind: "value", value: answer.value });
						return true;
					},
				};
				send({
					kind: "prompt",
					prompt: {
						id,
						kind: "text",
						heading: headings(options.heading),
						initial: options.mask ? "" : clean(options.initial ?? ""),
						hint: clean(options.hint ?? ""),
						mask: options.mask ?? false,
					},
				});
			}),
	};
	const lines = createInterface({ input });
	const finished = new Promise<void>((resolve) => {
		lines.on("line", (line) => {
			if (line.length > 8192) {
				cancel();
				return;
			}
			let answer: Record<string, unknown>;
			try {
				answer = JSON.parse(line) as Record<string, unknown>;
			} catch {
				cancel();
				return;
			}
			if (!answer || typeof answer !== "object") {
				cancel();
				return;
			}
			if (answer.kind === "cancel") {
				cancel();
				return;
			}
			if (!started && answer.kind === "start") {
				started = true;
				const settings = readSettings();
				const target =
					typeof answer.targetId === "string" ? settings.targets.find((entry) => entry.id === answer.targetId) : undefined;
				if (answer.targetId && !target) {
					send({ kind: "failed", text: "This connection no longer exists. Refresh and try again." });
					resolve();
					return;
				}
				const chat = settings.targets.find((entry) => entry.id === settings.chat.target);
				const hasChat = chat && getRuntimeRegistry().get(chat.runtime)?.kind === "http";
				result = runHostedTargetWizard(
					host,
					target ? { mode: "edit", target: structuredClone(target) } : { mode: hasChat ? "add" : "first" },
				);
				void result.then(
					(code) => {
						send({
							kind: saved ? "saved" : code === 130 || code === 0 ? "cancelled" : "failed",
							text: saved ? "Connection saved." : "Setup ended without saving a connection.",
						});
						resolve();
					},
					() => {
						send({ kind: "failed", text: "Setup could not finish. Check the connection and try again." });
						resolve();
					},
				);
				return;
			}
			if (pending && answer.promptId === pending.id && pending.accept(answer)) {
				pending = undefined;
				send({ kind: "working" });
			}
		});
		lines.once("close", () => {
			cancel();
			resolve();
		});
	});
	process.once("SIGTERM", cancel);
	process.once("SIGINT", cancel);
	try {
		await finished;
		return saved ? 0 : abort.signal.aborted ? 130 : 0;
	} finally {
		cancel();
		lines.close();
		process.removeListener("SIGTERM", cancel);
		process.removeListener("SIGINT", cancel);
	}
}
