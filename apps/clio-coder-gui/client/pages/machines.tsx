import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { Machine, MachineAdd, MachineMutation } from "../../contracts/machines.js";
import { routes } from "../../contracts/routes.js";
import type { Client } from "../api/client.js";
import { emptyInput } from "../api/client.js";
import { Icon } from "../design/icons.js";
import { StatusMark } from "../design/status.js";
import type { MachineDraft } from "./machines-model.js";
import {
	emptyMachineDraft,
	machineAge,
	machineCheckLabels,
	machineDraft,
	machineStatus,
	machineSummary,
} from "./machines-model.js";
import { useWorkspaceSelection, WorkspacePicker } from "./settings.js";
import "./machines.css";

function AddMachine({
	busy,
	onAdd,
	onClose,
}: {
	busy: boolean;
	onAdd: (machine: MachineAdd) => void;
	onClose: () => void;
}) {
	const [draft, setDraft] = useState<MachineDraft>(emptyMachineDraft);
	const [error, setError] = useState("");
	const field = (key: keyof MachineDraft, value: string) => setDraft((current) => ({ ...current, [key]: value }));
	return (
		<form
			className="machines-add"
			onSubmit={(event) => {
				event.preventDefault();
				const result = machineDraft(draft);
				if (result.error !== undefined) {
					setError(result.error);
					return;
				}
				setError("");
				onAdd(result.machine);
			}}
		>
			<div className="machines-section-heading">
				<div>
					<span className="machines-kicker">Register an SSH destination</span>
					<h2>Add machine</h2>
				</div>
				<button type="button" onClick={onClose} disabled={busy} aria-label="Close add machine">
					<Icon name="close" />
				</button>
			</div>
			<p>Use an existing SSH alias or the address of a lab workstation or server. Registration saves user settings.</p>
			<fieldset disabled={busy} className="machines-fields">
				<label>
					Machine ID
					<input
						required
						maxLength={64}
						value={draft.id}
						onChange={(e) => field("id", e.target.value)}
						placeholder="lab-workstation"
						autoComplete="off"
					/>
				</label>
				<label>
					SSH host or alias
					<input
						required
						maxLength={253}
						value={draft.host}
						onChange={(e) => field("host", e.target.value)}
						placeholder="workstation.example.edu"
						autoComplete="off"
					/>
				</label>
				<label>
					SSH user <span>optional</span>
					<input
						maxLength={64}
						value={draft.user}
						onChange={(e) => field("user", e.target.value)}
						placeholder="From SSH configuration"
						autoComplete="off"
					/>
				</label>
				<label>
					SSH port <span>optional</span>
					<input
						type="number"
						min={1}
						max={65535}
						value={draft.port}
						onChange={(e) => field("port", e.target.value)}
						placeholder="From SSH configuration"
					/>
				</label>
				<label>
					Maximum workers
					<input
						required
						type="number"
						min={1}
						max={1024}
						value={draft.maxWorkers}
						onChange={(e) => field("maxWorkers", e.target.value)}
					/>
				</label>
				<label>
					Labels <span>optional, comma separated</span>
					<input
						value={draft.labels}
						onChange={(e) => field("labels", e.target.value)}
						placeholder="gpu, high-memory"
						maxLength={2048}
					/>
				</label>
			</fieldset>
			<p className="machines-caption">
				SSH uses the configuration and available keys on the machine running Clio. Labels are your declarations, not
				measured hardware. Adding a machine does not connect to it.
			</p>
			{error && <p role="alert">{error}</p>}
			<button type="submit" className="machines-primary" disabled={busy}>
				<Icon name="plus" /> Register machine
			</button>
		</form>
	);
}

