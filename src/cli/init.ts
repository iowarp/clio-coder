import { spawn } from "node:child_process";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import type { BootstrapStructuredOutput } from "../domains/context/bootstrap.js";
import { buildBootstrapPrompt, parseBootstrapModelOutput } from "../domains/context/bootstrap-prompt.js";
import { runBootstrap } from "../domains/context/index.js";

const HELP = `Usage:
  clio init [--yes] [--preview] [--adopt] [--global] [--generate]

Bootstrap or refresh CLIO.md for the current project.

Options:
  --preview        scan supported agent configs and show the compact plan without writing files
  --adopt          include provenance-rich imported agent context in CLIO.md
  --global         include explicitly opted-in global imports (currently ~/.codex/AGENTS.md)
  --generate       ask the configured Clio target to draft CLIO.md, then validate and write it
  --yes, -y        add .clio/ to .gitignore without prompting
`;

function hasFlag(args: ReadonlyArray<string>, name: string): boolean {
	return args.includes(name);
}

async function confirmGitignore(assumeYes: boolean): Promise<boolean> {
	if (assumeYes) return true;
	if (!input.isTTY) return false;
	const rl = createInterface({ input, output });
	try {
		const answer = await rl.question("Add .clio/ to .gitignore? [y/N] ");
		return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
	} finally {
		rl.close();
	}
}

function cliEntryPath(): string {
	const entry = process.argv[1];
	if (!entry) throw new Error("clio init --generate could not resolve the current CLI entry path");
	return entry;
}

function parseHeadlessJsonOutput(stdout: string): string {
	let lastText = "";
	for (const line of stdout.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			continue;
		}
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
		const event = parsed as { type?: unknown; message?: { role?: unknown; content?: unknown } };
		if (event.type !== "message_end" || event.message?.role !== "assistant") continue;
		const content = event.message.content;
		if (!Array.isArray(content)) continue;
		const text = content
			.map((block) => {
				if (typeof block === "string") return block;
				if (typeof block !== "object" || block === null || Array.isArray(block)) return "";
				const maybeText = (block as { text?: unknown }).text;
				return typeof maybeText === "string" ? maybeText : "";
			})
			.join("")
			.trim();
		if (text.length > 0) lastText = text;
	}
	if (lastText.length === 0) throw new Error("bootstrap model did not return an assistant message");
	return lastText;
}

async function generateBootstrapWithConfiguredTarget(
	input: Parameters<typeof buildBootstrapPrompt>[0],
): Promise<BootstrapStructuredOutput> {
	const prompt = buildBootstrapPrompt(input);
	const child = spawn(process.execPath, [cliEntryPath(), "--no-context-files", "run", "--json", prompt], {
		cwd: input.cwd,
		env: { ...process.env, CLIO_BOOTSTRAP_GENERATE_CHILD: "1" },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		stdout += chunk;
	});
	child.stderr.on("data", (chunk: string) => {
		stderr += chunk;
	});
	const exit = await new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
	if (exit !== 0) {
		const detail = stderr.trim().slice(0, 1000);
		throw new Error(`bootstrap model generation failed with exit ${exit ?? "signal"}${detail ? `: ${detail}` : ""}`);
	}
	return parseBootstrapModelOutput(parseHeadlessJsonOutput(stdout));
}

export async function runInitCommand(args: string[]): Promise<number> {
	if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
		process.stdout.write(HELP);
		return 0;
	}
	const assumeYes = hasFlag(args, "--yes") || hasFlag(args, "-y");
	const useModel = hasFlag(args, "--generate");
	try {
		await runBootstrap({
			cwd: process.cwd(),
			io: {
				stdout: (s) => process.stdout.write(s),
				stderr: (s) => process.stderr.write(s),
			},
			confirmGitignore: () => confirmGitignore(assumeYes),
			preview: hasFlag(args, "--preview"),
			adopt: hasFlag(args, "--adopt"),
			includeGlobalImports: hasFlag(args, "--global") || hasFlag(args, "--include-global"),
			...(useModel ? { generate: generateBootstrapWithConfiguredTarget, modelId: "configured-clio-target" } : {}),
		});
		return 0;
	} catch (err) {
		process.stderr.write(`clio init failed: ${err instanceof Error ? err.message : String(err)}\n`);
		return 1;
	}
}
