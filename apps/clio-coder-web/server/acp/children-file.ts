import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { Id } from "../../contracts/common.js";
import { processBirthToken } from "../clio/http-shims.js";
import { childRunning, signalRecordedChild } from "../process-policy.js";
import { AppProblem } from "../services/problem.js";
import { type AppFiles, ownerDead } from "../state/files.js";

const nullableToken = Type.Union([Type.String(), Type.Null()]);
const Row = Type.Object(
	{
		ownerId: Id,
		ownerPid: Type.Integer({ minimum: 1 }),
		ownerBirthToken: nullableToken,
		pid: Type.Integer({ minimum: 1 }),
		birthToken: nullableToken,
		sessionId: Id,
		workspaceId: Id,
	},
	{ additionalProperties: false },
);
export type ChildRow = Static<typeof Row>;
const Rows = Type.Array(Row);
export class ChildrenFile {
	readonly owner = { ownerId: randomUUID(), ownerPid: process.pid, ownerBirthToken: processBirthToken() };
	constructor(private readonly files: AppFiles) {}
	async rows() {
		const rows = await this.files.read("children");
		if (!Value.Check(Rows, rows))
			throw new AppProblem("unavailable", "ACP ownership records are invalid; no process was signalled.");
		return rows;
	}
	async record(pid: number, sessionId: string, workspaceId: string): Promise<ChildRow> {
		const row = { ...this.owner, pid, birthToken: processBirthToken(pid), sessionId, workspaceId };
		await this.change((rows) => [...rows, row]);
		return row;
	}
	async bind(row: ChildRow, sessionId: string) {
		await this.change((rows) =>
			rows.map((current) =>
				current.ownerId === row.ownerId && current.pid === row.pid ? { ...current, sessionId } : current,
			),
		);
		row.sessionId = sessionId;
	}
	async remove(row: ChildRow) {
		await this.change((rows) =>
			rows.filter(
				(current) => !(current.ownerId === row.ownerId && current.pid === row.pid && current.birthToken === row.birthToken),
			),
		);
	}
	private change(update: (rows: ChildRow[]) => ChildRow[]) {
		return this.files.update("children", (current) => {
			if (!Value.Check(Rows, current)) throw new AppProblem("unavailable", "ACP ownership records are invalid.");
			return { value: update(current), result: undefined };
		});
	}
	orphan(row: ChildRow) {
		return ownerDead(row.ownerPid, row.ownerBirthToken);
	}
	async reap(row: ChildRow) {
		// Recheck both identities immediately before each signal. No row means no candidate.
		if (!this.orphan(row)) return "other-owner" as const;
		if (!row.birthToken || row.birthToken.startsWith("pid-") || processBirthToken(row.pid) !== row.birthToken) {
			await this.remove(row);
			return "identity-mismatch" as const;
		}
		if (await childRunning(row.pid)) signalRecordedChild(row.pid, row.birthToken, "SIGTERM");
		for (let i = 0; i < 50; i++) {
			if (!(await childRunning(row.pid)) || processBirthToken(row.pid) !== row.birthToken) {
				await this.remove(row);
				return "closed" as const;
			}
			if (i === 10 && this.orphan(row)) signalRecordedChild(row.pid, row.birthToken, "SIGKILL");
			await setTimeout(50);
		}
		return "unknown" as const;
	}
}
