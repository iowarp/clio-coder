// "Restore workspace files" and the transcript downloads. Both open from the URL (`?rewind=1`,
// `?download=html|markdown`), so the task menu, the command palette and the `/rewind` alias share one path.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useLocation, useSearchParams } from "react-router";
import type { SnapshotOutcome, SnapshotPlan, TranscriptFormat } from "../../contracts/rewind.js";
import { routes } from "../../contracts/runtime-routes.js";
import type { SessionSnapshot } from "../../contracts/sessions.js";
import type { Client } from "../api/client.js";
import { formatClock } from "../api/clock.js";
import { notify } from "../design/notifications.js";
import { Dialog } from "../interaction/Dialog.js";
import { pendingPermission } from "./Approval.js";
import {
	planChangesNothing,
	planCounts,
	pressRestore,
	REWIND_MATCHES,
	REWIND_NOTES,
	type RestoreStep,
	restoreBlocked,
	restoreButton,
	rewindEmpty,
	rewindUnavailable,
	snapshotDiffers,
	snapshotTurn,
	snapshotWhy,
	undoPoint,
} from "./rewind-model.js";
import "./rewind.css";

const EXPORT_FAILED = "The transcript could not be exported.";

async function saveTranscript(client: Client, id: string, format: TranscriptFormat) {
	try {
		const file = await client.call(routes.sessionTranscript, { params: { id }, query: { format }, body: {} });
		const url = URL.createObjectURL(new Blob([file.text], { type: file.mediaType }));
		const link = document.createElement("a");
		link.href = url;
		link.download = file.filename;
		link.hidden = true;
		document.body.append(link);
		link.click();
		link.remove();
		// The click hands the URL to the download on this tick; revoking it sooner can cancel the save.
		setTimeout(() => URL.revokeObjectURL(url), 0);
	} catch (error) {
		notify({ tone: "error", title: EXPORT_FAILED, detail: error instanceof Error ? error.message : String(error) });
	}
}

/** Mounted once per task page. Opens the dialog for `?rewind=1` and runs a download for `?download=`. */
export function RewindHost({
	client,
	snapshot,
	onTurn,
}: {
	client: Client;
	snapshot: SessionSnapshot;
	onTurn: (turnId: string) => void;
}) {
	const [params, setParams] = useSearchParams();
	const location = useLocation();
	const handled = useRef<string | null>(null);
	const download = params.get("download");
	const open = snapshot.state === "open";
	const { id } = snapshot;

	const drop = (key: string) =>
		setParams(
			(current) => {
				const next = new URLSearchParams(current);
				next.delete(key);
				return next;
			},
			{ replace: true },
		);

	useEffect(() => {
		// Keyed by navigation so a strict-mode effect replay does not save the file twice.
		if (download === null || handled.current === location.key) return;
		handled.current = location.key;
		setParams(
			(current) => {
				const next = new URLSearchParams(current);
				next.delete("download");
				return next;
			},
			{ replace: true },
		);
		if (download !== "html" && download !== "markdown") return;
		if (!open) {
			notify({ tone: "warning", title: EXPORT_FAILED, detail: rewindUnavailable(snapshot.state, undefined) ?? "" });
			return;
		}
		void saveTranscript(client, id, download);
	}, [client, download, id, location.key, open, setParams, snapshot.state]);

	if (params.get("rewind") !== "1") return null;
	return (
		<RewindDialog
			client={client}
			snapshot={snapshot}
			onClose={() => drop("rewind")}
			onTurn={(turnId) => {
				drop("rewind");
				onTurn(turnId);
				// The transcript may need a frame to mount the revealed turn before it can be scrolled to.
				requestAnimationFrame(() =>
					requestAnimationFrame(() => {
						const target = [...document.querySelectorAll<HTMLElement>("[data-turn-id]")].find(
							(element) => element.dataset.turnId === turnId,
						);
						target?.scrollIntoView({ block: "start" });
						target?.focus({ preventScroll: true });
					}),
				);
			}}
		/>
	);
}

