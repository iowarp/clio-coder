import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { resolvePackageRoot } from "../../core/package-root.js";
import type { TelemetryContext } from "../../core/telemetry/context.js";
import type { EventPayload } from "../../core/telemetry/events.js";
import { telemetryHub } from "../../core/telemetry/hub.js";
import { openCallJournal, ownedCallJournal, readCallJournal } from "./call-journal.js";
import {
	telemetryBundlePath,
	telemetryProcessDirectory,
	telemetryRunDirectory,
	telemetrySessionDirectory,
} from "./paths.js";
import { SEAL_EVENTS } from "./seal.js";

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
		const findDecision = async () =>
			(await readCallJournal(directory)).records.find(
				({ record }) => record.k === "gate.decided" && record.data.decisionId === data.decisionId,
			)?.record;
		const existing = ownedCallJournal(context);
		// A decision into a scope already sealed, such as a finished run, is the one append outside its lifecycle; the
		// publication seals it again itself and fails if that seal does not land (#434).
		let reseal = false;
		if (!existing) {
			const { records } = await readCallJournal(directory);
			const decided = records.find(
				({ record }) => record.k === "gate.decided" && record.data.decisionId === data.decisionId,
			)?.record;
			if (decided?.k === "gate.decided" && decided.data.digest !== data.digest)
				throw new Error(`gate decision telemetry conflicts with artifact: ${data.decisionId}`);
			// The obligation lives in the journal: a sealed scope with records after its last seal, or whose bundle never
			// landed, still owes that seal, such as after an earlier publication's reseal failed (#434).
			const sealKinds: ReadonlySet<string> = new Set(Object.values(SEAL_EVENTS));
			let lastSeal = -1;
			for (const [index, { record }] of records.entries()) if (sealKinds.has(record.k)) lastSeal = index;
			const bundled = existsSync(telemetryBundlePath(directory));
			const owed = lastSeal >= 0 && (lastSeal < records.length - 1 || !bundled);
			// A retry of a publication that already landed resolves by reading, unless its seal is still owed.
			if (decided && !owed) return;
			reseal = owed || bundled;
		}
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
			// Seal and close as one operation, so nothing lands between this publication's seal and its close.
			if (reseal && !(await journal.sealAndClose()))
				throw new Error(`gate decision telemetry could not reseal its scope: ${data.decisionId}`);
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
