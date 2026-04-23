import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";

import { readSettings } from "../core/config.js";
import { openAuthStorage } from "../domains/providers/auth/index.js";
import { supportGroupLabel } from "../domains/providers/index.js";
import { createDelayedManualCodeInput } from "./oauth-manual-input.js";
import {
	type ConnectableProviderRow,
	listConnectableProviderRows,
	renderConnectableProviderRows,
	resolveCliProviderReference,
} from "./provider-target.js";
import { printError, printOk } from "./shared.js";

const USAGE = "usage: clio connect [provider|endpoint] [--api-key <value>]\n";

interface ParsedLoginArgs {
	target?: string;
	apiKey?: string;
	help: boolean;
}

function parseLoginArgs(args: ReadonlyArray<string>): ParsedLoginArgs {
	const parsed: ParsedLoginArgs = { help: false };
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === undefined) continue;
		if (arg === "--help" || arg === "-h") {
			parsed.help = true;
			continue;
		}
		if (arg === "--api-key") {
			const value = args[i + 1];
			if (!value) throw new Error("--api-key requires a value");
			parsed.apiKey = value;
			i += 1;
			continue;
		}
		if (arg.startsWith("-")) throw new Error(`unknown flag: ${arg}`);
		if (parsed.target) throw new Error("connect accepts at most one provider or endpoint");
		parsed.target = arg;
	}
	return parsed;
}

function defaultConnectTarget(rows: ReadonlyArray<ConnectableProviderRow>): string | undefined {
	const settings = readSettings();
	const activeEndpoint = settings.orchestrator.endpoint
		? settings.endpoints.find((entry) => entry.id === settings.orchestrator.endpoint)
		: undefined;
	if (activeEndpoint && rows.some((row) => row.entry.runtimeId === activeEndpoint.runtime)) {
		return activeEndpoint.runtime;
	}
	const configured = rows.find((row) => row.endpointCount > 0);
	if (configured) return configured.entry.runtimeId;
	return rows[0]?.entry.runtimeId;
}

async function promptForConnectTarget(rows: ReadonlyArray<ConnectableProviderRow>): Promise<string | null> {
	if (rows.length === 0) {
		printError("no connectable providers are registered");
		return null;
	}
	const rl = createInterface({ input, output });
	const defaultTarget = defaultConnectTarget(rows) ?? rows[0]?.entry.runtimeId ?? "";
	try {
		process.stdout.write("Connect a provider:\n");
		let lastGroup: ConnectableProviderRow["entry"]["group"] | null = null;
		for (const [index, row] of rows.entries()) {
			if (row.entry.group !== lastGroup) {
				lastGroup = row.entry.group;
				process.stdout.write(`  ${supportGroupLabel(row.entry.group)}:\n`);
			}
			const status = row.status?.available
				? row.status.source === "environment"
					? `env:${row.status.detail ?? row.entry.runtimeId}`
					: row.status.source
				: "disconnected";
			process.stdout.write(
				`    ${String(index + 1).padStart(2)}. ${row.entry.runtimeId.padEnd(22)} ${status.padEnd(18)} endpoints=${row.endpointCount}\n`,
			);
		}
		process.stdout.write("\n");
		for (;;) {
			const answer = (await rl.question(`Selection (number or runtime id) [${defaultTarget}]: `)).trim();
			const value = answer.length > 0 ? answer : defaultTarget;
			const numeric = Number(value);
			if (Number.isInteger(numeric) && numeric >= 1 && numeric <= rows.length) {
				return rows[numeric - 1]?.entry.runtimeId ?? null;
			}
			if (rows.some((row) => row.entry.runtimeId === value)) return value;
			process.stderr.write(`unknown selection: ${value}\n`);
		}
	} catch {
		return null;
	} finally {
		rl.close();
	}
}

export async function runConnectCommand(args: ReadonlyArray<string>): Promise<number> {
	let parsed: ParsedLoginArgs;
	try {
		parsed = parseLoginArgs(args);
	} catch (error) {
		printError(error instanceof Error ? error.message : String(error));
		process.stderr.write(USAGE);
		return 2;
	}

	if (parsed.help) {
		process.stdout.write(renderConnectableProviderRows(listConnectableProviderRows()));
		process.stdout.write(USAGE);
		return 0;
	}

	if (!parsed.target) {
		if (!input.isTTY || !output.isTTY) {
			process.stdout.write(renderConnectableProviderRows(listConnectableProviderRows()));
			process.stdout.write(USAGE);
			return 0;
		}
		const picked = await promptForConnectTarget(listConnectableProviderRows());
		if (!picked) return 0;
		parsed.target = picked;
	}

	const resolved = resolveCliProviderReference(parsed.target);
	if (!resolved) {
		printError(`unknown provider or endpoint: ${parsed.target}`);
		process.stderr.write(USAGE);
		return 2;
	}

	const auth = openAuthStorage();
	if (resolved.runtime.auth === "oauth") {
		const rl = createInterface({ input, output });
		const manualCodeInput = createDelayedManualCodeInput(
			rl,
			"Paste verification code if the browser flow does not return automatically: ",
		);
		try {
			await auth.login(resolved.authTarget.providerId, {
				onAuth: ({ url, instructions }) => {
					process.stdout.write(`${url}\n`);
					if (instructions) process.stdout.write(`${instructions}\n`);
					process.stdout.write("Waiting for the browser callback. A manual code prompt will appear if needed.\n");
				},
				onPrompt: async (prompt) => {
					const answer = await rl.question(`${prompt.message}${prompt.allowEmpty ? " " : ": "}`);
					return prompt.allowEmpty ? answer : answer.trim();
				},
				onManualCodeInput: manualCodeInput.onManualCodeInput,
				onProgress: (message) => {
					process.stderr.write(`${message}\n`);
				},
			});
			printOk(`connected ${resolved.authTarget.providerId}`);
			return 0;
		} catch (error) {
			printError(error instanceof Error ? error.message : String(error));
			return 1;
		} finally {
			manualCodeInput.cancel();
			rl.close();
		}
	}

	if (resolved.runtime.auth !== "api-key") {
		printError(`runtime ${resolved.runtime.id} does not support interactive connect`);
		return 1;
	}

	let apiKey = parsed.apiKey;
	const rl = createInterface({ input, output });
	try {
		if (!apiKey) {
			apiKey = (await rl.question(`API key for ${resolved.runtime.displayName}: `)).trim();
		}
		if (!apiKey) {
			printError("empty API key");
			return 1;
		}
		auth.setApiKey(resolved.authTarget.providerId, apiKey);
		printOk(`connected ${resolved.authTarget.providerId}`);
		return 0;
	} finally {
		rl.close();
	}
}

export const runLoginCommand = runConnectCommand;