function RewindDialog({
	client,
	snapshot,
	onClose,
	onTurn,
}: {
	client: Client;
	snapshot: SessionSnapshot;
	onClose: () => void;
	onTurn: (turnId: string) => void;
}) {
	const { id } = snapshot;
	const open = snapshot.state === "open";
	const queries = useQueryClient();
	const [chosen, setChosen] = useState<number | null>(null);
	const [step, setStep] = useState<RestoreStep>("idle");
	const [outcome, setOutcome] = useState<SnapshotOutcome | null>(null);
	const capabilities = useQuery({
		meta: { errorSurface: "inline" },
		queryKey: ["session-capabilities", id],
		queryFn: () => client.call(routes.sessionCapabilities, { params: { id }, query: {}, body: {} }),
		enabled: open,
		staleTime: Number.POSITIVE_INFINITY,
		retry: false,
	});
	const offered = capabilities.data ? capabilities.data.snapshots !== undefined : undefined;
	const unavailable = rewindUnavailable(snapshot.state, offered);
	const usable = unavailable === null && offered === true;
	const list = useQuery({
		meta: { errorSurface: "inline" },
		queryKey: ["session-snapshots", id],
		queryFn: () => client.call(routes.sessionSnapshots, { params: { id }, query: {}, body: {} }),
		enabled: usable,
		staleTime: 0,
		retry: false,
	});
	const preview = useQuery({
		meta: { errorSurface: "inline" },
		queryKey: ["session-snapshot", id, chosen],
		queryFn: () => client.call(routes.sessionSnapshotPreview, { params: { id, n: String(chosen) }, query: {}, body: {} }),
		enabled: usable && chosen !== null,
		staleTime: 0,
		retry: false,
	});
	const restore = useMutation({
		meta: { errorSurface: "inline" },
		mutationFn: (n: number) =>
			client.call(
				routes.sessionSnapshotRestore,
				{ params: { id, n: String(n) }, query: {}, body: {} },
				crypto.randomUUID(),
			),
		onSuccess: async (result) => {
			setOutcome(result);
			await Promise.all([
				queries.invalidateQueries({ queryKey: ["session-snapshots", id] }),
				queries.invalidateQueries({ queryKey: ["session-snapshot", id] }),
				queries.invalidateQueries({ queryKey: ["session", id] }),
				queries.invalidateQueries({ queryKey: ["workspace-files", snapshot.workspaceId] }),
				queries.invalidateQueries({ queryKey: ["workspace-file", snapshot.workspaceId] }),
			]);
		},
	});

	const running = snapshot.turns.at(-1)?.status === "running";
	const blocked = restoreBlocked({ running, approvalPending: pendingPermission(snapshot) !== undefined });
	const rows = list.data?.snapshots ?? [];
	const plan = preview.data?.kind === "plan" ? preview.data : null;
	const nothing = plan !== null && planChangesNothing(plan);
	const choose = (n: number) => {
		setChosen(n);
		setStep("idle");
		setOutcome(null);
		restore.reset();
	};

	return (
		<Dialog title="Restore workspace files" eyebrow="CLIO CODER" size="wide" onClose={onClose}>
			<div className="rewind">
				{unavailable !== null ? (
					<p className="panel-note">{unavailable}</p>
				) : capabilities.error ? (
					<p className="pane-inspection-error" role="alert">
						{capabilities.error.message}
					</p>
				) : list.error ? (
					<p className="pane-inspection-error" role="alert">
						{list.error.message}
					</p>
				) : list.data === undefined ? (
					<p className="panel-note" role="status">
						Reading snapshots…
					</p>
				) : rewindEmpty(rows) !== null ? (
					<p className="panel-note">{rewindEmpty(rows)}</p>
				) : (
					<div className="rewind__layout">
						<ul className="rewind__list" aria-label="Snapshots, newest first">
							{rows.map((row) => {
								const turn = snapshotTurn(snapshot.turns, row.turnId);
								const differs = snapshotDiffers(row.differs);
								return (
									<li key={row.n} className="rewind__row" data-chosen={row.n === chosen || undefined}>
										<button type="button" aria-pressed={row.n === chosen} onClick={() => choose(row.n)}>
											<span className="rewind__when">
												#{row.n} · {formatClock(row.at)}
											</span>
											<span>{snapshotWhy(row)}</span>
											{differs !== null ? <span className="rewind__quiet">{differs}</span> : null}
										</button>
										{turn !== null ? (
											<button type="button" className="rewind__turn" onClick={() => onTurn(turn.turnId)}>
												{turn.label}
											</button>
										) : null}
									</li>
								);
							})}
							{list.data.truncated ? <li className="rewind__quiet">Older snapshots are not listed.</li> : null}
						</ul>
						<section className="rewind__preview" aria-live="polite">
							{blocked !== null ? <p className="panel-note">{blocked}</p> : null}
							{chosen === null ? (
								<p className="rewind__quiet">Choose a snapshot to see what restoring it would change.</p>
							) : preview.error ? (
								<p className="pane-inspection-error" role="alert">
									{preview.error.message}
								</p>
							) : preview.data === undefined ? (
								<p className="rewind__quiet" role="status">
									Reading snapshot #{chosen}…
								</p>
							) : preview.data.kind === "unavailable" ? (
								<p className="pane-inspection-error" role="alert">
									{preview.data.reason}
								</p>
							) : outcome !== null ? (
								<RewindOutcome outcome={outcome} />
							) : (
								<>
									{nothing ? <p>{REWIND_MATCHES}</p> : <PlanLists plan={preview.data} />}
									<ul className="rewind__notes">
										{REWIND_NOTES.map((note) => (
											<li key={note}>{note}</li>
										))}
									</ul>
									{restore.error ? (
										<p className="pane-inspection-error" role="alert">
											{restore.error.message}
										</p>
									) : null}
									<div className="actions">
										<button
											type="button"
											className="primary"
											disabled={blocked !== null || nothing || restore.isPending}
											onClick={() => {
												const press = pressRestore(step, blocked !== null);
												setStep(press.next);
												if (press.run && plan !== null) restore.mutate(plan.n);
											}}
										>
											{restore.isPending ? "Restoring…" : restoreButton(step)}
										</button>
										{step === "armed" ? (
											<button type="button" onClick={() => setStep("idle")}>
												Cancel
											</button>
										) : null}
									</div>
								</>
							)}
						</section>
					</div>
				)}
			</div>
		</Dialog>
	);
}

