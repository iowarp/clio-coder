import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import { routes } from "../../contracts/routes.js";
import { type Client, emptyInput } from "../api/client.js";
import { authGuidance, type Draft, draftProblems, suggestId, toRequest } from "./target-onboarding-model.js";
import "./target-onboarding.css";

const blank: Draft = { runtime: "", id: "", url: "", model: "", apiKeyEnv: "", useForChat: false };

export function AddConnection({
	client,
	taken,
	busy,
	completedId,
	onSubmit,
}: {
	client: Client;
	taken: readonly string[];
	busy: boolean;
	completedId: string | undefined;
	onSubmit: (request: ReturnType<typeof toRequest>) => void;
}) {
	const form = useId();
	const [open, setOpen] = useState(false),
		[draft, setDraft] = useState<Draft>(blank);
	useEffect(() => {
		if (!completedId) return;
		setOpen(false);
		setDraft(blank);
	}, [completedId]);
	const runtimes = useQuery({
		queryKey: ["target-runtimes"],
		queryFn: () => client.call(routes.targetRuntimes, emptyInput),
		enabled: open,
	});
	if (!open)
		return (
			<div className="actions">
				<button type="button" className="primary" onClick={() => setOpen(true)}>
					Add a connection
				</button>
			</div>
		);
	const runtime = runtimes.data?.runtimes.find((candidate) => candidate.id === draft.runtime);
	const guidance = runtime ? authGuidance(runtime) : null;
	const problems = draftProblems(draft, runtime, taken);
	const groups = [...new Set(runtimes.data?.runtimes.map((candidate) => candidate.group) ?? [])];
	const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
	return (
		<form
			className="trace-panel add-connection"
			aria-labelledby={`${form}-title`}
			onSubmit={(event) => {
				event.preventDefault();
				if (!busy && runtime && !problems.length) onSubmit(toRequest(draft, runtime));
			}}
		>
			<h2 id={`${form}-title`}>Add a connection</h2>
			<p>
				Clio checks the endpoint, lists its models when it can, and saves the connection to your user settings. This form
				has no key field: a credential is named by environment variable or stored from a terminal, and never passes through
				the browser.
			</p>
			{runtimes.isPending && <p>Reading runtimes…</p>}
			{runtimes.error && <p role="alert">{runtimes.error.message}</p>}
			{runtimes.data && (
				<>
					<label htmlFor={`${form}-runtime`}>Runtime</label>
					<select
						id={`${form}-runtime`}
						disabled={busy}
						value={draft.runtime}
						onChange={(event) => {
							const next = runtimes.data.runtimes.find((candidate) => candidate.id === event.target.value);
							setDraft({
								...blank,
								runtime: event.target.value,
								id: next ? suggestId(next, taken) : "",
								model: next?.defaultModel ?? "",
							});
						}}
					>
						<option value="">Choose a runtime…</option>
						{groups.map((group) => (
							<optgroup key={group} label={group}>
								{runtimes.data.runtimes
									.filter((candidate) => candidate.group === group)
									.map((candidate) => (
										<option key={candidate.id} value={candidate.id}>
											{candidate.label}
											{candidate.targetCount ? ` · ${candidate.targetCount} configured` : ""}
										</option>
									))}
							</optgroup>
						))}
					</select>
				</>
			)}
			{runtime && guidance && (
				<>
					<p>{runtime.summary}</p>
					<p className="add-connection__auth" data-tone={guidance.tone}>
						{guidance.text}
					</p>
					<label htmlFor={`${form}-id`}>Connection id</label>
					<input id={`${form}-id`} value={draft.id} disabled={busy} onChange={(event) => set({ id: event.target.value })} />
					{runtime.supportsCustomUrl && (
						<>
							<label htmlFor={`${form}-url`}>Endpoint URL</label>
							<input
								id={`${form}-url`}
								type="url"
								disabled={busy}
								value={draft.url}
								placeholder="Leave blank for this runtime's default address"
								onChange={(event) => set({ url: event.target.value })}
							/>
						</>
					)}
					<label htmlFor={`${form}-model`}>Default model{runtime.modelRequired ? "" : " (optional)"}</label>
					<input
						id={`${form}-model`}
						disabled={busy}
						value={draft.model}
						list={`${form}-models`}
						placeholder={runtime.modelRequired ? "Choose a model" : "Leave blank to use the first model the endpoint reports"}
						onChange={(event) => set({ model: event.target.value })}
					/>
					<datalist id={`${form}-models`}>
						{runtime.modelHints.map((hint) => (
							<option key={hint} value={hint} />
						))}
					</datalist>
					{runtime.auth !== "none" && runtime.auth !== "connected" && runtime.auth !== "other" && (
						<>
							<label htmlFor={`${form}-env`}>Environment variable holding the key (optional)</label>
							<input
								id={`${form}-env`}
								disabled={busy}
								value={draft.apiKeyEnv}
								placeholder="For example OPENAI_API_KEY"
								autoComplete="off"
								onChange={(event) => set({ apiKeyEnv: event.target.value })}
							/>
							<small>Clio reads the variable when it makes a request. Only its name is saved.</small>
						</>
					)}
					<label className="add-connection__check">
						<input
							type="checkbox"
							disabled={busy}
							checked={draft.useForChat}
							onChange={(event) => set({ useForChat: event.target.checked })}
						/>
						<span>Use this connection for chat</span>
					</label>
					{draft.id !== "" && problems.length > 0 && (
						<ul className="add-connection__problems">
							{problems.map((problem) => (
								<li key={problem}>{problem}</li>
							))}
						</ul>
					)}
				</>
			)}
			<div className="actions">
				<button type="submit" className="primary" disabled={busy || !runtime || problems.length > 0}>
					{busy ? "Working…" : "Save connection"}
				</button>
				<button
					type="button"
					disabled={busy}
					onClick={() => {
						setOpen(false);
						setDraft(blank);
					}}
				>
					Cancel
				</button>
			</div>
		</form>
	);
}
