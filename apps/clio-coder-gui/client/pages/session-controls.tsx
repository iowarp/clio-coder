import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";

// Session controls keep the label form and the safe-settings panel.
//
// The approval cards, the turn cancellation and the fleet dump that used to live here have moved:
// approvals to `client/chat/Approval.tsx`, which anchors the decision to the call it gates and owns
// the announcement and the keyboard; Stop to the composer, which is where the operator's hands are;
// and the fleet feed to `client/chat/FleetStrip.tsx`, which folds the append-only event list into
// one row per run instead of printing every event as JSON.

import type { AgentCapabilities } from "../../contracts/capabilities.js";
import { routes } from "../../contracts/routes.js";
import type { SessionSnapshot } from "../../contracts/sessions.js";
import type { SafeSettings, SafeSettingsPatch } from "../../contracts/settings-safe.js";
import type { Client } from "../api/client.js";
import { formatTime } from "../api/clock.js";
import { discardDraftStore } from "../chat/composer.js";
import { ACP_TARGET_MODEL_LIMIT, catalogMayBeCut, modelAfterTargetChange } from "./model-options.js";
import { ModelSelect } from "./model-select.js";

type SettingsDraft = {
	target: string;
	model: string;
	thinking: NonNullable<SafeSettingsPatch["chat.thinkingLevel"]>;
	autonomy: NonNullable<SafeSettingsPatch["safety.autonomy"]>;
};
const settingsDraft = (report: SafeSettings): SettingsDraft => ({
	target: report.settings.chat.target ?? "",
	model: report.settings.chat.model ?? "",
	thinking: report.settings.chat.thinkingLevel,
	autonomy: report.settings.safety.autonomy,
});

/**
 * Deleting a closed session removes its saved conversation for good, so it takes two presses: the
 * first asks in place, and focus lands on Keep so a repeated press cannot confirm by accident.
 */