function MachineDetail({
	machine,
	now,
	projectRoot,
	busy,
	onAction,
}: {
	machine: Machine;
	now: number;
	projectRoot: string;
	busy: boolean;
	onAction: (mutation: MachineMutation) => void;
}) {
	const [confirm, setConfirm] = useState<"check" | "remove" | null>(null);
	const status = machineStatus(machine, now);
	return (
		<article className="machines-detail" aria-label={`Machine ${machine.id}`}>
			<div className="machines-section-heading">
				<div>
					<span className="machines-kicker">Registered destination</span>
					<h2>{machine.id}</h2>
				</div>
				<Icon name="system" />
			</div>
			<p className="machines-address">
				{machine.user ? `${machine.user}@` : ""}
				{machine.host}
				{machine.port !== null ? ` · port ${machine.port}` : ""}
			</p>
			<StatusMark tone={status.tone} label={status.label} />
			<dl className="machines-facts">
				<div>
					<dt>Registration</dt>
					<dd>Registered · no enable/disable setting in core</dd>
				</div>
				<div>
					<dt>Worker capacity</dt>
					<dd>{machine.maxWorkers} concurrent</dd>
				</div>
				<div>
					<dt>Labels</dt>
					<dd>{machine.labels.join(" · ") || "None declared"}</dd>
				</div>
				<div>
					<dt>Last check</dt>
					<dd>
						{machineAge(machine, now)}
						{machine.checkedAt && <time dateTime={machine.checkedAt}>{machine.checkedAt}</time>}
					</dd>
				</div>
			</dl>
			<div className="machines-evidence">
				<span className="machines-kicker">Recorded project evidence</span>
				<p className="machines-path">{projectRoot}</p>
				<div className="machines-checks">
					{machineCheckLabels.map(([key, label]) => (
						<div key={key} data-confirmed={machine.checks?.[key] === true}>
							<Icon name={machine.checks?.[key] ? "success" : "unverified"} />
							<span>
								{label}
								<small>{machine.checks?.[key] ? "Confirmed" : machine.checks ? "Not confirmed" : "Not checked"}</small>
							</span>
						</div>
					))}
				</div>
				<p className="machines-caption">
					These are saved observations, not a live connection. Checks expire after one day; changes to the connection or Clio
					build can invalidate them sooner.
				</p>
				{machine.reason && <p className="machines-reason">{machine.reason}</p>}
				{machine.note && <p className="machines-caption">{machine.note}</p>}
				{machine.checks && (
					<dl className="machines-facts">
						<div>
							<dt>Clio version</dt>
							<dd>
								Local {machine.localVersion ?? "unknown"} / remote {machine.remoteVersion ?? "unknown"}
							</dd>
						</div>
						<div>
							<dt>Project verification</dt>
							<dd>
								{machine.project?.kind ?? "Not recorded"}
								{machine.project?.head && <code>{machine.project.head}</code>}
							</dd>
						</div>
					</dl>
				)}
				{machine.project?.reason && <p className="machines-caption">{machine.project.reason}</p>}
			</div>
			{confirm === null ? (
				<div className="machines-actions">
					<button type="button" className="machines-primary" disabled={busy} onClick={() => setConfirm("check")}>
						<Icon name="play" /> Check readiness
					</button>
					<button type="button" disabled={busy} onClick={() => setConfirm("remove")}>
						Remove machine
					</button>
				</div>
			) : (
				<section
					className="machines-confirm"
					aria-label={confirm === "check" ? "Confirm readiness check" : "Confirm removal"}
				>
					<h3>{confirm === "check" ? "Check this project over SSH?" : `Remove ${machine.id}?`}</h3>
					{confirm === "check" ? (
						<>
							<p>
								Clio will contact <strong>{machine.host}</strong>, inspect its worker and model endpoints, and verify this
								project at the same absolute path. Recording the check updates local fleet eligibility and may create a
								temporary shared-storage marker in this workspace.
							</p>
							<p>
								Core may send currently authorized credentials for model targets pinned to this node over SSH. This check uses
								existing SSH access and does not install software.
							</p>
						</>
					) : (
						<p>
							This removes the user registry entry. Remote files remain in place. Clio refuses removal while the node is a
							standing default or is pinned by a fleet profile.
						</p>
					)}
					<div className="machines-actions">
						<button
							type="button"
							className="machines-primary"
							disabled={busy}
							onClick={() => {
								onAction({ action: confirm, id: machine.id, confirmed: true });
								setConfirm(null);
							}}
						>
							{confirm === "check" ? "Run and record check" : "Confirm removal"}
						</button>
						<button type="button" disabled={busy} onClick={() => setConfirm(null)}>
							Cancel
						</button>
					</div>
				</section>
			)}
		</article>
	);
}

