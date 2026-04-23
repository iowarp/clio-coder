import { openAuthStorage } from "../domains/providers/auth/index.js";
import {
	listConnectableProviderRows,
	renderConnectableProviderRows,
	resolveCliProviderReference,
} from "./provider-target.js";
import { printError } from "./shared.js";

const USAGE = "usage: clio auth [list|status] [provider|endpoint]\n";

function printStatusLine(id: string, type: string | null, present: boolean, source: string): void {
	process.stdout.write(`${id}\t${type ?? "-"}\t${present ? "present" : "absent"}\t${source}\n`);
}

export async function runAuthCommand(args: ReadonlyArray<string>): Promise<number> {
	const auth = openAuthStorage();
	const subcommand = args[0] ?? "status";

	if (subcommand === "list") {
		process.stdout.write(renderConnectableProviderRows(listConnectableProviderRows()));
		return 0;
	}

	if (subcommand !== "status") {
		printError(`unknown auth subcommand: ${subcommand}`);
		process.stderr.write(USAGE);
		return 2;
	}

	const target = args[1];
	if (target) {
		const resolved = resolveCliProviderReference(target);
		if (!resolved) {
			printError(`unknown provider or endpoint: ${target}`);
			return 2;
		}
		const status = auth.statusForTarget(resolved.authTarget, { includeFallback: false });
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
		printStatusLine(
			row.entry.runtimeId,
			status?.credentialType ?? null,
			status?.available ?? false,
			status?.detail ?? status?.source ?? "none",
		);
	}
	return 0;
}
