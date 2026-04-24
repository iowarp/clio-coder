import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";

import { readSettings } from "../core/config.js";
import { authNotRequiredStatus, openAuthStorage, targetRequiresAuth } from "../domains/providers/auth/index.js";
import type { AuthStatus } from "../domains/providers/index.js";
import { supportGroupLabel } from "../domains/providers/index.js";
import { nativeCliAuthStatus, runNativeCliLogin, runNativeCliLogout } from "./native-cli-auth.js";
import { createDelayedManualCodeInput } from "./oauth-manual-input.js";
import {
	type ConnectableProviderRow,
	listConnectableProviderRows,
	renderConnectableProviderRows,
	resolveCliProviderReference,
} from "./provider-target.js";
import { printError, printOk } from "./shared.js";

const USAGE = `usage: clio auth list
       clio auth status [target-or-runtime]
       clio auth login [target-or-runtime] [--api-key <value>]
       clio auth logout [target-or-runtime]
`;

interface ParsedAuthTargetArgs {
	target?: string;
	apiKey?: string;
	help: boolean;
}

function parseAuthTargetArgs(args: ReadonlyArray<string>, verb: string): ParsedAuthTargetArgs {
	const parsed: ParsedAuthTargetArgs = { help: false };
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
		if (parsed.target) throw new Error(`auth ${verb} accepts at most one target or runtime`);
		parsed.target = arg;
	}
	return parsed;
}

function printStatusLine(id: string, type: string | null, present: boolean, source: string): void {
	process.stdout.write(`${id}\t${type ?? "-"}\t${present ? "present" : "absent"}\t${source}\n`);
}

function printNativeStatusLine(
	id: string,
	state: "authenticated" | "unauthenticated" | "unknown" | "not-required",
	detail: string,
): void {
	process.stdout.write(`${id}\tcli\t${state}\t${detail}\n`);
}

function defaultAuthTarget(rows: ReadonlyArray<ConnectableProviderRow>): string | undefined {
	const settings = readSettings();
	const activeTarget = settings.orchestrator.endpoint
		? settings.endpoints.find((entry) => entry.id === settings.orchestrator.endpoint)
		: undefined;
	if (activeTarget && rows.some((row) => row.entry.runtimeId === activeTarget.runtime)) {
		return activeTarget.runtime;
	}
	const configured = rows.find((row) => row.targetCount > 0);
	if (configured) return configured.entry.runtimeId;
	return rows[0]?.entry.runtimeId;
}

