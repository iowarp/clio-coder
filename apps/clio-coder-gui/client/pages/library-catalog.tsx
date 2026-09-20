import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { routes } from "../../contracts/routes.js";
import { ApiProblem, type Client } from "../api/client.js";
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
	recipeSentence,
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
										: "No recipes"}
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
						{!!step.dependents.newlyBroken.length && (
							<div>
								<dt>Would break</dt>
								<dd>{step.dependents.newlyBroken.map((item) => `${item.ref} (${item.scope})`).join(", ")}</dd>
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
										<dt>Recipes</dt>
										<dd>{recipeSentence(outcome)}</dd>
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
			{applied.committed > 0 && (
				<p className="library-session-note">
					<strong>Open conversations have not reloaded.</strong> {applied.refresh.reason} Run <code>/library reload</code> in
					a conversation, or start a new one, to use the change.
				</p>
			)}
		</>
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
	const started = useRef(false);
	const planning = useMutation({
		mutationFn: (input: Request) =>
			client.call(routes.libraryPlan, { params: { id: workspaceId }, query: {}, body: input }),
		onSuccess: setPlan,
	});
	const applying = useMutation({
		mutationFn: (planId: string) =>
			client.call(routes.libraryPlanApply, { params: { id: workspaceId, planId }, query: {}, body: {} }),
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
	const close = () => {
		// A plan that was reviewed and abandoned still holds staged sources on the server.
		if (plan && !applying.data && !applying.isPending)
			void client
				.call(routes.libraryPlanRelease, { params: { id: workspaceId, planId: plan.id }, query: {}, body: {} })
				.catch(() => undefined);
		onClose();
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
			{applying.error && <Failure error={applying.error} />}
			{applying.data && <Outcomes applied={applying.data} />}
			<div className="actions">
				{plan && !applying.data && plan.applicable && (
					<button type="button" className="primary" disabled={applying.isPending} onClick={() => applying.mutate(plan.id)}>
						{applying.isPending
							? "Applying…"
							: `Apply ${plan.steps.length === 1 ? "this change" : `${plan.steps.length} changes`}`}
					</button>
				)}
				{plan && !applying.data && needsRequirements(plan) && (
					<button
						type="button"
						className="primary"
						disabled={planning.isPending}
						onClick={() => {
							void client
								.call(routes.libraryPlanRelease, { params: { id: workspaceId, planId: plan.id }, query: {}, body: {} })
								.catch(() => undefined);
							setPlan(null);
							planning.mutate({ ...request, withRequirements: true });
						}}
					>
						Plan again with its requirements
					</button>
				)}
				<button type="button" ref={cancel} onClick={close}>
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
}: {
	client: Client;
	workspaceId: string;
	packages: Package[];
	filter: string;
}) {
	const [kind, setKind] = useState<(typeof PACKAGE_KINDS)[number] | "all">("all"),
		[installedOnly, setInstalledOnly] = useState(false),
		[limit, setLimit] = useState(40),
		[request, setRequest] = useState<Request | null>(null);
	const visible = packages.filter(
		(pkg) =>
			(kind === "all" || pkg.kind === kind) && (!installedOnly || pkg.copies.length > 0) && matchesPackage(pkg, filter),
	);
	const installed = packages.filter((pkg) => pkg.copies.length > 0).length;
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
								setKind(name);
								setLimit(40);
							}}
						>
							{name === "all" ? "All kinds" : `${name[0]?.toUpperCase()}${name.slice(1)} packages`} ·{" "}
							{name === "all" ? packages.length : packages.filter((pkg) => pkg.kind === name).length}
						</button>
					))}
				<button type="button" aria-pressed={installedOnly} onClick={() => setInstalledOnly(!installedOnly)}>
					Installed only · {installed}
				</button>
			</fieldset>
			{!visible.length && (
				<p>{packages.length ? "No packages match." : "No catalog is configured and nothing is installed."}</p>
			)}
			<ul className="library-packages">
				{visible.slice(0, limit).map((pkg) => (
					<li key={pkg.ref} aria-label={pkg.ref}>
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
						</div>
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
													onClick={() => setRequest({ operation, ref: pkg.ref, scope })}
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
											onClick={() => setRequest({ operation: "install", ref: pkg.ref, scope })}
										>
											{scope === "user" ? "Install for me" : "Install in this project"}
										</button>
									))}
								</span>
							)}
						</div>
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
