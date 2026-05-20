import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProvidersContract } from "../../src/domains/providers/index.js";
import {
	appendCommandOutput,
	type CommandOutputReplayBlock,
	type CommandOutputSink,
	createCommandOutputRunIo,
} from "../../src/interactive/command-output.js";
import {
	dispatchSlashCommand,
	parseSlashCommand,
	type SlashCommandContext,
} from "../../src/interactive/slash-commands.js";

function makeSink(): {
	sink: CommandOutputSink;
	blocks: CommandOutputReplayBlock[];
	renders: number;
} {
	const blocks: CommandOutputReplayBlock[] = [];
	const state = {
		sink: {
			appendReplayBlock(renderBlock: CommandOutputReplayBlock) {
				blocks.push(renderBlock);
			},
			requestRender() {
				state.renders += 1;
			},
		},
		blocks,
		renders: 0,
	};
	return state;
}

describe("interactive command output binding", () => {
	it("appends stdout/stderr as replay blocks and requests a render", () => {
		const state = makeSink();
		const io = createCommandOutputRunIo(state.sink, (line, width) => [`${width}:${line}`]);

		io.stdout("commands:\n  /help   Show help\n");
		io.stderr("[/model] no targets configured\n");

		strictEqual(state.renders, 2);
		strictEqual(state.blocks.length, 2);
		deepStrictEqual(state.blocks[0]?.(80), ["80:commands:", "80:  /help   Show help"]);
		deepStrictEqual(state.blocks[1]?.(40), ["40:[/model] no targets configured"]);
	});

	it("normalizes carriage returns and a single trailing newline", () => {
		const state = makeSink();

		appendCommandOutput("one\r\ntwo\n", state.sink, (line) => [line]);

		strictEqual(state.renders, 1);
		deepStrictEqual(state.blocks[0]?.(80), ["one", "two"]);
	});

	it("ignores empty output after newline trimming", () => {
		const state = makeSink();

		appendCommandOutput("\n", state.sink, (line) => [line]);

		strictEqual(state.renders, 0);
		strictEqual(state.blocks.length, 0);
	});

	it("routes representative slash stdout and stderr commands through replay blocks", () => {
		const state = makeSink();
		const ctx = {
			io: createCommandOutputRunIo(state.sink, (line) => [line]),
			listSkills: () => ({ diagnostics: [], items: [] }),
			listPrompts: () => ({ diagnostics: [], items: [] }),
			listExtensions: () => [],
			verifyReceipt: () => ({ ok: false, reason: "missing receipt" }),
			providers: { list: () => [] } as Partial<ProvidersContract> as ProvidersContract,
			applyModelRef: () => {
				throw new Error("should not apply");
			},
		} as Partial<SlashCommandContext> as SlashCommandContext;
		const commands = [
			"/help",
			"/skills",
			"/prompts",
			"/extensions",
			"/share",
			"/share export out.tar",
			"/run",
			"/receipts nope",
			"/receipts verify abc",
			"/model missing",
		];

		for (const command of commands) {
			dispatchSlashCommand(parseSlashCommand(command), ctx);
		}

		const rendered = state.blocks.flatMap((block) => block(120)).join("\n");
		strictEqual(state.renders, commands.length);
		strictEqual(rendered.includes("commands:"), true);
		strictEqual(rendered.includes("skills: none"), true);
		strictEqual(rendered.includes("prompt templates: none"), true);
		strictEqual(rendered.includes("extensions: none"), true);
		strictEqual(rendered.includes("usage: /share export <path> | /share import"), true);
		strictEqual(rendered.includes("[/share] share export is not wired"), true);
		strictEqual(rendered.includes("usage: /run"), true);
		strictEqual(rendered.includes("usage: /receipts verify <runId>"), true);
		strictEqual(rendered.includes("[/receipts verify] fail abc missing receipt"), true);
		strictEqual(rendered.includes("[/model] no targets configured"), true);
	});
});