export function DeleteSession({
	client,
	id,
	workspaceId,
	name = "this session",
}: {
	client: Client;
	id: string;
	workspaceId: string;
	/** What the accessible names call the session, for a list where every row has a Delete. */
	name?: string;
}) {
	const queries = useQueryClient(),
		navigate = useNavigate();
	const [confirming, setConfirming] = useState(false);
	const remove = useMutation({
		mutationFn: () => client.call(routes.deleteSession, { params: { id }, query: {}, body: { workspaceId } }),
		onSuccess: () => {
			discardDraftStore(id);
			queries.removeQueries({ queryKey: ["session", id] });
			void queries.invalidateQueries({ queryKey: ["session-history", workspaceId] });
			void queries.invalidateQueries({ queryKey: ["sessions"] });
			void navigate(`/workspaces/${workspaceId}/sessions`);
		},
		onError: () => setConfirming(false),
	});
	return (
		<div className="delete-session">
			{confirming ? (
				<>
					<span className="delete-session__ask">Delete its saved conversation for good?</span>
					<span className="delete-session__choices">
						<button
							type="button"
							className="delete-session__confirm"
							disabled={remove.isPending}
							onClick={() => remove.mutate()}
							aria-label={`Delete ${name} for good`}
						>
							{remove.isPending ? "Deleting…" : "Delete"}
						</button>
						<button
							type="button"
							onClick={() => setConfirming(false)}
							// biome-ignore lint/a11y/noAutofocus: the operator just pressed Delete; the safe answer takes focus.
							autoFocus
						>
							Keep
						</button>
					</span>
				</>
			) : (
				<button
					type="button"
					className="delete-session__start"
					onClick={() => setConfirming(true)}
					aria-label={`Delete ${name}`}
				>
					Delete
				</button>
			)}
			{remove.error ? <p role="alert">{remove.error.message}</p> : null}
		</div>
	);
}
function SettingsPanel({
	client,
	session,
	capabilities,
}: {
	client: Client;
	session: SessionSnapshot;
	capabilities: AgentCapabilities;
}) {
	const input = { params: { id: session.id }, query: {}, body: {} },
		queries = useQueryClient();
	const settings = useQuery({
		queryKey: ["session-settings", session.id],
		queryFn: () => client.call(routes.sessionSettings, input),
		enabled: capabilities.settings?.get_safe === true,
	});
	const targets = useQuery({
		queryKey: ["session-targets", session.id],
		queryFn: () => client.call(routes.sessionTargets, input),
		enabled: capabilities.targets?.list === true,
	});
	const autonomy = useQuery({
		queryKey: ["session-autonomy", session.id],
		queryFn: () => client.call(routes.sessionAutonomy, input),
		enabled: capabilities.session?.autonomy === true,
	});
	const [draft, setDraft] = useState<SettingsDraft | null>(null);
	const [touched, setTouched] = useState<Set<keyof SettingsDraft>>(() => new Set());
	useEffect(() => {
		if (!settings.data) return;
		const reported = settingsDraft(settings.data);
		setDraft((current) =>
			current === null
				? reported
				: {
						target: touched.has("target") ? current.target : reported.target,
						model: touched.has("model") ? current.model : reported.model,
						thinking: touched.has("thinking") ? current.thinking : reported.thinking,
						autonomy: touched.has("autonomy") ? current.autonomy : reported.autonomy,
					},
		);
	}, [settings.data, touched]);
	const save = useMutation({
		mutationFn: (patch: SafeSettingsPatch) => client.call(routes.patchSessionSettings, { ...input, body: patch }),
		onSuccess: (value) => {
			queries.setQueryData(["session-settings", session.id], value);
			setDraft(settingsDraft(value));
			setTouched(new Set());
			void queries.invalidateQueries({ queryKey: ["session-autonomy", session.id] });
		},
	});
	const setAutonomy = useMutation({
		mutationFn: (level: "read-only" | "suggest" | "auto-edit" | "full-auto") =>
			client.call(routes.setSessionAutonomy, { ...input, body: { level } }),
		onSuccess: (value) => {
			queries.setQueryData(["session-autonomy", session.id], value);
			setDraft((current) => (current ? { ...current, autonomy: value.level } : current));
			setTouched((current) => {
				const next = new Set(current);
				next.delete("autonomy");
				return next;
			});
			void queries.invalidateQueries({ queryKey: ["session-settings", session.id] });
		},
	});
	const probe = useMutation({
		mutationFn: (targetId: string) =>
			client.call(routes.probeSessionTarget, { params: { id: session.id, targetId }, query: {}, body: {} }),
		// A probe refreshes the runtime's catalog for that target, so the model list is read again.
		onSuccess: () => void queries.invalidateQueries({ queryKey: ["session-targets", session.id] }),
	});
	const busy = session.turns.at(-1)?.status === "running";
	const current = draft ?? (settings.data ? settingsDraft(settings.data) : null);
	// The chosen target is asked for its catalog once every few minutes, so the model list is what the
	// endpoint offers rather than what the configuration last recorded. A probe refreshes the runtime's
	// own list, which is then read again.
	const chosenTarget = current?.target ?? "";
	const catalogCheck = useQuery({
		queryKey: ["session-target-probe", session.id, chosenTarget],
		queryFn: () =>
			client.call(routes.probeSessionTarget, {
				params: { id: session.id, targetId: chosenTarget },
				query: {},
				body: {},
			}),
		enabled: chosenTarget !== "" && capabilities.targets?.probe === true,
		staleTime: 5 * 60_000,
		retry: false,
	});
	useEffect(() => {
		if (catalogCheck.dataUpdatedAt > 0) void queries.invalidateQueries({ queryKey: ["session-targets", session.id] });
	}, [catalogCheck.dataUpdatedAt, queries, session.id]);
	const catalogFor = (target: string) => targets.data?.targets.find((row) => row.id === target)?.models ?? null;
	const models = chosenTarget === "" ? null : catalogFor(chosenTarget);
	const modelNeedsTarget = current !== null && current.target === "" && current.model.trim() !== "";
	const modelTooLong = current !== null && new TextEncoder().encode(current.model).length > 256;
	const invalid = modelNeedsTarget || modelTooLong;
	const edit = (patch: Partial<SettingsDraft>) => {
		if (!current || !settings.data) return;
		const reported = settingsDraft(settings.data);
		setDraft({ ...current, ...patch });
		setTouched((previous) => {
			const next = new Set(previous);
			for (const key of Object.keys(patch) as (keyof SettingsDraft)[]) {
				if (patch[key] === reported[key]) next.delete(key);
				else next.add(key);
			}
			return next;
		});
		save.reset();
	};
	const catalogNote = (() => {
		if (chosenTarget === "") return "Automatic routing chooses the target, so it chooses the model too.";
		const cut =
			models !== null && catalogMayBeCut(models)
				? ` Clio Coder lists at most ${ACP_TARGET_MODEL_LIMIT} per target; choose Another model id for one not shown.`
				: "";
		const count = models === null ? "" : ` ${models.length} ${models.length === 1 ? "model" : "models"}.`;
		if (catalogCheck.isFetching) return `Asking ${chosenTarget} for its models…`;
		if (catalogCheck.data?.healthy)
			return `${chosenTarget} answered the check at ${formatTime(new Date(catalogCheck.dataUpdatedAt).toISOString())}.${count}${cut}`;
		if (catalogCheck.data)
			return `${chosenTarget} did not answer the check (${catalogCheck.data.reason ?? "no reason reported"}). These are the models Clio Coder last knew for it.${cut}`;
		if (catalogCheck.error)
			return `The check failed: ${catalogCheck.error.message} These are the models Clio Coder last knew for it.${cut}`;
		return `The models Clio Coder knows for ${chosenTarget}; this agent cannot check the endpoint from here.${count}${cut}`;
	})();
	return (
		<div className="session-settings">
			<p className="session-settings__scope">
				<strong>Saved user defaults.</strong> Changes here are written to your Clio Coder settings and can affect other
				projects and future sessions. Target, model, and thinking also update this running Clio process between turns. The
				autonomy default does not change this session; use the separate session autonomy control below for that.
			</p>
			{settings.data && current ? (
				<form
					onSubmit={(event) => {
						event.preventDefault();
						if (touched.size === 0 || invalid) return;
						const patch: SafeSettingsPatch = {};
						if (touched.has("target")) patch["chat.target"] = current.target || null;
						if (touched.has("model")) patch["chat.model"] = current.model || null;
						if (touched.has("thinking")) patch["chat.thinkingLevel"] = current.thinking;
						if (touched.has("autonomy")) patch["safety.autonomy"] = current.autonomy;
						save.mutate(patch);
					}}
				>
					<fieldset disabled={busy || save.isPending || setAutonomy.isPending || capabilities.settings?.patch_safe !== true}>
						<legend>Saved defaults</legend>
						<label>
							Target
							<select
								value={current.target}
								onChange={(event) => {
									const target = event.target.value;
									edit({ target, model: modelAfterTargetChange(current.model, target === "" ? null : catalogFor(target)) });
								}}
							>
								<option value="">Automatic routing</option>
								{current.target && !targets.data?.targets.some((target) => target.id === current.target) ? (
									<option value={current.target}>{current.target} · current selection</option>
								) : null}
								{targets.data?.targets.map((target) => (
									<option key={target.id} value={target.id}>
										{target.id}
									</option>
								))}
							</select>
							<small>Automatic routing uses Clio Coder's configured target.</small>
						</label>
						<div className="session-settings__model">
							<label htmlFor={`session-model-${session.id}`}>Model</label>
							<ModelSelect
								id={`session-model-${session.id}`}
								value={current.model}
								models={models}
								disabled={chosenTarget === "" && current.model === ""}
								note={catalogNote}
								onChange={(model) => edit({ model })}
							/>
							{modelNeedsTarget ? <small role="alert">Choose a target before setting a model.</small> : null}
							{modelTooLong ? <small role="alert">Model name exceeds the 256 byte limit.</small> : null}
						</div>
						<label>
							Thinking
							<select
								value={current.thinking}
								onChange={(event) => edit({ thinking: event.target.value as SettingsDraft["thinking"] })}
							>
								{["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((value) => (
									<option key={value}>{value}</option>
								))}
							</select>
						</label>
						<label>
							Saved autonomy default for future sessions
							<select
								value={current.autonomy}
								onChange={(event) => edit({ autonomy: event.target.value as SettingsDraft["autonomy"] })}
							>
								{["read-only", "suggest", "auto-edit", "full-auto"].map((value) => (
									<option key={value}>{value}</option>
								))}
							</select>
						</label>
						<div className="actions">
							<button type="submit" disabled={touched.size === 0 || invalid}>
								{save.isPending ? "Saving…" : "Save settings"}
							</button>
							{touched.size > 0 && (
								<button
									type="button"
									onClick={() => {
										setDraft(settingsDraft(settings.data));
										setTouched(new Set());
										save.reset();
									}}
								>
									Discard changes
								</button>
							)}
						</div>
					</fieldset>
					{save.isSuccess && <p role="status">Saved user defaults updated.</p>}
					{capabilities.settings?.patch_safe !== true ? (
						<p>This agent reports settings but does not allow editing them here.</p>
					) : null}
				</form>
			) : settings.error ? (
				<p role="alert">{settings.error.message}</p>
			) : capabilities.settings?.get_safe === true ? (
				<p>Reading settings…</p>
			) : (
				<p>This agent did not advertise session settings controls.</p>
			)}
			{autonomy.data ? (
				<label>
					Autonomy for this session only
					<select
						value={autonomy.data.level}
						disabled={busy || save.isPending || setAutonomy.isPending}
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
			<h2>Configured targets</h2>
			{capabilities.targets?.list !== true ? <p>This agent did not advertise a target list.</p> : null}
			{capabilities.targets?.list === true && capabilities.targets.probe !== true ? (
				<p>This agent reports configured targets but does not offer a live probe.</p>
			) : null}
			{capabilities.targets?.list === true && targets.isPending ? <p>Reading configured targets…</p> : null}
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
					{capabilities.targets?.probe === true ? (
						<>
							<button type="button" disabled={probe.isPending} onClick={() => probe.mutate(target.id)}>
								{probe.isPending && probe.variables === target.id ? "Probing…" : `Probe ${target.id}`}
							</button>
							{probe.data?.targetId === target.id && !probe.isPending ? (
								<p role="status">
									{probe.data.healthy ? "Healthy" : probe.data.reason}
									{probe.data.latencyMs === null ? "" : ` · ${probe.data.latencyMs} ms`}
								</p>
							) : null}
						</>
					) : null}
				</div>
			))}
			{[
				...new Set(
					[targets.error, autonomy.error, save.error, setAutonomy.error, probe.error].flatMap((error) =>
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
export function SessionControls({
	client,
	session,
	capabilities,
}: {
	client: Client;
	session: SessionSnapshot;
	capabilities: AgentCapabilities;
}) {
	const [label, setLabel] = useState(session.label ?? "");
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
		<section className="session-controls" aria-label="Conversation controls and saved defaults">
			<h2>Conversation controls and saved defaults</h2>
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
			{session.state === "open" ? <SettingsPanel client={client} session={session} capabilities={capabilities} /> : null}
			{session.state === "closed" ? (
				<DeleteSession client={client} id={session.id} workspaceId={session.workspaceId} name="this closed session" />
			) : null}
		</section>
	);
}
