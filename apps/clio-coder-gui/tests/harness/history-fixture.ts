import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cwdHash } from "../../../../src/engine/session.js";

/**
 * Three saved conversations for one project in a scratch home: a named closed one, a closed one known
 * only by its first message, and one whose ledger never recorded an end. Enough to review the project
 * history page in every row state without a real session store.
 */
export async function seedHistory(home: string, project: string, now = Date.now()): Promise<void> {
	const hash = cwdHash(project);
	const rows = [
		{ name: "Survey the sensor calibration notes", model: "claude-opus-5-5", ended: true, hoursAgo: 3 },
		{
			preview: "Why does the reduction step drop the last sample of every run? Look at reduce.py and the tests.",
			model: "fixture-model",
			ended: true,
			hoursAgo: 26,
		},
		{ name: "Draft the methods section figures", model: null, ended: false, hoursAgo: 70 },
	];
	for (const [index, row] of rows.entries()) {
		const id = `seeded-${index + 1}`;
		const directory = join(home, "state", "sessions", hash, id);
		await mkdir(directory, { recursive: true });
		const at = new Date(now - row.hoursAgo * 3_600_000).toISOString();
		await writeFile(
			join(directory, "meta.json"),
			JSON.stringify({
				id,
				cwd: project,
				cwdHash: hash,
				createdAt: at,
				endedAt: row.ended ? at : null,
				model: row.model,
				target: row.model ? "fixture" : null,
				clioCoderVersion: "0",
				piMonoVersion: "0",
				platform: "linux",
				nodeVersion: "24",
				sessionFormatVersion: 5,
				...("name" in row ? { name: row.name } : {}),
				...("preview" in row ? { firstMessagePreview: row.preview } : {}),
			}),
		);
	}
}
