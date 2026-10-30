import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RefObject } from "react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useSearchParams } from "react-router";
import type { Machine, MachineAdd, MachineMutation } from "../../contracts/machines.js";
import { routes } from "../../contracts/routes.js";
import type { Client } from "../api/client.js";
import { emptyInput } from "../api/client.js";
import { clock } from "../api/clock.js";
import { Icon } from "../design/icons.js";
import { StatusMark } from "../design/status.js";
import { Dialog } from "../interaction/Dialog.js";
import type { MachineDraft, MachineRequest } from "./machines-model.js";
import {
	acceptMachineRequest,
	emptyMachineDraft,
	filterMachines,
	MACHINE_FILTERS,
	machineAge,
	machineCheckLabels,
	machineDraft,
	machineStatus,
	machineSummary,
} from "./machines-model.js";
import { useWorkspaceSelection, WorkspacePicker } from "./settings.js";
import "./machines.css";

type MachinesDraft = {
	draft: MachineDraft;
	adding: boolean;
	request: MachineRequest | null;
	sending: boolean;
	error: string | null;
};
const machineDrafts = new WeakMap<Client, ReturnType<typeof createMachinesDraft>>();
function createMachinesDraft() {
	let value: MachinesDraft = { draft: emptyMachineDraft, adding: false, request: null, sending: false, error: null };
	const listeners = new Set<() => void>();
	return {
		read: () => value,
		subscribe: (listener: () => void) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		update: (change: (current: MachinesDraft) => MachinesDraft) => {
			value = change(value);
			for (const listener of listeners) listener();
		},
	};
}
// Like settings drafts, this safe editor state belongs to the client across route remounts.
// Requests stay in memory, including while an unmounted page awaits its acknowledgement.
function machinesDraft(client: Client) {
	let draft = machineDrafts.get(client);
	if (!draft) {
		draft = createMachinesDraft();
		machineDrafts.set(client, draft);
	}
	return draft;
}

function AddMachine({
	busy,
	draft,
	onDraft,
	onAdd,
	inputRef,
}: {
	busy: boolean;
	draft: MachineDraft;
	onDraft: (draft: MachineDraft) => void;
	onAdd: (machine: MachineAdd) => void;
	inputRef: RefObject<HTMLInputElement | null>;
}) {
	const [error, setError] = useState("");
	const field = (key: keyof MachineDraft, value: string) => {
		setError("");
		onDraft({ ...draft, [key]: value });
	};
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
			<p>Use an existing SSH alias or the address of a lab workstation or server. Registration saves user settings.</p>
			<fieldset disabled={busy} className="machines-fields">
				<label>
					Machine ID
					<input
						ref={inputRef}
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
			</fieldset>
			<details className="machines-advanced">
				<summary>SSH options and worker capacity</summary>
				<fieldset disabled={busy} className="machines-fields">
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
			</details>
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
					<dd>Saved in your Clio settings</dd>
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
				{machine.reason || machine.note ? (
					<details className="machines-diagnostics">
						<summary>Readiness details</summary>
						{machine.reason ? <p className="machines-reason">{machine.reason}</p> : null}
						{machine.note ? <p className="machines-caption">{machine.note}</p> : null}
					</details>
				) : null}
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
			<div className="machines-actions">
				<button type="button" className="machines-primary" disabled={busy} onClick={() => setConfirm("check")}>
					<Icon name="play" /> Check readiness
				</button>
				<button type="button" disabled={busy} onClick={() => setConfirm("remove")}>
					Remove machine
				</button>
			</div>
			{confirm !== null ? (
				<Dialog
					title={confirm === "check" ? "Check this project over SSH?" : `Remove ${machine.id}?`}
					eyebrow="Machine control"
					onClose={() => setConfirm(null)}
				>
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
				</Dialog>
			) : null}
		</article>
	);
}

