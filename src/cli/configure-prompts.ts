import { createInterface, type Interface } from "node:readline/promises";
import { railPrefix } from "./configure-target.js";
import { createLifecyclePresenter } from "./lifecycle-presenter.js";
import { canSelect, promptSelect, promptText } from "./select.js";

export class ConfigureNavigation extends Error {
	constructor(readonly kind: "back" | "quit") {
		super(kind);
	}
}

/** Own stdin only while a question is active. Menus and editors own it otherwise. */
export class ConfigurePrompts {
	constructor(
		readonly input: NodeJS.ReadableStream,
		readonly output: NodeJS.WritableStream,
	) {}

	get interactive(): boolean {
		return canSelect(this.input as NodeJS.ReadStream, this.output as NodeJS.WriteStream);
	}

	clearScreen(): void {
		if (this.interactive) this.output.write("\x1b[H\x1b[2J");
	}

	async question(query: string, options?: Parameters<Interface["question"]>[1]): Promise<string> {
		const rl = createInterface({ input: this.input, output: this.output });
		try {
			return await new Promise<string>((resolve, reject) => {
				rl.once("close", () => reject(new ConfigureNavigation("quit")));
				rl.once("SIGINT", () => reject(new ConfigureNavigation("quit")));
				rl.question(query, options ?? {}).then(resolve, reject);
			});
		} finally {
			rl.close();
		}
	}

	async text(label: string, initial = "", mask = false): Promise<string> {
		if (!this.interactive) {
			const value = (await this.question(`${label}${initial ? ` [${initial}]` : ""}: `)).trim();
			if (/^(q|quit)$/iu.test(value)) throw new ConfigureNavigation("quit");
			return value || initial;
		}
		const result = await promptText({
			heading: ["", label],
			railPrefix: railPrefix(createLifecyclePresenter({ stream: this.output }).isPlain()),
			initial,
			mask,
			backLabel: "back",
			clearOnExit: true,
			input: this.input as NodeJS.ReadStream,
			output: this.output as NodeJS.WriteStream,
		});
		if (result.kind !== "value") throw new ConfigureNavigation(result.kind);
		return result.value;
	}

	async choose(label: string, choices: ReadonlyArray<string>, current: string, searchable = false): Promise<string> {
		if (!this.interactive) return this.text(`${label} [${choices.join("|")}]`, current);
		const result = await promptSelect({
			heading: ["", label],
			railPrefix: railPrefix(createLifecyclePresenter({ stream: this.output }).isPlain()),
			choices: choices.map((value) => ({ value, label: value })),
			initialIndex: Math.max(0, choices.indexOf(current)),
			...(searchable ? { searchable: true, maxVisible: 8 } : {}),
			backLabel: "back",
			clearOnExit: true,
			input: this.input as NodeJS.ReadStream,
			output: this.output as NodeJS.WriteStream,
		});
		if (result.kind !== "selected") throw new ConfigureNavigation(result.kind);
		return result.value;
	}
}
