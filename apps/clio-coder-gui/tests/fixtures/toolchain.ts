import { createHash } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { PINNED_TOOLS, type PinnedTool } from "../../../../src/domains/toolchain/index.js";
import type { WorkerSettings } from "../../server/worker/protocol.js";

export { PINNED_TOOLS };
export function fixtureOptions(settings: WorkerSettings = {}) {
	const original = PINNED_TOOLS[0];
	if (!original) throw new Error("Tool registry is empty.");
	const bytes = Buffer.from(`#!/bin/sh\nprintf 'herdr ${original.version}\\n'\n`);
	const doc = Buffer.from("Fabricated fixture license; no upstream executable is downloaded.\n");
	const url = "https://fixture.invalid/herdr";
	const docUrl = "https://fixture.invalid/LICENSE";
	const entry: PinnedTool = {
		...original,
		summary: "Fabricated install fixture · isolated scratch home",
		downloads: {
			"linux-x64": {
				url,
				sha256: createHash("sha256").update(bytes).digest("hex"),
				archive: "raw",
				binaryMembers: { herdr: "" },
				documentMembers: [],
			},
		},
		documents: [{ name: "LICENSE", url: docUrl, sha256: createHash("sha256").update(doc).digest("hex") }],
	};
	return {
		pins: [entry, ...PINNED_TOOLS.slice(1)],
		fetcher: async (requested: string) => {
			await setTimeout(settings.installDelayMs ?? 30);
			if (settings.failInstall) throw new Error("Injected download failure with private-stderr-sentinel");
			if (requested === url) return bytes;
			if (requested === docUrl) return doc;
			throw new Error("Fixture mode downloads only the fabricated herdr tool.");
		},
	};
}