export function MachinesPage({ client }: { client: Client }) {
	const queries = useQueryClient();
	const selection = useWorkspaceSelection(client);
	const { id } = selection;
	const [now, setNow] = useState(() => clock.now());
	const [search, setSearch] = useSearchParams();
	const selectedId = search.get("machine") ?? "";
	const query = search.get("q") ?? "";
	const filter = MACHINE_FILTERS.find((item) => item === search.get("status")) ?? "all";
	const set = (key: string, value: string) =>
		setSearch(
			(previous) => {
				const next = new URLSearchParams(previous);
				if (value) next.set(key, value);
				else next.delete(key);
				if (key !== "machine") next.delete("machine");
				return next;
			},
			{ replace: true },
		);
	const addField = useRef<HTMLInputElement>(null);
	const recovery = useRef<HTMLDivElement>(null);
	const operationResult = useRef<HTMLDivElement>(null);
	const store = useMemo(() => machinesDraft(client), [client]);
	const saved = useSyncExternalStore(store.subscribe, store.read, store.read);
	const { adding, request } = saved;
	const setAdding = (adding: boolean) => store.update((current) => ({ ...current, adding }));
	const [forgetConfirm, setForgetConfirm] = useState(false);
	const operationScope = request?.operationId
		? { id: request.operationId, workspaceId: request.workspaceId, action: request.body.action }
		: null;
	const meta = useQuery({
		queryKey: ["meta"],
		queryFn: ({ signal }) => client.call(routes.meta, emptyInput, undefined, signal),
		refetchOnMount: "always",
		retry: false,
	});
	const epochChanged = !!request?.epoch && !!meta.data && request.epoch !== meta.data.epoch;
	useEffect(() => {
		const timer = setInterval(() => setNow(clock.now()), 30_000);
		return () => clearInterval(timer);
	}, []);
	const inventory = useQuery({
		queryKey: ["machines", id],
		enabled: !!id,
		queryFn: ({ signal }) => client.call(routes.machines, { ...emptyInput, params: { id } }, undefined, signal),
		staleTime: 30_000,
		retry: false,
		meta: { errorSurface: "inline" },
	});
	const operation = useQuery({
		queryKey: ["operation", operationScope?.id ?? null],
		enabled: operationScope !== null && !epochChanged,
		queryFn: ({ signal }) =>
			client.call(routes.operation, { ...emptyInput, params: { id: operationScope?.id ?? "" } }, undefined, signal),
		refetchInterval: (query) =>
			epochChanged ||
			query.state.data?.status === "succeeded" ||
			query.state.data?.status === "failed" ||
			query.state.data?.status === "cancelled"
				? false
				: 1000,
		retry: false,
	});
	useEffect(() => {
		if (adding) return;
		const target = saved.error
			? recovery
			: operation.data?.status === "failed" || operation.data?.status === "cancelled"
				? operationResult
				: null;
		if (!target) return;
		// The dialog first restores its opener and the shell removes inert. Land on the recovery
		// message after that handoff, so the disabled opener cannot swallow the failure feedback.
		let landing = 0;
		const frame = requestAnimationFrame(() => {
			landing = requestAnimationFrame(() => target.current?.focus());
		});
		return () => {
			cancelAnimationFrame(frame);
			cancelAnimationFrame(landing);
		};
	}, [adding, saved.error, operation.data?.status]);
	const mutation = useMutation({
		meta: { errorSurface: "inline" },
		mutationFn: async (sent: MachineRequest) => {
			try {
				// Read the epoch for every explicit attempt. A restart loses server idempotency records.
				const currentMeta = await client.call(routes.meta, emptyInput);
				queries.setQueryData(["meta"], currentMeta);
				if (sent.epoch !== null && sent.epoch !== currentMeta.epoch)
					throw new Error("Clio restarted. Review the original workspace's records before making a new request.");
				store.update((current) => ({
					...current,
					request: current.request?.key === sent.key ? { ...current.request, epoch: currentMeta.epoch } : current.request,
				}));
				const accepted = await client.call(
					routes.machineMutation,
					{ ...emptyInput, params: { id: sent.workspaceId }, body: sent.body },
					sent.key,
					undefined,
					currentMeta.epoch,
				);
				store.update((current) => ({
					...current,
					request: acceptMachineRequest(current.request, sent.key, accepted.operationId),
				}));
			} catch (error) {
				store.update((current) => ({
					...current,
					adding: current.request?.key === sent.key && sent.body.action === "add" ? false : current.adding,
					error:
						current.request?.key === sent.key ? (error instanceof Error ? error.message : String(error)) : current.error,
				}));
				throw error;
			} finally {
				store.update((current) => ({ ...current, sending: false }));
			}
		},
		retry: false,
	});
	useEffect(() => {
		const status = operation.data?.status;
		if (
			!request ||
			request.settled ||
			epochChanged ||
			operation.data?.id !== request.operationId ||
			(status !== "succeeded" && status !== "failed" && status !== "cancelled")
		)
			return;
		// Registration is user-wide; readiness is scoped to the checked workspace.
		void queries.invalidateQueries({ queryKey: ["machines"] });
		store.update((current) =>
			current.request?.key === request.key
				? {
						...current,
						request: { ...current.request, settled: true },
						adding: request.body.action === "add" ? false : current.adding,
						draft: status === "succeeded" && request.body.action === "add" ? emptyMachineDraft : current.draft,
					}
				: current,
		);
		if (status === "succeeded" && request.body.action !== "check") {
			for (const key of ["workspace-settings", "settings-controls", "config-graph"])
				void queries.invalidateQueries({ queryKey: [key] });
		}
	}, [operation.data, request, epochChanged, queries, store]);
	const busy = saved.sending || (request !== null && !request.settled);
	const machines = inventory.data?.machines ?? [];
	const shown = filterMachines(machines, query, filter, now);
	const selected = shown.find((machine) => machine.id === selectedId) ?? shown[0];
	const summary = machineSummary(machines, now);
	const send = (sent: MachineRequest) => {
		if (store.read().sending || sent.operationId !== null) return;
		store.update((current) => ({ ...current, request: sent, sending: true, error: null }));
		mutation.mutate(sent);
	};
	const act = (body: MachineMutation) => {
		const current = store.read();
		if (!id || current.sending || (current.request && !current.request.settled)) return;
		send({
			workspaceId: id,
			body: structuredClone(body),
			key: crypto.randomUUID(),
			epoch: null,
			operationId: null,
			settled: false,
		});
	};
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
			{inventory.error && (
				<div className="machines-operation" role="alert">
					<p>The saved machine registry could not be read. {inventory.error.message}</p>
					<button type="button" disabled={inventory.isFetching} onClick={() => void inventory.refetch()}>
						Retry registry
					</button>
				</div>
			)}
			{saved.error && (!request || request.settled) && <p role="alert">{saved.error}</p>}
			{request && !request.settled && (
				<div className="machines-operation" role="status" ref={recovery} tabIndex={-1}>
					{saved.error ? <p role="alert">{saved.error}</p> : null}
					<strong>
						Original request: {request.body.action}{" "}
						{request.body.action === "add" ? request.body.machine.id : request.body.id}
					</strong>
					<p>
						Workspace:{" "}
						{selection.workspaces.data?.find((workspace) => workspace.id === request.workspaceId)?.path ??
							request.workspaceId}
					</p>
					{epochChanged ? (
						<p>
							Clio restarted. This request will not be replayed. Its earlier outcome may be unknown; review the original
							workspace's records.
						</p>
					) : request.operationId ? (
						<p>
							Accepted operation: {request.operationId}. Status recovery uses this operation; it does not submit another
							request.
						</p>
					) : (
						<p>
							{saved.sending
								? "Submitting the saved request…"
								: "No acceptance was confirmed. An explicit retry uses the original workspace, body and request key."}
						</p>
					)}
					{!request.operationId && !epochChanged && (
						<button type="button" disabled={saved.sending || meta.isPending || meta.isError} onClick={() => send(request)}>
							Retry original request
						</button>
					)}
					{meta.error && (
						<button type="button" onClick={() => void meta.refetch()}>
							Refresh server status
						</button>
					)}
					{!saved.sending &&
						(saved.error || operation.error || epochChanged) &&
						(forgetConfirm ? (
							<>
								<p>
									Only forget tracking after reviewing the saved machine records. The earlier operation may have run; a new
									request can repeat its effects.
								</p>
								<button
									type="button"
									onClick={() => {
										store.update((current) =>
											current.request?.key === request.key && !current.sending
												? { ...current, request: null, error: null }
												: current,
										);
										setForgetConfirm(false);
									}}
								>
									I reviewed the records; forget tracking
								</button>
								<button type="button" onClick={() => setForgetConfirm(false)}>
									Keep tracking
								</button>
							</>
						) : (
							<button type="button" onClick={() => setForgetConfirm(true)}>
								Review forgetting this request
							</button>
						))}
				</div>
			)}
			{operationScope && (
				<div className="machines-operation" role="status" ref={operationResult} tabIndex={-1}>
					{request?.settled ? (
						<button
							type="button"
							className="machines-operation__dismiss"
							aria-label="Dismiss completed machine operation"
							onClick={() =>
								store.update((current) =>
									current.request?.settled && current.request.key === request.key
										? { ...current, request: null, error: null }
										: current,
								)
							}
						>
							<Icon name="close" />
						</button>
					) : null}
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
							<button type="button" disabled={epochChanged} onClick={() => void operation.refetch()}>
								Retry status
							</button>
						</p>
					)}
				</div>
			)}
			{adding && (
				<Dialog
					title="Add an SSH machine"
					eyebrow="Connect your research infrastructure"
					size="wide"
					className="machines-add-dialog"
					initialFocus={addField}
					onClose={() => setAdding(false)}
				>
					<AddMachine
						busy={busy}
						draft={saved.draft}
						onDraft={(draft) => store.update((current) => ({ ...current, draft }))}
						onAdd={(machine) => act({ action: "add", machine })}
						inputRef={addField}
					/>
				</Dialog>
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
						<section className="machines-summary" aria-label="Recorded fleet readiness">
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
						</section>
						<div className="machines-section-heading machines-registry-heading">
							<h2>SSH registry</h2>
							<button type="button" disabled={inventory.isFetching} onClick={() => void inventory.refetch()}>
								{inventory.isFetching ? "Refreshing…" : "Refresh records"}
							</button>
						</div>
						{machines.length > 0 ? (
							<div className="machines-toolbar">
								<label className="machines-search">
									<Icon name="search" />
									<span className="sr-only">Search machines</span>
									<input
										type="search"
										value={query}
										maxLength={256}
										onChange={(event) => set("q", event.target.value)}
										placeholder="Search machine, host or label…"
									/>
								</label>
								<label>
									<span className="sr-only">Filter machine readiness</span>
									<select
										value={filter}
										onChange={(event) => set("status", event.target.value === "all" ? "" : event.target.value)}
									>
										<option value="all">All machines</option>
										<option value="ready">Project ready</option>
										<option value="attention">Needs attention</option>
										<option value="unchecked">Not checked</option>
									</select>
								</label>
							</div>
						) : null}
						{machines.length === 0 ? (
							<div className="machines-empty">
								<Icon name="system" />
								<h2>Connect the lab to your workflow.</h2>
								<p>Register a workstation or server, then explicitly check that it can run Clio for this project.</p>
								<button type="button" disabled={busy} onClick={() => setAdding(true)}>
									Add your first machine
								</button>
							</div>
						) : shown.length === 0 ? (
							<div className="machines-empty">
								<Icon name="search" />
								<h2>No machines match this view</h2>
								<p>Try another name, host, label or readiness filter.</p>
								<button
									type="button"
									onClick={() =>
										setSearch(
											(previous) => {
												const next = new URLSearchParams(previous);
												for (const key of ["q", "status", "machine"]) next.delete(key);
												return next;
											},
											{ replace: true },
										)
									}
								>
									Clear filters
								</button>
							</div>
						) : (
							<div className="machines-workbench">
								<nav className="machines-list" aria-label="Registered machines">
									{shown.map((machine) => {
										const status = machineStatus(machine, now);
										return (
											<button
												type="button"
												className="machines-row"
												key={machine.id}
												aria-current={selected?.id === machine.id ? "true" : undefined}
												onClick={() => set("machine", machine.id)}
											>
												<span className="machines-row-title">
													<Icon name="system" />
													<strong>{machine.id}</strong>
													<span>
														{machine.maxWorkers} {machine.maxWorkers === 1 ? "worker" : "workers"}
													</span>
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
