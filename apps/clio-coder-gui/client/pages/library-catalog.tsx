import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { routes } from "../../contracts/routes.js";
import { ApiProblem, type Client } from "../api/client.js";
import { reportProblem } from "../design/notifications.js";
import { StatusMark } from "../design/status.js";
import { Dialog } from "../interaction/Dialog.js";
import {
	type Applied,
	copyOperations,
	copyState,
	diskSentence,
	effectSentence,
	matchesPackage,
	missingScopes,
	needsRequirements,
	type Operation,
	originSentence,
	outcomeHeadline,
	PACKAGE_KINDS,
	type Package,
	type Plan,
	componentSentence,
	type Scope,
	scopeCopy,
	stepTitle,
	verb,
} from "./library-plan.js";
import "./library.css";

type Request = { operation: Operation; ref: string; scope: Scope; withRequirements?: boolean };

function Failure({ error }: { error: Error }) {
	return (
		<div className="problem" role="alert">
			<strong>{error.message}</strong>
			{error instanceof ApiProblem && (
				<small>
					{error.problem.code} · {error.problem.instance}
				</small>
			)}
		</div>
	);
}

function PlanReview({ plan }: { plan: Plan }) {
	return (
		<ol className="library-steps">
			{plan.steps.map((step) => (
				<li key={`${step.identity.scope}:${step.identity.ref}`}>
					<h3>{stepTitle(step)}</h3>
					{step.refusal && (
						<p className="library-refusal" role="alert">
							Clio refuses this step: {step.refusal}
						</p>
					)}
					<p>{effectSentence(step)}</p>
					<dl className="library-facts">
						<div>
							<dt>Writes to</dt>
							<dd>
								<code>{step.destination}</code>
							</dd>
						</div>
						{step.source && (
							<div>
								<dt>Source</dt>
								<dd>
									<code>{step.source.sourceUrl}</code>
									{step.source.sha256 && (
										<small>
											{step.source.staged ? "Staged and verified" : "Not fetched"} · sha256 {step.source.sha256.slice(0, 16)}…
										</small>
									)}
								</dd>
							</div>
						)}
						{step.content && (
							<div>
								<dt>Contains</dt>
								<dd>
									{step.content.resources.length
										? step.content.resources
												.map((item) => `${item.kind} ${item.name}${item.valid ? "" : " (invalid)"}`)
												.join(", ")
										: "No components"}
									{!step.content.valid && <small>The package did not validate.</small>}
								</dd>
							</div>
						)}
						{!!step.dependencies.requires.length && (
							<div>
								<dt>Requires</dt>
								<dd>
									{step.dependencies.requires.join(", ")}
									{!!step.dependencies.missing.length && <small>Not installed: {step.dependencies.missing.join(", ")}</small>}
									{!!step.dependencies.inactive.length && (
										<small>Installed but inactive: {step.dependencies.inactive.join(", ")}</small>
									)}
								</dd>
							</div>
						)}
						{!!step.dependents.preexisting.length && (
							<div>
								<dt>Already affected</dt>
								<dd>
									{step.dependents.preexisting
										.map((item) => `${item.ref} (${item.scope}): ${item.missing.join(", ")}`)
										.join("; ")}
								</dd>
							</div>
						)}
						{!!step.dependents.newlyBroken.length && (
							<div>
								<dt>Would break</dt>
								<dd>
									{step.dependents.newlyBroken
										.map((item) => `${item.ref} (${item.scope}): ${item.missing.join(", ")}`)
										.join("; ")}
								</dd>
							</div>
						)}
						<div>
							<dt>Recovery</dt>
							<dd>{step.recovery}</dd>
						</div>
					</dl>
					{!!step.content?.diagnostics.length && (
						<details>
							<summary>{step.content.diagnostics.length} validation notes</summary>
							<ul>
								{step.content.diagnostics.map((note) => (
									<li key={note}>{note}</li>
								))}
							</ul>
						</details>
					)}
				</li>
			))}
		</ol>
	);
}

function Outcomes({ applied }: { applied: Applied }) {
	return (
		<>
			<ol className="library-steps">
				{applied.outcomes.map((outcome) => {
					const headline = outcomeHeadline(outcome);
					return (
						<li key={`${outcome.identity.scope}:${outcome.identity.ref}`}>
							<StatusMark tone={headline.tone} label={outcome.status} />
							<h3>{headline.text}</h3>
							{outcome.error && (
								<p className="library-refusal" role="alert">
									{outcome.error.message} {outcome.error.next}
								</p>
							)}
							{outcome.status === "committed" && (
								<dl className="library-facts">
									<div>
										<dt>On disk</dt>
										<dd>{diskSentence(outcome)}</dd>
									</div>
									<div>
										<dt>Components</dt>
										<dd>{componentSentence(outcome)}</dd>
									</div>
									{outcome.recovery?.packageBackup && (
										<div>
											<dt>Backup kept</dt>
											<dd>
												<code>{outcome.recovery.packageBackup}</code>
											</dd>
										</div>
									)}
								</dl>
							)}
						</li>
					);
				})}
			</ol>
			{applied.committed > 0 && <RefreshNote refresh={applied.refresh} />}
		</>
	);
}

