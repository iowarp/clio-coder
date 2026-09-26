// The next request’s route, with explicit conversation and saved scopes.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useRef, useState } from "react";
import type { AgentCapabilities } from "../../contracts/capabilities.js";
import { routes } from "../../contracts/routes.js";
import type { SessionConfig } from "../../contracts/session-config.js";
import type { SafeSettingsPatch } from "../../contracts/settings-safe.js";
import type { Client } from "../api/client.js";
import { formatTime } from "../api/clock.js";
import { TONE_GLYPHS } from "../design/status.js";
import { announce } from "../interaction/announcer.js";
import { useDetailsDismiss } from "../interaction/use-details-dismiss.js";
import { ACP_TARGET_MODEL_LIMIT, catalogMayBeCut, modelAfterTargetChange } from "../pages/model-options.js";
import { ModelSelect } from "../pages/model-select.js";
import type { RouteFacts } from "./route.js";
import type { RouteDraft, RouteScope } from "./route-picker-model.js";
import { conversationChanges, routeDraft, savedRoutePatch } from "./route-picker-model.js";

type Thinking = NonNullable<SafeSettingsPatch["chat.thinkingLevel"]>;
const THINKING: readonly Thinking[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** The chip's face: the reported route with the target's health as its glyph. */
function RouteFace({ route }: { route: RouteFacts }) {
	return (
		<>
			<span className="route-chip__glyph" aria-hidden="true">
				{TONE_GLYPHS[route.tone]}
			</span>
			<span className="route-chip__text">{route.model ?? route.text}</span>
			{route.thinking ? (
				<span className="route-chip__thinking" aria-hidden="true">
					{route.thinking}
				</span>
			) : null}
			<span className="sr-only">{route.spoken}</span>
		</>
	);
}

export function RoutePicker({
	client,
	sessionId,
	route,
	running,
	capabilities,
}: {
	client: Client;
	sessionId: string;
	route: RouteFacts;
	running: boolean;
	capabilities: AgentCapabilities | undefined;
}) {
	const panel = useRef<HTMLDetailsElement>(null);
	const [open, setOpen] = useState(false);
	useDetailsDismiss(panel, open);
	const global = capabilities?.settings?.get_safe === true && capabilities.settings.patch_safe === true;
	if (!global && !route.config?.options.length)
		return (
			<span className="route-chip" data-tone={route.tone} title={route.title}>
				<RouteFace route={route} />
			</span>
		);
	const close = () => {
		if (!panel.current) return;
		panel.current.open = false;
		panel.current.querySelector("summary")?.focus();
	};
	return (
		<details className="route-picker" ref={panel} onToggle={(event) => setOpen(event.currentTarget.open)}>
			<summary className="route-chip" data-tone={route.tone} title={route.title}>
				<span className="sr-only">Model for the next request: </span>
				<RouteFace route={route} />
				<span className="route-chip__caret" aria-hidden="true">
					▾
				</span>
			</summary>
			{open ? (
				<RouteForm
					client={client}
					sessionId={sessionId}
					running={running}
					global={global}
					config={route.config}
					probe={capabilities?.targets?.probe === true}
					list={capabilities?.targets?.list === true}
					onDone={close}
				/>
			) : null}
		</details>
	);
}

/** Mounted only while the picker is open, so a closed chip never asks an endpoint for its catalog. */
function RouteForm({
	client,
	sessionId,
	running,
	global,
	config,
	list,
	probe,
	onDone,
}: {
	client: Client;
	sessionId: string;
	running: boolean;
	global: boolean;
	config: SessionConfig | undefined;
	list: boolean;
	probe: boolean;
	onDone: () => void;
}) {
	const queries = useQueryClient();
	const input = { params: { id: sessionId }, query: {}, body: {} };
	const targetId = useId();
	const modelId = useId();
	const thinkingId = useId();
	const scopeId = useId();
	const scopeSelectId = useId();
	const [scope, setScope] = useState<RouteScope>(config?.options.length ? "conversation" : "every-project");
	const settings = useQuery({
		queryKey: ["session-settings", sessionId],
		queryFn: () => client.call(routes.sessionSettings, input),
		enabled: global,
	});
	const targets = useQuery({
		queryKey: ["session-targets", sessionId],
		queryFn: () => client.call(routes.sessionTargets, input),
		enabled: list,
	});
	const [edited, setEdited] = useState<RouteDraft | null>(null);
	const reported = routeDraft(settings.data, config, scope);
	const draft = edited ?? reported;
	const chosenTarget = draft?.target ?? "";
	// The chosen target is asked for its catalog at most every five minutes, so the list is what the
	// endpoint offers rather than what the configuration last recorded.
	const catalogCheck = useQuery({
		queryKey: ["session-target-probe", sessionId, chosenTarget],
		queryFn: async () => {
			const result = await client.call(routes.probeSessionTarget, {
				params: { id: sessionId, targetId: chosenTarget },
				query: {},
				body: {},
			});
			void queries.invalidateQueries({ queryKey: ["session-targets", sessionId] });
			return result;
		},
		enabled: chosenTarget !== "" && probe,
		staleTime: 5 * 60_000,
		retry: false,
	});
	const catalogFor = (target: string) => targets.data?.targets.find((row) => row.id === target)?.models ?? null;
	const models = chosenTarget === "" ? null : catalogFor(chosenTarget);
	const save = useMutation({
		mutationFn: async () => {
			if (!draft || !reported) return;
			if (scope === "every-project") {
				const value = await client.call(routes.patchSessionSettings, { ...input, body: savedRoutePatch(draft, reported) });
				queries.setQueryData(["session-settings", sessionId], value);
			} else {
				for (const body of conversationChanges(draft, reported))
					await client.call(routes.setSessionConfig, { ...input, body });
			}
			await queries.invalidateQueries({ queryKey: ["session", sessionId] });
			await queries.invalidateQueries({ queryKey: ["session-settings", sessionId] });
		},
		onSuccess: () => {
			announce(
				scope === "conversation"
					? "Model and thinking changed for this conversation’s next request."
					: "Route saved for every project.",
			);
			onDone();
		},
		onError: () => {
			// Separate ACP controls can partly succeed. Read the authoritative state before offering a retry.
			setEdited(null);
			void queries.invalidateQueries({ queryKey: ["session", sessionId] });
			void queries.invalidateQueries({ queryKey: ["session-settings", sessionId] });
		},
	});
	if (!draft || !reported)
		return (
			<div className="route-picker__panel">
				{settings.error ? <p role="alert">{settings.error.message}</p> : <p>Reading the model settings…</p>}
			</div>
		);
	const changed =
		scope === "conversation"
			? conversationChanges(draft, reported).length > 0
			: Object.keys(savedRoutePatch(draft, reported)).length > 0;
	const modelNeedsTarget = scope === "every-project" && draft.target === "" && draft.model.trim() !== "";
	const edit = (next: Partial<RouteDraft>) => {
		setEdited({ ...draft, ...next });
		save.reset();
	};
	const cut =
		models !== null && catalogMayBeCut(models)
			? ` Clio Coder lists at most ${ACP_TARGET_MODEL_LIMIT} per target; choose Another model id for one not shown.`
			: "";
	const count = models === null ? "" : ` ${models.length} ${models.length === 1 ? "model" : "models"}.`;
	const note =
		chosenTarget === ""
			? "Automatic routing chooses the target, so it chooses the model too."
			: catalogCheck.isFetching
				? `Asking ${chosenTarget} for its models…`
				: catalogCheck.data?.healthy
					? `${chosenTarget} answered at ${formatTime(new Date(catalogCheck.dataUpdatedAt).toISOString())}.${count}${cut}`
					: catalogCheck.data
						? `${chosenTarget} did not answer (${catalogCheck.data.reason ?? "no reason reported"}). These are the models Clio Coder last knew for it.${cut}`
						: catalogCheck.error
							? `The check failed: ${catalogCheck.error.message} These are the models Clio Coder last knew for it.${cut}`
							: `The models Clio Coder knows for ${chosenTarget}.${count}${cut}`;
	const locked = running || save.isPending;
	return (
		<div className="route-picker__panel">
			<p className="route-picker__title">Model for the next request</p>
			<div className="route-picker__fields">
				<label htmlFor={scopeSelectId}>Apply to</label>
				<select
					id={scopeSelectId}
					value={scope}
					disabled={locked}
					onChange={(event) => {
						setScope(event.target.value as RouteScope);
						setEdited(null);
						save.reset();
					}}
				>
					{config?.options.length ? <option value="conversation">This conversation</option> : null}
					{global ? <option value="every-project">Every project</option> : null}
				</select>
				<label htmlFor={targetId}>Target</label>
				<select
					id={targetId}
					value={draft.target}
					disabled={locked || scope === "conversation"}
					onChange={(event) => {
						const target = event.target.value;
						edit({ target, model: modelAfterTargetChange(draft.model, target === "" ? null : catalogFor(target)) });
					}}
				>
					<option value="">Automatic routing</option>
					{draft.target && !targets.data?.targets.some((row) => row.id === draft.target) ? (
						<option value={draft.target}>{draft.target}</option>
					) : null}
					{targets.data?.targets.map((row) => (
						<option key={row.id} value={row.id}>
							{row.id}
						</option>
					))}
				</select>
				<label htmlFor={modelId}>Model</label>
				{scope === "conversation" ? (
					<select
						id={modelId}
						value={draft.model}
						disabled={locked || !config?.options.some((row) => row.id === "model")}
						onChange={(event) => edit({ model: event.target.value })}
					>
						{config?.options
							.find((row) => row.id === "model")
							?.options.map((row) => (
								<option key={row.value} value={row.value}>
									{row.name}
								</option>
							))}
						{!draft.model ? <option value="">Model not reported</option> : null}
					</select>
				) : (
					<ModelSelect
						id={modelId}
						value={draft.model}
						models={models}
						disabled={locked || (chosenTarget === "" && draft.model === "")}
						note={note}
						onChange={(model) => edit({ model })}
					/>
				)}
				<label htmlFor={thinkingId}>Thinking</label>
				<select
					id={thinkingId}
					value={draft.thinking}
					disabled={locked || (scope === "conversation" && !config?.options.some((row) => row.id === "thinkingLevel"))}
					onChange={(event) => edit({ thinking: event.target.value })}
				>
					{(scope === "conversation"
						? (config?.options.find((row) => row.id === "thinkingLevel")?.options.map((row) => row.value) ?? [])
						: THINKING
					).map((level) => (
						<option key={level}>{level}</option>
					))}
				</select>
			</div>
			{modelNeedsTarget ? <p role="alert">Choose a target before naming a model.</p> : null}
			<p className="route-picker__scope" id={scopeId}>
				{scope === "conversation" ? (
					<>
						<strong>This conversation.</strong> Model and thinking apply from its next request. Saved defaults stay as they
						are. ACP cannot switch targets for one conversation; choose Every project to change the target.
					</>
				) : (
					<>
						<strong>Saved for every project.</strong> This conversation uses it from its next request, and so do new
						conversations, the CLI and the TUI.
					</>
				)}
			</p>
			{running ? <p className="route-picker__wait">You can change this when the current turn finishes.</p> : null}
			<div className="route-picker__actions">
				<button
					type="button"
					className="primary"
					aria-describedby={scopeId}
					disabled={locked || !changed || modelNeedsTarget}
					onClick={() => save.mutate()}
				>
					{save.isPending ? "Saving…" : scope === "conversation" ? "Apply to this conversation" : "Save for every project"}
				</button>
				<button type="button" onClick={onDone}>
					Cancel
				</button>
			</div>
			{save.error || targets.error ? <p role="alert">{save.error?.message ?? targets.error?.message}</p> : null}
		</div>
	);
}