export function MachinesPage({ client }: { client: Client }) {
	const queries = useQueryClient();
	const selection = useWorkspaceSelection(client);
	const { id } = selection;
	const [now, setNow] = useState(Date.now);
	const [selectedId, setSelectedId] = useState("");
	const [adding, setAdding] = useState(false);
	const [operationScope, setOperationScope] = useState<{ id: string; workspaceId: string; action: string } | null>(null);
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 30_000);
		return () => clearInterval(timer);
	}, []);
	const inventory = useQuery({
		queryKey: ["machines", id],
		enabled: !!id,
		queryFn: ({ signal }) => client.call(routes.machines, { ...emptyInput, params: { id } }, undefined, signal),
		staleTime: 30_000,
		retry: false,
	});
	const operation = useQuery({
		queryKey: ["operation", operationScope?.id ?? null],
		enabled: operationScope !== null,
		queryFn: ({ signal }) =>
			client.call(routes.operation, { ...emptyInput, params: { id: operationScope?.id ?? "" } }, undefined, signal),
		refetchInterval: (query) =>
			query.state.data?.status === "succeeded" ||
			query.state.data?.status === "failed" ||
			query.state.data?.status === "cancelled"
				? false
				: 1000,
		retry: false,
	});
	const mutation = useMutation({
		mutationFn: ({ workspaceId, body }: { workspaceId: string; body: MachineMutation }) =>
			client.call(routes.machineMutation, { ...emptyInput, params: { id: workspaceId }, body }),
		onSuccess: (value, variables) => {
			setOperationScope({ id: value.operationId, workspaceId: variables.workspaceId, action: variables.body.action });
		},
	});
	useEffect(() => {
		const status = operation.data?.status;
		if (!operationScope || (status !== "succeeded" && status !== "failed" && status !== "cancelled")) return;
		// Registration is user-wide; readiness is scoped to the checked workspace.
		void queries.invalidateQueries({ queryKey: ["machines"] });
		if (status === "succeeded" && operationScope.action === "add") setAdding(false);
		if (status === "succeeded" && operationScope.action !== "check") {
			for (const key of ["workspace-settings", "settings-controls", "config-graph"])
				void queries.invalidateQueries({ queryKey: [key] });
		}
	}, [operation.data?.status, operationScope, queries]);
	const busy =
		mutation.isPending ||
		(operationScope !== null &&
			(!operation.data || operation.data.status === "queued" || operation.data.status === "running"));
	const machines = inventory.data?.machines ?? [];
	const selected = machines.find((machine) => machine.id === selectedId) ?? machines[0];
	const summary = machineSummary(machines, now);
	const act = (body: MachineMutation) => mutation.mutate({ workspaceId: id, body });
	return (
		<section className="machines-page">
			<header className="machines-heading">
				<div>
					<span className="machines-kicker">Research infrastructure / SSH fleet</span>
					<h1>Machines</h1>
					<p>Your lab, ready for the work.</p>
				</div>
				<button
					type="button"
					className="machines-primary"
					disabled={!id || busy}
					aria-expanded={adding}
					onClick={() => setAdding(!adding)}
				>
					<Icon name="plus" /> Add machine
				</button>
			</header>
			<div className="machines-scope">
				<WorkspacePicker selection={selection} />
				<p>Registration is shared across projects. Readiness belongs to the selected workspace.</p>
			</div>
			{inventory.error && <p role="alert">{inventory.error.message}</p>}
			{mutation.error && <p role="alert">{mutation.error.message}</p>}
			{operationScope && (
				<div className="machines-operation" role="status">
					<strong>
						Machine {operationScope.action} · {operation.data?.status ?? "awaiting status"}
					</strong>
					{operationScope.workspaceId !== id && <p>This operation belongs to the workspace selected when it was started.</p>}
					{operation.data?.status === "succeeded" && <p>{operation.data.result.message}</p>}
					{operation.data?.status === "failed" && (
						<p>
							{operation.data.problem.detail} Refresh the registry before retrying; a timed-out operation may have changed
							state.
						</p>
					)}
					{operation.data?.status === "running" && (
						<p>{operation.data.progress.at(-1)?.message ?? "Waiting for the serial operation lane…"}</p>
					)}
					{operation.error && (
						<p>
							Operation status is unavailable: {operation.error.message}{" "}
							<button type="button" onClick={() => void operation.refetch()}>
								Retry status
							</button>
						</p>
					)}
				</div>
			)}
			{adding && (
				<AddMachine busy={busy} onAdd={(machine) => act({ action: "add", machine })} onClose={() => setAdding(false)} />
			)}
			{!id ? (
				<div className="machines-empty">
					<Icon name="folder" />
					<h2>Select a workspace</h2>
					<p>Open a workspace to inspect the SSH registry and its project readiness.</p>
				</div>
			) : inventory.isPending ? (
				<p role="status">Reading the saved machine registry…</p>
			) : (
				inventory.data && (
					<>
						<div className="machines-summary" aria-label="Recorded fleet readiness">
							<div>
								<strong>{machines.length}</strong>
								<span>Registered</span>
							</div>
							<div data-tone="ready">
								<strong>{summary.ready}</strong>
								<span>Project ready</span>
							</div>
							<div data-tone="attention">
								<strong>{summary.attention}</strong>
								<span>Needs attention</span>
							</div>
							<div>
								<strong>{summary.unchecked}</strong>
								<span>Not checked</span>
							</div>
							<p>
								Saved evidence
								<br />
								<span>No automatic SSH checks</span>
							</p>
						</div>
						<div className="machines-section-heading machines-registry-heading">
							<h2>SSH registry</h2>
							<button type="button" disabled={inventory.isFetching} onClick={() => void inventory.refetch()}>
								{inventory.isFetching ? "Refreshing…" : "Refresh records"}
							</button>
						</div>
						{machines.length === 0 ? (
							<div className="machines-empty">
								<Icon name="system" />
								<h2>Connect the lab to your workflow.</h2>
								<p>Register a workstation or server, then explicitly check that it can run Clio for this project.</p>
								<button type="button" disabled={busy} onClick={() => setAdding(true)}>
									Add your first machine
								</button>
							</div>
						) : (
							<div className="machines-workbench">
								<nav className="machines-list" aria-label="Registered machines">
									{machines.map((machine) => {
										const status = machineStatus(machine, now);
										return (
											<button
												type="button"
												className="machines-row"
												key={machine.id}
												aria-current={selected?.id === machine.id ? "true" : undefined}
												onClick={() => setSelectedId(machine.id)}
											>
												<span className="machines-row-title">
													<Icon name="system" />
													<strong>{machine.id}</strong>
													<span>{machine.maxWorkers} workers</span>
												</span>
												<span className="machines-row-host">{machine.host}</span>
												<StatusMark tone={status.tone} label={status.label} />
												<span className="machines-row-age">{machineAge(machine, now)}</span>
											</button>
										);
									})}
								</nav>
								{selected && (
									<MachineDetail
										key={`${id}:${selected.id}`}
										machine={selected}
										now={now}
										projectRoot={inventory.data.projectRoot}
										busy={busy}
										onAction={act}
									/>
								)}
							</div>
						)}
					</>
				)
			)}
		</section>
	);
}
