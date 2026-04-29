import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { resolvePackageRoot } from "../core/package-root.js";
import { createComponentSnapshot, diffComponentSnapshots, loadComponentSnapshot } from "../domains/components/index.js";
import type { ComponentDiff, ComponentSnapshot, HarnessComponent } from "../domains/components/types.js";
import { printError, printOk } from "./shared.js";

const HELP = `clio components [--json]
clio components snapshot --out <path>
clio components diff --from <snapshot-a.json> --to <snapshot-b.json> [--json]

List read-only Clio Coder harness components, write a snapshot, or diff two snapshots.
`;

interface ParsedComponentsArgs {
	command: "list" | "snapshot" | "diff";
	json: boolean;
	out?: string;
	from?: string;
	to?: string;
	help: boolean;
}

function parseComponentsArgs(args: ReadonlyArray<string>): ParsedComponentsArgs {
	const parsed: ParsedComponentsArgs = { command: "list", json: false, help: false };
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === undefined) continue;
		if (arg === "--help" || arg === "-h") {
			parsed.help = true;
			continue;
		}
		if (arg === "--json") {
			parsed.json = true;
			continue;
		}
		if (arg === "snapshot") {
			parsed.command = "snapshot";
			continue;
		}
		if (arg === "diff") {
			parsed.command = "diff";
			continue;
		}
		if (arg === "--out") {
			const value = args[i + 1];
			if (!value || value.startsWith("-")) throw new Error("--out requires a path");
			parsed.out = value;
			i += 1;
			continue;
		}
		if (arg === "--from") {
			const value = args[i + 1];
			if (!value || value.startsWith("-")) throw new Error("--from requires a path");
			parsed.from = value;
			i += 1;
			continue;
		}
		if (arg === "--to") {
			const value = args[i + 1];
			if (!value || value.startsWith("-")) throw new Error("--to requires a path");
			parsed.to = value;
			i += 1;
			continue;
		}
		if (arg.startsWith("-")) throw new Error(`unknown flag: ${arg}`);
		throw new Error(`unknown components argument: ${arg}`);
	}
	if (parsed.command !== "snapshot" && parsed.out !== undefined) throw new Error("--out is only valid with snapshot");
	if (parsed.command !== "diff" && parsed.from !== undefined) throw new Error("--from is only valid with diff");
	if (parsed.command !== "diff" && parsed.to !== undefined) throw new Error("--to is only valid with diff");
	if (parsed.command === "snapshot" && parsed.json) throw new Error("--json is only valid with list");
	if (parsed.command === "snapshot" && parsed.out === undefined) throw new Error("snapshot requires --out <path>");
	if (parsed.command === "diff" && (parsed.from === undefined || parsed.to === undefined)) {
		throw new Error("diff requires --from <path> and --to <path>");
	}
	return parsed;
}

export async function runComponentsCommand(args: ReadonlyArray<string>): Promise<number> {
	let parsed: ParsedComponentsArgs;
	try {
		parsed = parseComponentsArgs(args);
	} catch (error) {
		printError(error instanceof Error ? error.message : String(error));
		process.stdout.write(HELP);
		return 2;
	}
	if (parsed.help) {
		process.stdout.write(HELP);
		return 0;
	}

	if (parsed.command === "diff") return runDiff(parsed);

	const snapshot = await createComponentSnapshot({ root: resolvePackageRoot() });
	if (parsed.command === "snapshot") {
		const out = parsed.out;
		if (out === undefined) {
			printError("snapshot requires --out <path>");
			return 2;
		}
		const outPath = resolve(out);
		await mkdir(dirname(outPath), { recursive: true });
		await writeFile(outPath, `${formatSnapshotJson(snapshot)}\n`, "utf8");
		printOk(`wrote ${outPath}`);
		return 0;
	}

	if (parsed.json) {
		process.stdout.write(`${formatSnapshotJson(snapshot)}\n`);
		return 0;
	}
	renderComponents(snapshot.components);
	return 0;
}

async function runDiff(parsed: ParsedComponentsArgs): Promise<number> {
	const fromPath = parsed.from;
	const toPath = parsed.to;
	if (fromPath === undefined || toPath === undefined) {
		printError("diff requires --from <path> and --to <path>");
		return 2;
	}
	let diff: ComponentDiff;
	try {
		const from = await loadComponentSnapshot(resolve(fromPath));
		const to = await loadComponentSnapshot(resolve(toPath));
		diff = diffComponentSnapshots(from, to);
	} catch (error) {
		printError(error instanceof Error ? error.message : String(error));
		return 1;
	}
	if (parsed.json) {
		process.stdout.write(`${JSON.stringify(diff, null, 2)}\n`);
	} else {
		renderComponentDiff(diff);
	}
	return 0;
}

function formatSnapshotJson(snapshot: ComponentSnapshot): string {
	return JSON.stringify(snapshot, null, 2);
}

function renderComponents(components: ReadonlyArray<HarnessComponent>): void {
	process.stdout.write(`${components.length} components\n\n`);
	for (const component of components) {
		const description = component.description ? ` ${component.description}` : "";
		const line = [
			component.kind.padEnd(21),
			component.authority.padEnd(17),
			component.reloadClass.padEnd(18),
			component.path,
		].join("");
		process.stdout.write(`${line}${description}\n`);
	}
}

function renderComponentDiff(diff: ComponentDiff): void {
	const { summary } = diff;
	process.stdout.write(
		[
			`${summary.added} added`,
			`${summary.removed} removed`,
			`${summary.changed} changed`,
			`${summary.unchanged} unchanged`,
		].join(", "),
	);
	process.stdout.write("\n\n");
	if (summary.added + summary.removed + summary.changed === 0) {
		process.stdout.write("no component changes\n");
		return;
	}
	for (const component of diff.added) process.stdout.write(`${formatDiffLine("+", component)}\n`);
	for (const component of diff.removed) process.stdout.write(`${formatDiffLine("-", component)}\n`);
	for (const change of diff.changed) {
		process.stdout.write(`${formatDiffLine("~", change.after)} [${change.changedFields.join(",")}]\n`);
	}
}

function formatDiffLine(marker: "+" | "-" | "~", component: HarnessComponent): string {
	return [
		marker,
		" ",
		component.kind.padEnd(21),
		component.authority.padEnd(17),
		component.reloadClass.padEnd(18),
		component.path,
	].join("");
}