/** Whether the project's open conversations picked the change up, said as it happened. */
function RefreshNote({ refresh }: { refresh: Applied["refresh"] }) {
	if (refresh.status === "refreshed")
		return (
			<p className="library-session-note library-session-note--settled" role="status">
				<strong>
					{refresh.sessions === 1 ? "The open conversation reloaded" : `All ${refresh.sessions} open conversations reloaded`}{" "}
					its library.
				</strong>{" "}
				Its next request uses the change.
			</p>
		);
	if (refresh.status === "failed")
		return (
			<p className="library-session-note" role="alert">
				<strong>
					{refresh.failedSessions} of {refresh.sessions} open {refresh.sessions === 1 ? "conversation" : "conversations"} did
					not reload.
				</strong>{" "}
				{refresh.error}. The change is installed; run <code>/library reload</code> there, or start a new conversation, to
				use it.
			</p>
		);
	return (
		<p className="library-session-note library-session-note--settled">
			<strong>No open conversation needed a reload.</strong> {refresh.reason}
		</p>
	);
}

function PlanDialog({
	client,
	workspaceId,
	request,
	onClose,
}: {
	client: Client;
	workspaceId: string;
	request: Request;
	onClose: () => void;
}) {
	const queries = useQueryClient();
	const cancel = useRef<HTMLButtonElement>(null);
	const [plan, setPlan] = useState<Plan | null>(null);
	const started = useRef(false),
		mounted = useRef(true),
		heldPlan = useRef<Plan | null>(null),
		writing = useRef(false);
	const release = useCallback(
		(planId: string) =>
			client.call(routes.libraryPlanRelease, { params: { id: workspaceId, planId }, query: {}, body: {} }),
		[client, workspaceId],
	);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			// A browser navigation can remove the dialog even while its source is staging.
			// Defer one microtask so StrictMode's temporary cleanup can remount first.
			queueMicrotask(() => {
				if (!mounted.current && heldPlan.current && !writing.current)
					void release(heldPlan.current.id).catch(reportProblem);
			});
		};
	}, [release]);
	const planning = useMutation({
		mutationFn: (input: Request) =>
			client.call(routes.libraryPlan, { params: { id: workspaceId }, query: {}, body: input }),
		onSuccess: (value) => {
			heldPlan.current = value;
			if (mounted.current) setPlan(value);
			else void release(value.id).catch(reportProblem);
		},
	});
	const applying = useMutation({
		mutationFn: async (planId: string) => {
			writing.current = true;
			try {
				const result = await client.call(routes.libraryPlanApply, {
					params: { id: workspaceId, planId },
					query: {},
					body: {},
				});
				heldPlan.current = null;
				return result;
			} finally {
				writing.current = false;
			}
		},
		onSettled: () => {
			for (const key of ["library", "library-agents", "library-extensions"])
				void queries.invalidateQueries({ queryKey: [key] });
		},
	});
	const plan0 = planning.mutate;
	useEffect(() => {
		// The ref survives StrictMode's double effect, so one dialog stages exactly one plan.
		if (started.current) return;
		started.current = true;
		plan0(request);
	}, [plan0, request]);
	const releasing = useMutation({
		mutationFn: async (planId: string) => {
			const result = await release(planId);
			heldPlan.current = null;
			return result;
		},
	});
	const busy = planning.isPending || applying.isPending || releasing.isPending;
	useEffect(() => {
		const button = cancel.current;
		const dialog = button?.closest<HTMLElement>(".dialog");
		if (!button || !dialog) return;
		// Staging disables Cancel after it received initial focus. Keep keyboard focus in the review.
		if (!dialog.contains(document.activeElement)) {
			if (busy) dialog.focus();
			else button.focus();
		} else if (!busy && document.activeElement === dialog) button.focus();
	}, [busy]);
	const close = () => {
		// Keep the review open until staging or writes settle, and report failed release so it can be retried.
		if (busy) return;
		if (plan && !applying.data) releasing.mutate(plan.id, { onSuccess: onClose });
		else onClose();
	};
	const title = `${verb(request.operation)} ${request.ref}`;
	return (
		<Dialog
			title={title}
			eyebrow={applying.data ? "Library · what happened" : "Library · review before applying"}
			size="wide"
			onClose={close}
			initialFocus={cancel}
		>
			{planning.isPending && (
				<p role="status">Staging the source and checking what would change. Nothing is written yet.</p>
			)}
			{planning.error && <Failure error={planning.error} />}
			{plan && !applying.data && (
				<>
					<div className="library-plan-summary">
						<StatusMark
							tone={plan.applicable ? "neutral" : "fail"}
							label={plan.applicable ? "Ready for review" : "Plan refused"}
						/>
						<span>
							{plan.steps.length} {plan.steps.length === 1 ? "step" : "steps"} · expires{" "}
							{new Date(plan.expiresAt).toLocaleTimeString()}
						</span>
					</div>
					<p>
						{plan.applicable
							? "This is exactly what will be applied. Nothing has been written yet."
							: "Clio will not apply this plan. Nothing has been written."}
					</p>
					<PlanReview plan={plan} />
					{!!plan.diagnostics.length && (
						<details>
							<summary>{plan.diagnostics.length} planning notes</summary>
							<ul>
								{plan.diagnostics.map((note) => (
									<li key={note}>{note}</li>
								))}
							</ul>
						</details>
					)}
				</>
			)}
			{applying.isPending && <p role="status">Applying the reviewed plan. Keep this review open for the result.</p>}
			{releasing.isPending && <p role="status">Releasing staged sources…</p>}
			{releasing.error && <Failure error={releasing.error} />}
			{applying.error && <Failure error={applying.error} />}
			{applying.data && <Outcomes applied={applying.data} />}
			<div className="actions">
				{plan && !applying.data && plan.applicable && (
					<button type="button" className="primary" disabled={busy} onClick={() => applying.mutate(plan.id)}>
						{applying.isPending
							? "Applying…"
							: `Apply ${plan.steps.length === 1 ? "this change" : `${plan.steps.length} changes`}`}
					</button>
				)}
				{plan && !applying.data && needsRequirements(plan) && (
					<button
						type="button"
						className="primary"
						disabled={busy}
						onClick={() =>
							releasing.mutate(plan.id, {
								onSuccess: () => {
									setPlan(null);
									planning.mutate({ ...request, withRequirements: true });
								},
							})
						}
					>
						Plan again with its requirements
					</button>
				)}
				<button type="button" ref={cancel} disabled={busy} onClick={close}>
					{applying.data ? "Done" : "Cancel"}
				</button>
			</div>
		</Dialog>
	);
}

