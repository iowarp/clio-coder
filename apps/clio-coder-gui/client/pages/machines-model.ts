import type { Machine, MachineAdd, MachineMutation } from "../../contracts/machines.js";

export type MachineRequest = {
	readonly key: string;
	readonly workspaceId: string;
	readonly body: MachineMutation;
	readonly epoch: string | null;
	readonly operationId: string | null;
	readonly settled: boolean;
};

export function acceptMachineRequest(
	current: MachineRequest | null,
	key: string,
	operationId: string,
): MachineRequest | null {
	return current?.key === key ? { ...current, operationId } : current;
}

export type MachineDraft = {
	id: string;
	host: string;
	user: string;
	port: string;
	maxWorkers: string;
	labels: string;
};
export const emptyMachineDraft: MachineDraft = {
	id: "",
	host: "",
	user: "",
	port: "",
	maxWorkers: "1",
	labels: "",
};

export function machineDraft(draft: MachineDraft): { machine: MachineAdd; error?: never } | { error: string } {
	const id = draft.id.trim();
	const host = draft.host.trim();
	const user = draft.user.trim();
	const port = draft.port.trim();
	const workers = draft.maxWorkers.trim();
	const labels = [
		...new Set(
			draft.labels
				.split(",")
				.map((label) => label.trim())
				.filter(Boolean),
		),
	];
	if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id) || id === "local")
		return { error: "Use a machine ID of up to 64 letters, numbers, underscores or hyphens. “local” is reserved." };
	if (host.length > 253 || !/^[A-Za-z0-9:][A-Za-z0-9._:-]*$/.test(host))
		return { error: "Enter an SSH alias, hostname or address. Put the SSH user in its own field." };
	if (user && (user.length > 64 || !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(user)))
		return { error: "Enter a valid SSH user name, or leave it blank to use SSH configuration." };
	if (port && (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535))
		return { error: "The SSH port must be a whole number from 1 to 65535." };
	if (!/^\d+$/.test(workers) || Number(workers) < 1 || Number(workers) > 1024)
		return { error: "Worker capacity must be a whole number from 1 to 1024." };
	if (labels.length > 32 || labels.some((label) => !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(label)))
		return { error: "Use up to 32 comma-separated labels containing letters, numbers, dots, underscores or hyphens." };
	return {
		machine: {
			id,
			host,
			maxWorkers: Number(workers),
			labels,
			...(user ? { user } : {}),
			...(port ? { port: Number(port) } : {}),
		},
	};
}

export function machineAge(machine: Machine, now: number): string {
	if (!machine.checkedAt) return "Never checked";
	const checked = Date.parse(machine.checkedAt);
	if (!Number.isFinite(checked) || checked > now) return "Check time unavailable";
	const minutes = Math.floor((now - checked) / 60_000);
	if (minutes < 1) return "Less than a minute ago";
	if (minutes < 60) return `${minutes} min ago`;
	if (minutes < 1440) return `${Math.floor(minutes / 60)} hr ago`;
	return `${Math.floor(minutes / 1440)} days ago`;
}

export function machineStatus(machine: Machine, now: number) {
	if (
		machine.readiness === "ready for this project" &&
		(!machine.checkedAt ||
			!Number.isFinite(Date.parse(machine.checkedAt)) ||
			now - Date.parse(machine.checkedAt) > 86_400_000 ||
			Date.parse(machine.checkedAt) > now)
	)
		return { label: "Check expired", tone: "warn" as const, group: "attention" as const };
	if (machine.readiness === "ready for this project")
		return { label: "Ready for this project", tone: "success" as const, group: "ready" as const };
	if (machine.readiness === "not checked")
		return { label: "Not checked", tone: "unverified" as const, group: "unchecked" as const };
	return {
		label: machine.readiness === "offline" ? "Last check: offline" : "Needs attention",
		tone: "warn" as const,
		group: "attention" as const,
	};
}

export function machineSummary(machines: readonly Machine[], now: number) {
	return machines.reduce(
		(counts, machine) => {
			counts[machineStatus(machine, now).group]++;
			return counts;
		},
		{ ready: 0, attention: 0, unchecked: 0 },
	);
}

export const MACHINE_FILTERS = ["all", "ready", "attention", "unchecked"] as const;
export function filterMachines(
	machines: readonly Machine[],
	query: string,
	filter: (typeof MACHINE_FILTERS)[number],
	now: number,
) {
	const words = query.toLocaleLowerCase().trim().split(/\s+/u).filter(Boolean);
	return machines
		.filter((machine) => {
			if (filter !== "all" && machineStatus(machine, now).group !== filter) return false;
			const text = [machine.id, machine.host, machine.user, ...machine.labels].join(" ").toLocaleLowerCase();
			return words.every((word) => text.includes(word));
		})
		.sort((a, b) => a.id.localeCompare(b.id));
}

export const machineCheckLabels = [
	["reachable", "SSH reached"],
	["clioPresent", "Clio found"],
	["versionMatch", "Version matched"],
	["pathParity", "Project path found"],
	["stateDirWritable", "State writable"],
] as const;
