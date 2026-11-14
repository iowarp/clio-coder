import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import type { TrustPreviewFile, TrustSurface } from "../../contracts/review.js";
import { routes } from "../../contracts/runtime-routes.js";
import type { Client } from "../api/client.js";
import { ApiProblem, emptyInput } from "../api/client.js";
import { Dialog } from "../interaction/Dialog.js";
import {
	afterTrust,
	ignoredSurfaces,
	printable,
	reviewTitle,
	sizeNote,
	TRUST_CHANGED,
	TRUST_LOADING,
	TRUST_RESTARTING,
	trustAvailability,
	verdictWords,
	workspaceLabel,
} from "./trust-model.js";
import "./artifacts.css";

function PreviewFile({ file }: { file: TrustPreviewFile }) {
	const note = sizeNote(file);
	return (
		<li className="trust-review__file">
			<p className="trust-review__path">{file.path}</p>
			{file.text !== null ? (
				<pre className="trust-review__text">{printable(file.text)}</pre>
			) : (
				<p className="trust-review__unreadable">{file.error ?? "This file could not be read."}</p>
			)}
			{note ? <p className="trust-review__note">{note}</p> : null}
		</li>
	);
}

/**
 * The review a terminal does with `clio-coder config trust <surface>`: every file the surface would apply,
 * in full, and the one decision to trust exactly those bytes. Opened from a task, trusting asks that
 * task's engine to re-read trust; opened from Settings, it applies to the tasks started after it.
 */
export function TrustReview({
	client,
	workspaceId,
	surface,
	sessionId,
	running = false,
	onClose,
	onTrusted,
}: {
	client: Client;
	workspaceId: string;
	surface: TrustSurface;
	/** The task the review was opened from; its engine is restarted to apply the trust. */
	sessionId?: string;
	/** A turn is running in that task. */
	running?: boolean;
	onClose: () => void;
	onTrusted?: () => void;
}) {
	const queries = useQueryClient();
	const trustButton = useRef<HTMLButtonElement>(null);
	const [note, setNote] = useState<{ tone: "status" | "error"; text: string } | null>(null);
	const [trusted, setTrusted] = useState(false);
	const input = { params: { id: workspaceId, surface }, query: {}, body: {} };
	const preview = useQuery({
		queryKey: ["trust-preview", workspaceId, surface],
		queryFn: () => client.call(routes.trustPreview, input),
		staleTime: 0,
		gcTime: 0,
		retry: false,
		meta: { errorSurface: "inline" },
	});
	const workspaces = useQuery({
		queryKey: ["workspaces"],
		queryFn: () => client.call(routes.workspaces, emptyInput),
		meta: { errorSurface: "inline" },
	});
	const approve = useMutation({
		mutationFn: async (hash: string) => {
			await client.call(routes.trustApprove, { ...input, body: { hash } }, crypto.randomUUID());
			if (sessionId === undefined) return afterTrust(false, false);
			setNote({ tone: "status", text: TRUST_RESTARTING });
			const task = { params: { id: sessionId }, query: {}, body: {} };
			// The view route re-reads trust in a resting task and restarts its engine when the report changed.
			await client.call(routes.viewSession, task, crypto.randomUUID());
			const snapshot = await client.call(routes.session, task);
			queries.setQueryData(["session", sessionId], snapshot);
			return afterTrust(
				true,
				ignoredSurfaces(snapshot.telemetry?.trust).some((group) => group.surface === surface),
			);
		},
		meta: { errorSurface: "inline" },
		onMutate: () => setNote(null),
		onSuccess: (outcome) => {
			setTrusted(true);
			onTrusted?.();
			if (sessionId !== undefined) void queries.invalidateQueries({ queryKey: ["session", sessionId] });
			if (outcome.close) onClose();
			else setNote({ tone: "status", text: outcome.message });
		},
		onError: (error) => {
			if (
				error instanceof ApiProblem &&
				error.problem.code === "conflict" &&
				error.problem.detail.startsWith("The files")
			) {
				setNote({ tone: "error", text: TRUST_CHANGED });
				void preview.refetch();
				return;
			}
			setNote({ tone: "error", text: error.message });
		},
	});
	const data = preview.data;
	const name =
		workspaces.data?.find((workspace) => workspace.id === workspaceId)?.name ??
		(data ? workspaceLabel(data.workspaceRoot) : "this project");
	const availability = trustAvailability(data, running);
	return (
		<Dialog
			title={reviewTitle(surface, name)}
			eyebrow="Project trust"
			size="wide"
			className="trust-review"
			onClose={onClose}
			initialFocus={trustButton}
		>
			{preview.isPending ? <p role="status">{TRUST_LOADING}</p> : null}
			{preview.error ? (
				<div role="alert" className="trust-review__error">
					<p>{preview.error.message}</p>
					<button type="button" onClick={() => void preview.refetch()}>
						Try again
					</button>
				</div>
			) : null}
			{data ? (
				<>
					<p className="trust-review__verdict">{verdictWords(data.verdict)}</p>
					<ul className="trust-review__files">
						{data.files.map((file) => (
							<PreviewFile key={file.path} file={file} />
						))}
					</ul>
					{data.scripts?.length ? (
						<section aria-label="Scripts the hooks run">
							<h3 className="trust-review__heading">Scripts the hooks run</h3>
							<ul className="trust-review__files">
								{data.scripts.map((file) => (
									<PreviewFile key={file.path} file={file} />
								))}
							</ul>
						</section>
					) : null}
					{data.packages?.length ? (
						<section aria-label="Packages">
							<h3 className="trust-review__heading">Packages</h3>
							<ul className="trust-review__packages">
								{data.packages.map((pkg) => (
									<li key={pkg.id}>
										<span className="trust-review__path">{pkg.id}</span>
										<span>{[pkg.source, pkg.kind].filter(Boolean).join(" · ")}</span>
									</li>
								))}
							</ul>
						</section>
					) : null}
					<details className="trust-review__technical">
						<summary>Technical details</summary>
						<p>
							Content hash <code>{data.contentHash ?? "none"}</code>
						</p>
					</details>
				</>
			) : null}
			{note ? (
				<p role={note.tone === "error" ? "alert" : "status"} className={`trust-review__outcome is-${note.tone}`}>
					{note.text}
				</p>
			) : null}
			{!trusted && availability.note ? <p className="trust-review__note">{availability.note}</p> : null}
			<div className="trust-review__actions">
				{trusted ? (
					<button type="button" className="primary" onClick={onClose}>
						Close
					</button>
				) : (
					<>
						<button
							ref={trustButton}
							type="button"
							className="primary"
							disabled={!availability.enabled || approve.isPending || preview.isFetching}
							onClick={() => {
								if (data?.contentHash) approve.mutate(data.contentHash);
							}}
						>
							Trust {surface}
						</button>
						<button type="button" onClick={onClose}>
							Not now
						</button>
					</>
				)}
			</div>
		</Dialog>
	);
}
