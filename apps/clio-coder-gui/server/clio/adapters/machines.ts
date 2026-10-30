import { Type } from "typebox";
import { Value } from "typebox/value";
import type { MachineMutation } from "../../../contracts/machines.js";
import { Machine, MachineId } from "../../../contracts/machines.js";
import { CliRunner } from "../../services/cli-runner.js";
import { AppProblem } from "../../services/problem.js";
import type { MachineEndpoint } from "../../worker/protocol.js";

// Fleet-node imports are not an approved root seam. The fixed CLI commands call the
// same registry and preflight functions, in the worker's canonical project cwd.
const runner = new CliRunner();
export const closeMachines = () => runner.close();

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new AppProblem("unavailable", "Clio returned an invalid machine record.");
	return value as Record<string, unknown>;
}

export async function readMachines(cwd: string): Promise<Machine[]> {
	const raw = object(await runner.run({ kind: "machines.list" }, cwd));
	if (!Array.isArray(raw.nodes) || raw.nodes.length > 10_000)
		throw new AppProblem("unavailable", "Clio returned an invalid machine inventory.");
	return raw.nodes.map((entry) => {
		const item = object(entry);
		const node = object(item.node);
		const record = item.record === null ? null : object(item.record);
		const projected = Value.Clean(Machine, {
			id: node.id,
			host: node.host,
			user: node.user ?? null,
			port: node.port ?? null,
			maxWorkers: node.maxWorkers,
			labels: node.labels ?? [],
			enabled: null,
			readiness: item.readiness,
			reason: item.reason,
			checkedAt: item.checkedAt,
			ageMs: item.ageMs,
			checks: record?.checks ?? null,
			localVersion: record?.localVersion ?? null,
			remoteVersion: record?.remoteVersion ?? null,
			note: record?.note ?? null,
			project: record?.project ?? null,
		});
		if (!Value.Check(Machine, projected))
			throw new AppProblem("unavailable", "Clio returned an invalid machine projection.");
		return projected;
	});
}

const nullableText = Type.Union([Type.String(), Type.Null()]);
const Endpoint = Type.Object(
	{
		id: MachineId,
		host: Type.String({ minLength: 1 }),
		user: nullableText,
		port: Type.Union([Type.Integer({ minimum: 1, maximum: 65535 }), Type.Null()]),
		identityFile: nullableText,
		connectTimeoutSec: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
		clioCoderEntry: nullableText,
	},
	{ additionalProperties: false },
);

/** The SSH destinations of every registered node, for the attach supervisor; readiness is not read here. */
export async function readMachineEndpoints(cwd: string): Promise<MachineEndpoint[]> {
	const raw = object(await runner.run({ kind: "machines.list" }, cwd));
	if (!Array.isArray(raw.nodes) || raw.nodes.length > 10_000)
		throw new AppProblem("unavailable", "Clio returned an invalid machine inventory.");
	return raw.nodes.map((entry) => {
		const node = object(object(entry).node);
		const endpoint = Value.Clean(Endpoint, {
			id: node.id,
			host: node.host,
			user: node.user ?? null,
			port: node.port ?? null,
			identityFile: node.identityFile ?? null,
			connectTimeoutSec: node.connectTimeoutSec ?? null,
			clioCoderEntry: node.clioCoderEntry ?? null,
		});
		if (!Value.Check(Endpoint, endpoint))
			throw new AppProblem("unavailable", "Clio returned an invalid machine endpoint.");
		return endpoint;
	});
}

export async function mutateMachine(cwd: string, mutation: MachineMutation) {
	try {
		if (mutation.action === "add") {
			await runner.run({ kind: "machines.add", machine: mutation.machine }, cwd);
			return { id: mutation.machine.id, message: "Machine registered. No SSH check was run." };
		}
		if (mutation.action === "remove") {
			await runner.run({ kind: "machines.remove", id: mutation.id }, cwd);
			return { id: mutation.id, message: "Machine removed from the registry. Remote files remain in place." };
		}
		const raw = object(await runner.run({ kind: "machines.check", id: mutation.id }, cwd));
		if (raw.nodeId !== mutation.id || typeof raw.ok !== "boolean")
			throw new AppProblem("operation_failed", "Clio returned an invalid readiness result. Refresh recorded checks.");
		return {
			id: mutation.id,
			message: raw.ok
				? "Check recorded. Refresh the project inventory to see current eligibility."
				: "Check recorded: this machine needs attention. Review its project evidence.",
		};
	} catch (error) {
		if (mutation.action === "remove" && error instanceof AppProblem && /exit code 2/.test(error.message))
			throw new AppProblem(
				"operation_failed",
				"Clio refused removal. The node may be unknown, the standing default, or pinned by a fleet profile. Refresh the registry and clear any placement references in settings before retrying.",
			);
		throw error;
	}
}
