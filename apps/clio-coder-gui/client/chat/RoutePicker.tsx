// Where the next request goes, and the one place to change it. The chip beside Send names the target
// and model Clio Coder reports; when the agent lets the GUI edit its safe settings, the chip opens a
// small picker for target, model and thinking. The runtime's only write is `settings/patch_safe`,
// which saves to the operator's user settings, so the picker says "Saved for every project" before
// its button and names what else starts with the choice. A route for one conversation alone needs a
// session-scoped routing method in the runtime, which ACP does not offer yet.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useRef, useState } from "react";
import type { AgentCapabilities } from "../../contracts/capabilities.js";
import { routes } from "../../contracts/routes.js";
import type { SafeSettings, SafeSettingsPatch } from "../../contracts/settings-safe.js";
import type { Client } from "../api/client.js";
import { formatTime } from "../api/clock.js";
import { TONE_GLYPHS } from "../design/status.js";
import { announce } from "../interaction/announcer.js";
import { useDetailsDismiss } from "../interaction/use-details-dismiss.js";
import { ACP_TARGET_MODEL_LIMIT, catalogMayBeCut, modelAfterTargetChange } from "../pages/model-options.js";
import { ModelSelect } from "../pages/model-select.js";
import type { RouteFacts } from "./route.js";

type Thinking = NonNullable<SafeSettingsPatch["chat.thinkingLevel"]>;
const THINKING: readonly Thinking[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** The chip's face: the reported route with the target's health as its glyph. */
function RouteFace({ route }: { route: RouteFacts }) {
	return (
		<>
			<span className="route-chip__glyph" aria-hidden="true">
				{TONE_GLYPHS[route.tone]}
			</span>
			<span className="route-chip__text">{route.text}</span>
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
	if (capabilities?.settings?.get_safe !== true || capabilities.settings.patch_safe !== true)
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
					probe={capabilities.targets?.probe === true}
					list={capabilities.targets?.list === true}
					onDone={close}
				/>
			) : null}
		</details>
	);
}

type Draft = { target: string; model: string; thinking: Thinking };
const draftOf = (report: SafeSettings): Draft => ({
	target: report.settings.chat.target ?? "",
	model: report.settings.chat.model ?? "",
	thinking: report.settings.chat.thinkingLevel,
});

/** Mounted only while the picker is open, so a closed chip never asks an endpoint for its catalog. */
function RouteForm({
	client,
	sessionId,
	running,
	list,
	probe,
	onDone,
}: {
	client: Client;
	sessionId: string;
	running: boolean;
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
	const settings = useQuery({
		queryKey: ["session-settings", sessionId],
		queryFn: () => client.call(routes.sessionSettings, input),
	});
	const targets = useQuery({
		queryKey: ["session-targets", sessionId],
		queryFn: () => client.call(routes.sessionTargets, input),
		enabled: list,
	});
	const [edited, setEdited] = useState<Draft | null>(null);
	const reported = settings.data ? draftOf(settings.data) : null;
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
		mutationFn: (patch: SafeSettingsPatch) => client.call(routes.patchSessionSettings, { ...input, body: patch }),
		onSuccess: (value) => {
			queries.setQueryData(["session-settings", sessionId], value);
			const chat = value.settings.chat;
			announce(`Saved for every project: ${chat.target ?? "automatic routing"} · ${chat.model ?? "default model"}.`);
			onDone();
		},
	});
	if (!draft || !reported)
		return (
			<div className="route-picker__panel">
				{settings.error ? <p role="alert">{settings.error.message}</p> : <p>Reading the model settings…</p>}
			</div>
		);
	const patch: SafeSettingsPatch = {};
	if (draft.target !== reported.target) patch["chat.target"] = draft.target || null;
	if (draft.model !== reported.model) patch["chat.model"] = draft.model || null;
	if (draft.thinking !== reported.thinking) patch["chat.thinkingLevel"] = draft.thinking;
	const changed = Object.keys(patch).length > 0;
	const modelNeedsTarget = draft.target === "" && draft.model.trim() !== "";
	const edit = (next: Partial<Draft>) => {
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
				<label htmlFor={targetId}>Target</label>
				<select
					id={targetId}
					value={draft.target}
					disabled={locked}
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
				<ModelSelect
					id={modelId}
					value={draft.model}
					models={models}
					disabled={locked || (chosenTarget === "" && draft.model === "")}
					note={note}
					onChange={(model) => edit({ model })}
				/>
				<label htmlFor={thinkingId}>Thinking</label>
				<select
					id={thinkingId}
					value={draft.thinking}
					disabled={locked}
					onChange={(event) => edit({ thinking: event.target.value as Thinking })}
				>
					{THINKING.map((level) => (
						<option key={level}>{level}</option>
					))}
				</select>
			</div>
			{modelNeedsTarget ? <p role="alert">Choose a target before naming a model.</p> : null}
			<p className="route-picker__scope" id={scopeId}>
				<strong>Saved for every project.</strong> This conversation uses it from its next request, and so do new
				conversations, the CLI and the TUI.
			</p>
			{running ? <p className="route-picker__wait">You can change this when the current turn finishes.</p> : null}
			<div className="route-picker__actions">
				<button
					type="button"
					className="primary"
					aria-describedby={scopeId}
					disabled={locked || !changed || modelNeedsTarget}
					onClick={() => save.mutate(patch)}
				>
					{save.isPending ? "Saving…" : "Save for every project"}
				</button>
				<button type="button" onClick={onDone}>
					Cancel
				</button>
			</div>
			{save.error || targets.error ? <p role="alert">{save.error?.message ?? targets.error?.message}</p> : null}
		</div>
	);
}
