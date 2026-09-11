import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router";
import type { PermissionDecision } from "../../contracts/permissions.js";
import { routes } from "../../contracts/routes.js";
import type { SessionSnapshot } from "../../contracts/sessions.js";
import type { SafeSettingsPatch } from "../../contracts/settings-safe.js";
import type { Client } from "../api/client.js";
import { formatTime } from "../api/clock.js";

export function PermissionCards({ client, session }: { client: Client; session: SessionSnapshot }) {
	const answer = useMutation({
		mutationFn: ({ id, decision }: { id: string; decision: PermissionDecision }) =>
			client.call(routes.permission, { params: { id: session.id, permissionId: id }, query: {}, body: { decision } }),
	});
	return (
		<div className="permission-cards">
			{session.permissions
				.filter((permission) => permission.status === "pending" || permission.status === "escalated")
				.map((permission) => (
					<article key={permission.id} className="permission-card" aria-label="Permission request">
						<p className="eyebrow">{permission.status === "escalated" ? "Approval still waiting" : "Approval needed"}</p>
						<h2>{permission.title}</h2>
						<p>Review the tool input and locations in the conversation before allowing this action.</p>
						<p>If unanswered, this turn stops at {formatTime(permission.expiresAt)}.</p>
						<div className="control-actions">
							<button
								className="primary"
								type="button"
								disabled={answer.isPending}
								onClick={() => answer.mutate({ id: permission.id, decision: "allow-once" })}
							>
								Allow once
							</button>
							<button
								type="button"
								disabled={answer.isPending}
								onClick={() => answer.mutate({ id: permission.id, decision: "reject" })}
							>
								Reject
							</button>
						</div>
					</article>
				))}
			{answer.error ? <p role="alert">{answer.error.message}</p> : null}
		</div>
	);
}
export function CancelTurn({ client, session }: { client: Client; session: SessionSnapshot }) {
	const turn = session.turns.at(-1);
	const cancel = useMutation({
		mutationFn: () =>
			client.call(routes.cancelTurn, { params: { id: session.id, turnId: turn?.id ?? "" }, query: {}, body: {} }),
	});
	return turn?.status === "running" ? (
		<div className="control-actions">
			<button type="button" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
				{cancel.isPending ? "Cancelling…" : "Cancel turn"}
			</button>
			{cancel.error ? <p role="alert">{cancel.error.message}</p> : null}
		</div>
	) : null;
}
export function DeleteSession({ client, id, workspaceId }: { client: Client; id: string; workspaceId: string }) {
	const queries = useQueryClient(),
		navigate = useNavigate();
	const remove = useMutation({
		mutationFn: () => client.call(routes.deleteSession, { params: { id }, query: {}, body: { workspaceId } }),
		onSuccess: () => {
			queries.removeQueries({ queryKey: ["session", id] });
			void queries.invalidateQueries({ queryKey: ["session-history", workspaceId] });
			void queries.invalidateQueries({ queryKey: ["sessions"] });
			void navigate(`/workspaces/${workspaceId}/sessions`);
		},
	});
	return (
		<div>
			<button
				type="button"
				disabled={remove.isPending}
				onClick={() => {
					if (window.confirm("Delete this closed session and its saved conversation? This cannot be undone."))
						remove.mutate();
				}}
			>
				Delete session
			</button>
			{remove.error ? <p role="alert">{remove.error.message}</p> : null}
		</div>
	);
}
function SettingsPanel({ client, session }: { client: Client; session: SessionSnapshot }) {
	const input = { params: { id: session.id }, query: {}, body: {} },
		queries = useQueryClient();
	const settings = useQuery({
		queryKey: ["session-settings", session.id],
		queryFn: () => client.call(routes.sessionSettings, input),
	});
	const targets = useQuery({
		queryKey: ["session-targets", session.id],
		queryFn: () => client.call(routes.sessionTargets, input),
	});
	const autonomy = useQuery({
		queryKey: ["session-autonomy", session.id],
		queryFn: () => client.call(routes.sessionAutonomy, input),
	});
	const save = useMutation({
		mutationFn: (patch: SafeSettingsPatch) => client.call(routes.patchSessionSettings, { ...input, body: patch }),
		onSuccess: (value) => queries.setQueryData(["session-settings", session.id], value),
	});
	const setAutonomy = useMutation({
		mutationFn: (level: "read-only" | "suggest" | "auto-edit" | "full-auto") =>
			client.call(routes.setSessionAutonomy, { ...input, body: { level } }),
		onSuccess: (value) => queries.setQueryData(["session-autonomy", session.id], value),
	});
	const probe = useMutation({
		mutationFn: (targetId: string) =>
			client.call(routes.probeSessionTarget, { params: { id: session.id, targetId }, query: {}, body: {} }),
	});
	const busy = session.turns.at(-1)?.status === "running";
	return (
		<div className="session-settings">
			<p>These four settings are saved by Clio. Changes are available between turns.</p>
			{settings.data ? (
				<form
					key={JSON.stringify(settings.data)}
					onSubmit={(event) => {
						event.preventDefault();
						const values = new FormData(event.currentTarget);
						save.mutate({
							"chat.target": String(values.get("target") ?? "") || null,
							"chat.model": String(values.get("model") ?? "") || null,
							"chat.thinkingLevel": values.get("thinking") as NonNullable<SafeSettingsPatch["chat.thinkingLevel"]>,
							"safety.autonomy": values.get("autonomy") as NonNullable<SafeSettingsPatch["safety.autonomy"]>,
						});
					}}
				>
					<fieldset disabled={busy || save.isPending}>
						<legend>Safe settings</legend>
						<label>
							Target
							<select name="target" defaultValue={settings.data.settings.chat.target ?? ""}>
								<option value="">No target</option>
								{targets.data?.targets.map((target) => (
									<option key={target.id} value={target.id}>
										{target.id}
									</option>
								))}
							</select>
						</label>
						<label>
							Model
							<input name="model" defaultValue={settings.data.settings.chat.model ?? ""} maxLength={256} />
						</label>
						<label>
							Thinking
							<select name="thinking" defaultValue={settings.data.settings.chat.thinkingLevel}>
								{["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((value) => (
									<option key={value}>{value}</option>
								))}
							</select>
						</label>
						<label>
							Default autonomy
							<select name="autonomy" defaultValue={settings.data.settings.safety.autonomy}>
								{["read-only", "suggest", "auto-edit", "full-auto"].map((value) => (
									<option key={value}>{value}</option>
								))}
							</select>
						</label>
						<button type="submit">Save settings</button>
					</fieldset>
				</form>
			) : (
				<p>Reading settings…</p>
			)}
			{autonomy.data ? (
				<label>
					Autonomy for this session
					<select
						value={autonomy.data.level}
						disabled={busy || setAutonomy.isPending}
						onChange={(event) =>
							setAutonomy.mutate(event.target.value as "read-only" | "suggest" | "auto-edit" | "full-auto")
						}
					>
						{["read-only", "suggest", "auto-edit", "full-auto"].map((value) => (
							<option key={value}>{value}</option>
						))}
					</select>
					<small>Source: {autonomy.data.source}</small>
				</label>
			) : null}
			<h3>Configured targets</h3>
			{targets.data?.truncated ? <p className="trace-warning">Clio truncated this target list.</p> : null}
			{targets.data?.targets.map((target) => (
				<div className="target-card" key={target.id}>
					<div>
						<strong>{target.id}</strong>
						<p>
							{target.runtime} · {target.isOrchestrator ? "Can orchestrate" : "Worker target"}
						</p>
						<p>{target.models.join(", ") || "No models reported"}</p>
					</div>
					<button type="button" disabled={probe.isPending} onClick={() => probe.mutate(target.id)}>
						Probe {target.id}
					</button>
				</div>
			))}
			{probe.data ? (
				<p role="status">
					{probe.data.targetId}: {probe.data.healthy ? "Healthy" : probe.data.reason}
					{probe.data.latencyMs === null ? "" : ` · ${probe.data.latencyMs} ms`}
				</p>
			) : null}
			{[
				...new Set(
					[settings.error, targets.error, autonomy.error, save.error, setAutonomy.error, probe.error].flatMap((error) =>
						error ? [error.message] : [],
					),
				),
			].map((message) => (
				<p role="alert" key={message}>
					{message}
				</p>
			))}
		</div>
	);
}
export function SessionControls({ client, session }: { client: Client; session: SessionSnapshot }) {
	const [expanded, setExpanded] = useState(false),
		[label, setLabel] = useState(session.label ?? "");
	const queries = useQueryClient();
	const rename = useMutation({
		mutationFn: () =>
			client.call(routes.labelSession, {
				params: { id: session.id },
				query: {},
				body: { label, workspaceId: session.workspaceId },
			}),
		onSuccess: () => {
			void queries.invalidateQueries({ queryKey: ["session", session.id] });
			void queries.invalidateQueries({ queryKey: ["session-history", session.workspaceId] });
		},
	});
	return (
		<details className="session-controls" onToggle={(event) => setExpanded(event.currentTarget.open)}>
			<summary>Session controls</summary>
			<form
				className="control-actions"
				onSubmit={(event) => {
					event.preventDefault();
					rename.mutate();
				}}
			>
				<label>
					Session label
					<input value={label} onChange={(event) => setLabel(event.target.value)} maxLength={256} />
				</label>
				<button type="submit" disabled={rename.isPending}>
					Save label
				</button>
			</form>
			{rename.error ? <p role="alert">{rename.error.message}</p> : null}
			{session.state === "open" && expanded ? <SettingsPanel client={client} session={session} /> : null}
			{session.state === "closed" ? (
				<DeleteSession client={client} id={session.id} workspaceId={session.workspaceId} />
			) : null}
		</details>
	);
}
export function FleetStrip({ session }: { session: SessionSnapshot }) {
	return session.fleet.length ? (
		<details className="fleet-strip" open>
			<summary>Fleet activity · {session.fleet.length} recent facts</summary>
			<ol>
				{session.fleet.map((item) => (
					<li key={item.id}>
						<strong>{item.fact.type.replace("fleet.", "").replace("evidence.ready", "Evidence ready")}</strong>
						<span>{formatTime(item.at)}</span>
						<pre className="trace-json">{JSON.stringify(item.fact.payload, null, 2)}</pre>
					</li>
				))}
			</ol>
		</details>
	) : null;
}
