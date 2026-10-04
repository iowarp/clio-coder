// The next request’s route, with explicit conversation and saved scopes.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import type { AgentCapabilities } from "../../contracts/capabilities.js";
import { routes } from "../../contracts/routes.js";
import type { SessionConfig } from "../../contracts/session-config.js";
import type { Client } from "../api/client.js";
import { formatTime } from "../api/clock.js";
import { Icon } from "../design/icons.js";
import { TONE_GLYPHS } from "../design/status.js";
import { announce } from "../interaction/announcer.js";
import { useDetailsDismiss } from "../interaction/use-details-dismiss.js";
import { ACP_TARGET_MODEL_LIMIT, catalogMayBeCut, modelAfterTargetChange } from "../pages/model-picker-model.js";
import type { RouteFacts } from "./route.js";
import type { RouteDraft } from "./route-picker-model.js";
import {
	conversationChanges,
	draftWithSupportedThinking,
	modelThinkingLevels,
	routeDraft,
	routePickerChoices,
} from "./route-picker-model.js";

/** Openers keyed by session, so the Session column's Model section can open this composer's picker. */
const openers = new Map<string, () => boolean>();

/** Opens the route picker in a session's composer. False when that composer shows no picker. */
export function openRoutePicker(sessionId: string): boolean {
	return openers.get(sessionId)?.() ?? false;
}

/** The chip's face: the reported route with the target's health as its glyph. */
function RouteFace({ route }: { route: RouteFacts }) {
	return (
		<>
			<span className="route-chip__glyph" aria-hidden="true">
				{TONE_GLYPHS[route.tone]}
			</span>
			<span className="route-chip__text">{route.model ?? route.text}</span>
			{/* A bare level beside a model name reads as nothing in particular, so the level carries its noun. */}
			{route.thinking ? (
				<span className="route-chip__thinking" aria-hidden="true">
					<span className="route-chip__thinking-label">Thinking </span>
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
	useEffect(() => {
		const reveal = () => {
			const details = panel.current;
			if (!details) return false;
			details.open = true;
			details.querySelector("summary")?.focus();
			return true;
		};
		openers.set(sessionId, reveal);
		return () => {
			if (openers.get(sessionId) === reveal) openers.delete(sessionId);
		};
	}, [sessionId]);
	if (!route.config?.options.length)
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
				<span className="route-chip__caret">
					<Icon name="chevronDown" />
				</span>
			</summary>
			{open ? (
				<RouteForm
					client={client}
					sessionId={sessionId}
					running={running}
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
	config,
	list,
	probe,
	onDone,
}: {
	client: Client;
	sessionId: string;
	running: boolean;
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
	const targets = useQuery({
		queryKey: ["session-targets", sessionId],
		queryFn: () => client.call(routes.sessionTargets, input),
		enabled: list,
	});
	const [edited, setEdited] = useState<RouteDraft | null>(null);
	const reported = routeDraft(undefined, config, "conversation");
	const requested = edited ?? reported;
	const thinkingLevels = modelThinkingLevels(
		config,
		requested?.model ?? "",
		targets.data?.targets.find((row) => row.id === requested?.target)?.thinkingLevels,
		requested?.target === config?.target,
	);
	const draft = draftWithSupportedThinking(requested, thinkingLevels);
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
			for (const body of conversationChanges(draft, reported))
				await client.call(routes.setSessionConfig, { ...input, body });
			await queries.invalidateQueries({ queryKey: ["session", sessionId] });
		},
		onSuccess: () => {
			announce("Connection, model and thinking changed for this conversation’s next request.");
			onDone();
		},
		onError: () => {
			// Separate ACP controls can partly succeed. Read the authoritative state before offering a retry.
			setEdited(null);
			void queries.invalidateQueries({ queryKey: ["session", sessionId] });
		},
	});
	if (!draft || !reported)
		return (
			<div className="route-picker__panel">
				<p>Reading this conversation’s model controls…</p>
			</div>
		);
	const changed = conversationChanges(draft, reported).length > 0;
	const modelNeedsTarget = draft.target === "" && draft.model.trim() !== "";
	const edit = (next: Partial<RouteDraft>) => {
		setEdited({ ...draft, ...next });
		save.reset();
	};
	const cut =
		models !== null && catalogMayBeCut(models)
			? ` Clio Coder lists at most ${ACP_TARGET_MODEL_LIMIT} models per connection.`
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
	const choices = routePickerChoices(config, draft, targets.data?.targets);
	const locked = running || save.isPending;
	return (
		<div className="route-picker__panel">
			<p className="route-picker__title">Model for the next request</p>
			<div className="route-picker__fields">
				<label htmlFor={targetId}>Connection</label>
				<select
					id={targetId}
					value={draft.target}
					disabled={locked || !choices.targetEditable}
					onChange={(event) => {
						const target = event.target.value;
						edit({ target, model: modelAfterTargetChange(draft.model, target === "" ? null : catalogFor(target)) });
					}}
				>
					{choices.targets.map((row) => (
						<option key={row.value} value={row.value}>
							{row.label}
						</option>
					))}
				</select>
				<label htmlFor={modelId}>Model</label>
				<select
					id={modelId}
					value={draft.model}
					disabled={locked || !choices.modelEditable}
					onChange={(event) => edit({ model: event.target.value })}
				>
					{choices.models.map((row) => (
						<option key={row.value} value={row.value}>
							{row.label}
						</option>
					))}
				</select>
				<label htmlFor={thinkingId}>Thinking</label>
				<select
					id={thinkingId}
					value={draft.thinking}
					disabled={locked || thinkingLevels.length === 0}
					onChange={(event) => edit({ thinking: event.target.value })}
				>
					{thinkingLevels.map((level) => (
						<option key={level}>{level}</option>
					))}
				</select>
			</div>
			<p>{note}</p>
			{modelNeedsTarget ? <p role="alert">Choose a connection before naming a model.</p> : null}
			<p className="route-picker__scope" id={scopeId}>
				<strong>This conversation.</strong> Connection, model and thinking apply from its next request. Saved defaults stay
				as they are. Change saved defaults in Settings or Connections.
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
					{save.isPending ? "Applying…" : "Apply to this conversation"}
				</button>
				<button type="button" onClick={onDone}>
					Cancel
				</button>
			</div>
			{save.error || targets.error ? <p role="alert">{save.error?.message ?? targets.error?.message}</p> : null}
		</div>
	);
}
