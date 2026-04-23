import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";

import { readSettings } from "../core/config.js";
import { openAuthStorage } from "../domains/providers/auth/index.js";
import { supportGroupLabel } from "../domains/providers/index.js";
import {
	type ConnectableProviderRow,
	listConnectableProviderRows,
	renderConnectableProviderRows,
	resolveCliProviderReference,
} from "./provider-target.js";
import { printError, printOk } from "./shared.js";

const USAGE = "usage: clio disconnect [provider|endpoint]\n";

function disconnectableRows(rows: ReadonlyArray<ConnectableProviderRow>): ConnectableProviderRow[] {
	return rows.filter((row) => row.status?.source === "stored-api-key" || row.status?.source === "stored-oauth");
}

function defaultDisconnectTarget(rows: ReadonlyArray<ConnectableProviderRow>): string | undefined {
	const settings = readSettings();
	const activeEndpoint = settings.orchestrator.endpoint
		? settings.endpoints.find((entry) => entry.id === settings.orchestrator.endpoint)
		: undefined;
	if (activeEndpoint && rows.some((row) => row.entry.runtimeId === activeEndpoint.runtime)) {
		return activeEndpoint.runtime;
	}
	return rows[0]?.entry.runtimeId;
}

async function promptForDisconnectTarget(rows: ReadonlyArray<ConnectableProviderRow>): Promise<string | null> {
	if (rows.length === 0) {
		printError("no stored provider credentials");
		return null;
	}
	const rl = createInterface({ input, output });
	const defaultTarget = defaultDisconnectTarget(rows) ?? rows[0]?.entry.runtimeId ?? "";
	try {
		process.stdout.write("Disconnect a provider:\n");
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

export async function runDisconnectCommand(args: ReadonlyArray<string>): Promise<number> {
	const target = args[0];
	if (!target) {
		const rows = disconnectableRows(listConnectableProviderRows());
		if (!input.isTTY || !output.isTTY) {
			process.stdout.write(renderConnectableProviderRows(rows));
			process.stderr.write(USAGE);
			return 2;
		}
		const picked = await promptForDisconnectTarget(rows);
		if (!picked) return 1;
		return runDisconnectCommand([picked]);
	}

	const resolved = resolveCliProviderReference(target);
	if (!resolved) {
		printError(`unknown provider or endpoint: ${target}`);
		process.stderr.write(USAGE);
		return 2;
	}

	const auth = openAuthStorage();
	const status = auth.statusForTarget(resolved.authTarget, { includeFallback: false });
	if (!status.available) {
		printError(`no stored credential for ${resolved.authTarget.providerId}`);
		return 1;
	}
	if (status.source === "environment") {
		printError(
			`credential for ${resolved.authTarget.providerId} comes from ${status.detail ?? "the environment"}; clear the env var to disconnect`,
		);
		return 1;
	}
	if (status.source !== "stored-api-key" && status.source !== "stored-oauth") {
		printError(`cannot disconnect ${resolved.authTarget.providerId} from source ${status.source}`);
		return 1;
	}
	auth.logout(resolved.authTarget.providerId);
	printOk(`disconnected ${resolved.authTarget.providerId}`);
	return 0;
}

export const runLogoutCommand = runDisconnectCommand;