function PathList({ title, paths }: { title: string; paths: readonly string[] }) {
	if (paths.length === 0) return null;
	return (
		<details className="rewind__paths" open={paths.length <= 12}>
			<summary>{title}</summary>
			<ul>
				{paths.map((path) => (
					<li key={path}>
						<code>{path}</code>
					</li>
				))}
			</ul>
		</details>
	);
}

function KeptList({ title, rows }: { title: string; rows: readonly { path: string; why: string }[] }) {
	if (rows.length === 0) return null;
	return (
		<details className="rewind__paths" open={rows.length <= 12}>
			<summary>{title}</summary>
			<ul>
				{rows.map((row) => (
					<li key={row.path}>
						<code>{row.path}</code> <span className="rewind__quiet">{row.why}</span>
					</li>
				))}
			</ul>
		</details>
	);
}

type Refs = Extract<SnapshotOutcome, { kind: "restored" }>["refs"];
function RefList({ refs }: { refs: Refs }) {
	if (refs.length === 0) return null;
	return (
		<details className="rewind__paths" open>
			<summary>Git refs to fix by hand ({refs.length})</summary>
			<ul>
				{refs.map((ref) => (
					<li key={`${ref.kind}:${ref.label}`}>
						{ref.label} <span className="rewind__quiet">{ref.state}</span>
						{ref.recover !== null ? (
							<>
								{" "}
								<code>{ref.recover}</code>
							</>
						) : null}
					</li>
				))}
			</ul>
		</details>
	);
}

function PlanLists({ plan }: { plan: Extract<SnapshotPlan, { kind: "plan" }> }) {
	const counts = planCounts(plan);
	return (
		<>
			<PathList title={counts.restore} paths={plan.restore} />
			<PathList title={counts.remove} paths={plan.remove} />
			<KeptList title={counts.kept} rows={plan.kept} />
			<RefList refs={plan.refs} />
			{plan.truncated ? <p className="rewind__quiet">Each list shows its first 500 paths.</p> : null}
		</>
	);
}

function RewindOutcome({ outcome }: { outcome: SnapshotOutcome }) {
	if (outcome.kind === "unavailable")
		return (
			<p className="pane-inspection-error" role="alert">
				{outcome.reason}
			</p>
		);
	if (outcome.kind === "failed")
		return (
			<div role="alert">
				<p className="pane-inspection-error">{outcome.reason}</p>
				<p>{undoPoint(outcome.undo)}</p>
			</div>
		);
	return (
		<div role="status">
			<p>Restored snapshot #{outcome.n}.</p>
			<PathList title={`Restored (${outcome.restored.length})`} paths={outcome.restored} />
			<PathList title={`Removed (${outcome.removed.length})`} paths={outcome.removed} />
			<KeptList title={`Kept (${outcome.kept.length})`} rows={outcome.kept} />
			<KeptList title={`Failed (${outcome.failed.length})`} rows={outcome.failed} />
			<RefList refs={outcome.refs} />
			{outcome.truncated ? <p className="rewind__quiet">Each list shows its first 500 paths.</p> : null}
			<p>{undoPoint(outcome.undo)}</p>
		</div>
	);
}