async function promptForLoginTarget(rows: ReadonlyArray<ConnectableProviderRow>): Promise<string | null> {
	if (rows.length === 0) {
		printError("no auth-capable runtimes are registered");
		return null;
	}
	const rl = createInterface({ input, output });
	const defaultTarget = defaultAuthTarget(rows) ?? rows[0]?.entry.runtimeId ?? "";
	try {
		process.stdout.write("Authenticate a runtime:\n");
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
				: row.status === null
					? "native-cli"
					: "disconnected";
			process.stdout.write(
				`    ${String(index + 1).padStart(2)}. ${row.entry.runtimeId.padEnd(22)} ${status.padEnd(18)} targets=${row.targetCount}\n`,
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

function storedCredentialRows(rows: ReadonlyArray<ConnectableProviderRow>): ConnectableProviderRow[] {
	return rows.filter((row) => row.status?.source === "stored-api-key" || row.status?.source === "stored-oauth");
}

function statusForResolvedTarget(
	resolved: NonNullable<ReturnType<typeof resolveCliProviderReference>>,
	auth: ReturnType<typeof openAuthStorage>,
): AuthStatus {
	if (resolved.endpoint && !targetRequiresAuth(resolved.endpoint, resolved.runtime)) {
		return authNotRequiredStatus(resolved.authTarget.providerId);
	}
	if (!resolved.endpoint && resolved.runtime.auth !== "api-key" && resolved.runtime.auth !== "oauth") {
		return authNotRequiredStatus(resolved.authTarget.providerId);
	}
	return auth.statusForTarget(resolved.authTarget, { includeFallback: false });
}

async function promptForLogoutTarget(rows: ReadonlyArray<ConnectableProviderRow>): Promise<string | null> {
	if (rows.length === 0) {
		printError("no stored target credentials");
		return null;
	}
	const rl = createInterface({ input, output });
	const defaultTarget = defaultAuthTarget(rows) ?? rows[0]?.entry.runtimeId ?? "";
	try {
		process.stdout.write("Remove stored credentials:\n");
		let lastGroup: ConnectableProviderRow["entry"]["group"] | null = null;
		for (const [index, row] of rows.entries()) {
			if (row.entry.group !== lastGroup) {
				lastGroup = row.entry.group;
				process.stdout.write(`  ${supportGroupLabel(row.entry.group)}:\n`);
			}
			process.stdout.write(
				`    ${String(index + 1).padStart(2)}. ${row.entry.runtimeId.padEnd(22)} ${String(row.status?.source ?? "disconnected")}\n`,
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

async function runLogin(args: ReadonlyArray<string>): Promise<number> {
	let parsed: ParsedAuthTargetArgs;
	try {
		parsed = parseAuthTargetArgs(args, "login");
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
			process.stderr.write(USAGE);
			return 2;
		}
		const picked = await promptForLoginTarget(listConnectableProviderRows());
		if (!picked) return 0;
		parsed.target = picked;
	}

	const resolved = resolveCliProviderReference(parsed.target);
	if (!resolved) {
		printError(`unknown target or runtime: ${parsed.target}`);
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
			printOk(`authenticated ${resolved.authTarget.providerId}`);
			return 0;
		} catch (error) {
			printError(error instanceof Error ? error.message : String(error));
			return 1;
		} finally {
			manualCodeInput.cancel();
			rl.close();
		}
	}

	if (resolved.runtime.auth === "cli") {
		return runNativeCliLogin(resolved.runtime, input.isTTY && output.isTTY);
	}

	if (resolved.runtime.auth !== "api-key") {
		printError(`runtime ${resolved.runtime.id} does not support interactive auth login`);
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
		printOk(`authenticated ${resolved.authTarget.providerId}`);
		return 0;
	} finally {
		rl.close();
	}
}

async function runStatus(args: ReadonlyArray<string>): Promise<number> {
	if (args.includes("--help") || args.includes("-h")) {
		process.stdout.write(USAGE);
		return 0;
	}
	if (args.some((arg) => arg.startsWith("-"))) {
		printError(`unknown flag: ${args.find((arg) => arg.startsWith("-"))}`);
		process.stderr.write(USAGE);
		return 2;
	}
	if (args.length > 1) {
		printError("auth status accepts at most one target or runtime");
		process.stderr.write(USAGE);
		return 2;
	}

	const auth = openAuthStorage();
	const target = args[0];
	if (target) {
		const resolved = resolveCliProviderReference(target);
		if (!resolved) {
			printError(`unknown target or runtime: ${target}`);
			return 2;
		}
		if (resolved.runtime.auth === "cli") {
			const status = await nativeCliAuthStatus(resolved.runtime);
			printNativeStatusLine(resolved.runtime.id, status.state, status.detail);
			return status.exitCode;
		}
		const status = statusForResolvedTarget(resolved, auth);
		printStatusLine(
			resolved.authTarget.providerId,
			status.credentialType,
			status.available,
			status.detail ?? status.source,
		);
		return status.available ? 0 : 1;
	}

	for (const row of listConnectableProviderRows()) {
		const status = row.status;
		if (status === null) {
			printNativeStatusLine(
				row.entry.runtimeId,
				"unknown",
				"native CLI auth; run targeted status to probe when supported",
			);
		} else {
			printStatusLine(row.entry.runtimeId, status.credentialType, status.available, status.detail ?? status.source);
		}
	}
	return 0;
}

function runLogout(args: ReadonlyArray<string>): Promise<number> | number {
	if (args.includes("--help") || args.includes("-h")) {
		process.stdout.write(USAGE);
		return 0;
	}
	if (args.some((arg) => arg.startsWith("-"))) {
		printError(`unknown flag: ${args.find((arg) => arg.startsWith("-"))}`);
		process.stderr.write(USAGE);
		return 2;
	}
	const target = args[0];
	if (!target) {
		const rows = storedCredentialRows(listConnectableProviderRows());
		if (!input.isTTY || !output.isTTY) {
			process.stdout.write(renderConnectableProviderRows(rows));
			process.stderr.write(USAGE);
			return 2;
		}
		return promptForLogoutTarget(rows).then((picked) => (picked ? runLogout([picked]) : 1));
	}
	if (args.length > 1) {
		printError("auth logout accepts at most one target or runtime");
		process.stderr.write(USAGE);
		return 2;
	}

	const resolved = resolveCliProviderReference(target);
	if (!resolved) {
		printError(`unknown target or runtime: ${target}`);
		process.stderr.write(USAGE);
		return 2;
	}
	if (resolved.runtime.auth === "cli") {
		return runNativeCliLogout(resolved.runtime, input.isTTY && output.isTTY);
	}

	const auth = openAuthStorage();
	const status = statusForResolvedTarget(resolved, auth);
	if (!status.available) {
		printError(`no stored credential for ${resolved.authTarget.providerId}`);
		return 1;
	}
	if (status.source === "environment") {
		printError(
			`credential for ${resolved.authTarget.providerId} comes from ${status.detail ?? "the environment"}; clear the env var to log out`,
		);
		return 1;
	}
	if (status.source !== "stored-api-key" && status.source !== "stored-oauth") {
		printError(`cannot remove credential for ${resolved.authTarget.providerId} from source ${status.source}`);
		return 1;
	}
	auth.logout(resolved.authTarget.providerId);
	printOk(`removed credential for ${resolved.authTarget.providerId}`);
	return 0;
}

export async function runAuthCommand(args: ReadonlyArray<string>): Promise<number> {
	const subcommand = args[0] ?? "status";
	const rest = args.slice(1);
	if (subcommand === "list") {
		if (rest.length > 0 && rest.some((arg) => arg !== "--help" && arg !== "-h")) {
			printError("auth list does not accept target arguments");
			process.stderr.write(USAGE);
			return 2;
		}
		process.stdout.write(renderConnectableProviderRows(listConnectableProviderRows()));
		return 0;
	}
	if (subcommand === "status") return runStatus(rest);
	if (subcommand === "login") return runLogin(rest);
	if (subcommand === "logout") return runLogout(rest);
	if (subcommand === "--help" || subcommand === "-h") {
		process.stdout.write(USAGE);
		return 0;
	}
	printError(`unknown auth subcommand: ${subcommand}`);
	process.stderr.write(USAGE);
	return 2;
}
