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
import { discardDraftStore } from "../chat/composer.js";

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

export function DeleteSession({ client, id, workspaceId }: { client: Client; id: string; workspaceId: string }) {
	const queries = useQueryClient(),
		navigate = useNavigate();
	const remove = useMutation({
		mutationFn: () => client.call(routes.deleteSession, { params: { id }, query: {}, body: { workspaceId } }),
		onSuccess: () => {
			discardDraftStore(id);
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
	});
	const busy = session.turns.at(-1)?.status === "running";
	const current = draft ?? (settings.data ? settingsDraft(settings.data) : null);
	const modelSuggestions = [
		...new Set(targets.data?.targets.find((target) => target.id === current?.target)?.models ?? []),
	].sort();
	const modelNeedsTarget = current !== null && current.target === "" && current.model.trim() !== "";
	const modelTooLong = current !== null && new TextEncoder().encode(current.model).length > 256;
	const invalid = modelNeedsTarget || modelTooLong;
	const edit = <K extends keyof SettingsDraft>(key: K, value: SettingsDraft[K]) => {
		if (!current || !settings.data) return;
		setDraft({ ...current, [key]: value });
		setTouched((previous) => {
			const next = new Set(previous);
			if (value === settingsDraft(settings.data)[key]) next.delete(key);
			else next.add(key);
			return next;
		});
		save.reset();
	};
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
							<select value={current.target} onChange={(event) => edit("target", event.target.value)}>
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
						<label>
							Model
							<input
								value={current.model}
								maxLength={256}
								list={`session-models-${session.id}`}
								onChange={(event) => edit("model", event.target.value)}
							/>
							<datalist id={`session-models-${session.id}`}>
								{modelSuggestions.map((model) => (
									<option key={model} value={model} />
								))}
							</datalist>
							<small>
								Leave blank for the configured default. Suggestions come from the selected target and are not a live
								availability check.
							</small>
							{modelNeedsTarget ? <small role="alert">Choose a target before setting a model.</small> : null}
							{modelTooLong ? <small role="alert">Model name exceeds the 256 byte limit.</small> : null}
						</label>
						<label>
							Thinking
							<select
								value={current.thinking}
								onChange={(event) => edit("thinking", event.target.value as SettingsDraft["thinking"])}
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
								onChange={(event) => edit("autonomy", event.target.value as SettingsDraft["autonomy"])}
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
				<DeleteSession client={client} id={session.id} workspaceId={session.workspaceId} />
			) : null}
		</section>
	);
}
