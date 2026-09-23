import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate } from "react-router";

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
import type { SafeSettingsPatch } from "../../contracts/settings-safe.js";
import type { Client } from "../api/client.js";
import { discardDraftStore } from "../chat/composer.js";

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
type AutonomyLevel = NonNullable<SafeSettingsPatch["safety.autonomy"]>;
const AUTONOMY_LEVELS: readonly AutonomyLevel[] = ["read-only", "suggest", "auto-edit", "full-auto"];

/**
 * Working freedom for this conversation and the saved default for new ones. Target, model and thinking
 * are chosen in the route picker beside Send, which is where the next request leaves from, and the
 * full target list is on the Targets page; this panel points there rather than offering a second way.
 */
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
	const autonomy = useQuery({
		queryKey: ["session-autonomy", session.id],
		queryFn: () => client.call(routes.sessionAutonomy, input),
		enabled: capabilities.session?.autonomy === true,
	});
	const [defaultLevel, setDefaultLevel] = useState<AutonomyLevel | null>(null);
	const save = useMutation({
		mutationFn: (level: AutonomyLevel) =>
			client.call(routes.patchSessionSettings, { ...input, body: { "safety.autonomy": level } }),
		onSuccess: (value) => {
			queries.setQueryData(["session-settings", session.id], value);
			setDefaultLevel(null);
		},
	});
	const setAutonomy = useMutation({
		mutationFn: (level: AutonomyLevel) => client.call(routes.setSessionAutonomy, { ...input, body: { level } }),
		onSuccess: (value) => queries.setQueryData(["session-autonomy", session.id], value),
	});
	const busy = session.turns.at(-1)?.status === "running";
	const reportedDefault = settings.data?.settings.safety.autonomy;
	const chosenDefault = defaultLevel ?? reportedDefault;
	return (
		<div className="session-settings">
			{capabilities.settings?.patch_safe === true ? (
				<p className="session-settings__route">
					Choose the target and model beside Send, under the message field. Every configured target is on the{" "}
					<Link to="/settings/targets">Targets page</Link>.
				</p>
			) : null}
			{autonomy.data ? (
				<label>
					Working freedom for this conversation
					<select
						value={autonomy.data.level}
						disabled={busy || setAutonomy.isPending}
						onChange={(event) => setAutonomy.mutate(event.target.value as AutonomyLevel)}
					>
						{AUTONOMY_LEVELS.map((value) => (
							<option key={value}>{value}</option>
						))}
					</select>
					<small>Takes effect at once and lasts until this session closes. Source: {autonomy.data.source}.</small>
				</label>
			) : null}
			{settings.data && chosenDefault ? (
				<form
					className="session-settings__default"
					onSubmit={(event) => {
						event.preventDefault();
						if (defaultLevel !== null && defaultLevel !== reportedDefault) save.mutate(defaultLevel);
					}}
				>
					<label>
						Working freedom for new conversations
						<select
							value={chosenDefault}
							disabled={busy || save.isPending || capabilities.settings?.patch_safe !== true}
							onChange={(event) => {
								setDefaultLevel(event.target.value as AutonomyLevel);
								save.reset();
							}}
						>
							{AUTONOMY_LEVELS.map((value) => (
								<option key={value}>{value}</option>
							))}
						</select>
					</label>
					{capabilities.settings?.patch_safe === true ? (
						<>
							<p className="session-settings__scope">
								<strong>Saved for every project.</strong> New conversations start with it; this one keeps its own.
							</p>
							<button
								type="submit"
								disabled={busy || save.isPending || defaultLevel === null || defaultLevel === reportedDefault}
							>
								{save.isPending ? "Saving…" : "Save for every project"}
							</button>
						</>
					) : (
						<p>This agent reports its settings but does not let the GUI change them.</p>
					)}
					{save.isSuccess ? <p role="status">Saved for every project.</p> : null}
				</form>
			) : settings.error ? (
				<p role="alert">{settings.error.message}</p>
			) : capabilities.settings?.get_safe === true ? (
				<p>Reading settings…</p>
			) : (
				<p>This agent did not advertise session settings controls.</p>
			)}
			{[
				...new Set([autonomy.error, save.error, setAutonomy.error].flatMap((error) => (error ? [error.message] : []))),
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
		<section className="session-controls" aria-label="Conversation settings">
			<h2>Conversation settings</h2>
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