export function LibraryCatalog({
	client,
	workspaceId,
	packages,
	filter,
	compact = false,
	onReview,
}: {
	client: Client;
	workspaceId: string;
	packages: Package[];
	filter: string;
	compact?: boolean;
	onReview?: (() => void) | undefined;
}) {
	const [search, setSearch] = useSearchParams();
	const [localDiscovery, setLocalDiscovery] = useState<Record<string, string>>({});
	const valueFor = (key: string) => (compact ? localDiscovery[key] : search.get(key));
	const kind = PACKAGE_KINDS.find((candidate) => candidate === valueFor("kind")) ?? "all";
	const installedOnly = valueFor("installed") === "true",
		selected = valueFor("package");
	const discover = (key: string, value: string | null) => {
		if (compact) {
			setLocalDiscovery((current) => {
				const next = { ...current };
				if (value) next[key] = value;
				else delete next[key];
				return next;
			});
			return;
		}
		setSearch((current) => {
			const next = new URLSearchParams(current);
			if (value) next.set(key, value);
			else next.delete(key);
			return next;
		});
	};
	const [limit, setLimit] = useState(40),
		[request, setRequest] = useState<Request | null>(null);
	const review = (input: Request) => {
		// Release a native navigation dialog's top layer before the review claims focus.
		onReview?.();
		setRequest(input);
	};
	const visible = packages.filter(
		(pkg) =>
			(kind === "all" || pkg.kind === kind) && (!installedOnly || pkg.copies.length > 0) && matchesPackage(pkg, filter),
	);
	const installed = packages.filter((pkg) => pkg.copies.length > 0).length;
	const displayed = visible.slice(0, limit),
		selectedPackage = visible.find((pkg) => pkg.ref === selected);
	if (selectedPackage && !displayed.includes(selectedPackage)) displayed.unshift(selectedPackage);
	return (
		<>
			<fieldset className="library-facets">
				<legend>Show</legend>
				{(["all", ...PACKAGE_KINDS] as const)
					.filter((name) => name === "all" || packages.some((pkg) => pkg.kind === name))
					.map((name) => (
						<button
							type="button"
							key={name}
							aria-pressed={kind === name}
							onClick={() => {
								discover("kind", name === "all" ? null : name);
								setLimit(40);
							}}
						>
							{name === "all" ? "All kinds" : `${name[0]?.toUpperCase()}${name.slice(1)} packages`} ·{" "}
							{name === "all" ? packages.length : packages.filter((pkg) => pkg.kind === name).length}
						</button>
					))}
				<button
					type="button"
					aria-pressed={installedOnly}
					onClick={() => {
						discover("installed", installedOnly ? null : "true");
						setLimit(40);
					}}
				>
					Installed only · {installed}
				</button>
			</fieldset>
			{!visible.length && (
				<p>{packages.length ? "No packages match." : "No catalog is configured and nothing is installed."}</p>
			)}
			<p className="library-result-count" role="status">
				{visible.length} of {packages.length} packages · {installed} installed
			</p>
			{selected && !visible.some((pkg) => pkg.ref === selected) && (
				<p className="panel-note">
					The selected package is outside these filters or is no longer available.{" "}
					<button type="button" onClick={() => discover("package", null)}>
						Clear selection
					</button>
				</p>
			)}
			<ul className="library-packages">
				{displayed.map((pkg) => (
					<li key={pkg.ref} aria-label={pkg.ref} data-selected={selected === pkg.ref}>
						<div className="library-package__identity">
							<h3>
								{pkg.name}
								{pkg.version && <span className="version">{pkg.version}</span>}
							</h3>
							<p>{pkg.description || "No description."}</p>
							<small>
								{pkg.kind} · {originSentence(pkg)}
								{pkg.requires?.length ? ` · requires ${pkg.requires.join(", ")}` : ""}
							</small>
							{pkg.refusal && <p className="library-refusal">{pkg.refusal}</p>}
							<button
								type="button"
								className="library-inspect"
								aria-expanded={selected === pkg.ref}
								onClick={() => discover("package", selected === pkg.ref ? null : pkg.ref)}
							>
								{compact ? `Inspect ${pkg.name}` : "Inspect package"}
							</button>
						</div>
						{(!compact || selected === pkg.ref) && (
							<div className="library-package__copies">
								{!pkg.copies.length && <StatusMark tone="neutral" label="Not installed" />}
								{pkg.copies.map((copy) => {
									const state = copyState(String(copy.state));
									const scope = copy.scope as Scope;
									return (
										<div className="library-copy" key={scope}>
											<span>
												{scopeCopy(scope)} <StatusMark tone={state.tone} label={state.label} />
											</span>
											<span className="library-copy__actions">
												{copyOperations(String(copy.state)).map((operation) => (
													<button
														type="button"
														key={operation}
														aria-label={`${verb(operation)} the ${scope} copy of ${pkg.ref}`}
														onClick={() => review({ operation, ref: pkg.ref, scope })}
													>
														{verb(operation)}
													</button>
												))}
											</span>
										</div>
									);
								})}
								{pkg.catalogOrigin !== "installed" && (
									<span className="library-copy__actions">
										{missingScopes(pkg).map((scope) => (
											<button
												type="button"
												key={scope}
												className={pkg.copies.length ? undefined : scope === "user" ? "primary" : undefined}
												aria-label={`Install ${pkg.ref} ${scope === "user" ? "for me" : "in this project"}`}
												onClick={() => review({ operation: "install", ref: pkg.ref, scope })}
											>
												{scope === "user" ? "Install for me" : "Install in this project"}
											</button>
										))}
									</span>
								)}
							</div>
						)}
						{selected === pkg.ref && (
							<div className="library-package__detail">
								<h4>Package source & requirements</h4>
								<dl className="library-facts">
									<div>
										<dt>Reference</dt>
										<dd>
											<code>{pkg.ref}</code>
										</dd>
									</div>
									<div>
										<dt>Source</dt>
										<dd>
											<code>{pkg.sourceUrl}</code>
										</dd>
									</div>
									<div>
										<dt>Origin</dt>
										<dd>{originSentence(pkg)}</dd>
									</div>
									<div>
										<dt>Requires</dt>
										<dd>{pkg.requires?.length ? pkg.requires.join(", ") : "No declared requirements"}</dd>
									</div>
									<div>
										<dt>Provides</dt>
										<dd>
											{pkg.provides?.length
												? pkg.provides.map((item) => `${String(item.kind)} ${String(item.name)}`).join(", ")
												: "No components declared in the catalog"}
										</dd>
									</div>
									{pkg.sha256 && (
										<div>
											<dt>Fingerprint</dt>
											<dd>
												<code>{pkg.sha256}</code>
											</dd>
										</div>
									)}
								</dl>
								<p className="panel-note">
									Choose a destination to review the exact files, dependencies and effects before applying a change.
								</p>
							</div>
						)}
					</li>
				))}
			</ul>
			{visible.length > limit && (
				<button type="button" onClick={() => setLimit(limit + 40)}>
					Show more packages
				</button>
			)}
			{request && (
				<PlanDialog
					key={`${request.operation}:${request.scope}:${request.ref}`}
					client={client}
					workspaceId={workspaceId}
					request={request}
					onClose={() => setRequest(null)}
				/>
			)}
		</>
	);
}
