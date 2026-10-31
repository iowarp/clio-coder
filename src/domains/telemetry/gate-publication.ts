import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { resolvePackageRoot } from "../../core/package-root.js";
import type { TelemetryContext } from "../../core/telemetry/context.js";
import type { EventPayload } from "../../core/telemetry/events.js";
import { telemetryHub } from "../../core/telemetry/hub.js";
import { openCallJournal, ownedCallJournal, readCallJournal } from "./call-journal.js";
import { telemetryProcessDirectory, telemetryRunDirectory, telemetrySessionDirectory } from "./paths.js";

const publications = new Map<string, Promise<void>>();

/** Publish once by stable decision id, including recovery after an artifact rename (#434). */
export async function publishGateDecision(
	stateDir: string,
	context: TelemetryContext,
	data: EventPayload<"gate.decided">,
): Promise<void> {
	const directory =
		"processId" in context
			? telemetryProcessDirectory(stateDir, context.processId)
			: context.runId !== undefined
				? telemetryRunDirectory(stateDir, context.runId)
				: telemetrySessionDirectory(stateDir, context.sessionId);
	const prior = publications.get(directory);
	const publication = (async () => {
		await prior?.catch(() => {}); // A failed publication leaves its WAL for another attempt (#434).
		const existing = ownedCallJournal(context);
		let journal = existing;
		if (!journal) {
			const pkg = JSON.parse(await readFile(join(resolvePackageRoot(), "package.json"), "utf8")) as {
				version: string;
				dependencies: Record<string, string>;
			};
			journal = await openCallJournal({
				directory,
				context,
				writer: { clioCoderVersion: pkg.version, piVersion: pkg.dependencies["@earendil-works/pi-ai"] ?? "unknown" },
			});
		}
		try {
			await journal.flush();
			const findDecision = async () =>
				(await readCallJournal(directory)).records.find(
					({ record }) => record.k === "gate.decided" && record.data.decisionId === data.decisionId,
				)?.record;
			const decided = await findDecision();
			if (decided?.k === "gate.decided" && decided.data.digest !== data.digest)
				throw new Error(`gate decision telemetry conflicts with artifact: ${data.decisionId}`);
			if (!decided) {
				if (!telemetryHub().emit("gate.decided", data, context))
					throw new Error(`gate decision telemetry could not be enqueued: ${data.decisionId}`);
				await journal.flush();
			}
			if (journal.health().writeErrors > 0 || !(await findDecision()))
				throw new Error(`gate decision telemetry was not durably written: ${data.decisionId}`);
		} finally {
			if (!existing) await journal.close();
		}
	})();
	publications.set(directory, publication);
	try {
		await publication;
	} finally {
		if (publications.get(directory) === publication) publications.delete(directory);
	}
}
