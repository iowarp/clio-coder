import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router";
import { routes } from "../../contracts/routes.js";
import type { SetupAnswer, SetupState } from "../../contracts/setup.js";
import { type Client, emptyInput } from "../api/client.js";
import "./target-onboarding.css";

export function useSetupStatus(client: Client) {
	return useQuery({ queryKey: ["setup-status"], queryFn: () => client.call(routes.setupStatus, emptyInput) });
}

/** Runtime-authored sign-in links are explicit actions, never opened by polling. */
function SetupMessage({ text }: { text: string }) {
	const match = /^\s*Open: (https?:\/\/\S+)\s*$/u.exec(text);
	if (match) {
		try {
			const url = new URL(match[1] ?? "");
			if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password)
				return (
					<a href={url.href} target="_blank" rel="noopener noreferrer">
						Open sign-in in your browser <span aria-hidden="true">↗</span>
					</a>
				);
		} catch {
			/* keep the runtime's explanation as text */
		}
	}
	return <span>{text}</span>;
}

function SetupPrompt({
	prompt,
	busy,
	answer,
}: {
	prompt: NonNullable<SetupState["prompt"]>;
	busy: boolean;
	answer: (answer: SetupAnswer) => void;
}) {
	const field = useId();
	const [value, setValue] = useState(prompt.kind === "text" ? prompt.initial : "");
	const [filter, setFilter] = useState("");
	const firstChoice =
		prompt.kind === "select" ? prompt.choices.find((choice) => choice.id === prompt.initial) : undefined;
	const [selected, setSelected] = useState(
		firstChoice?.id ?? (prompt.kind === "select" ? (prompt.choices[0]?.id ?? 0) : 0),
	);
	const focus = useRef<HTMLHeadingElement>(null);
	useEffect(() => {
		focus.current?.focus();
	}, []);
	const choices =
		prompt.kind === "select"
			? prompt.choices.filter((choice) =>
					`${choice.label} ${choice.hint}`.toLocaleLowerCase().includes(filter.toLocaleLowerCase()),
				)
			: [];
	return (
		<form
			className="connection-setup__prompt"
			onSubmit={(event) => {
				event.preventDefault();
				if (busy) return;
				answer(
					prompt.kind === "text"
						? { promptId: prompt.id, action: "text", value }
						: { promptId: prompt.id, action: "select", choice: selected },
				);
				if (prompt.kind === "text" && prompt.mask) setValue("");
			}}
		>
			<h3 ref={focus} tabIndex={-1}>
				{prompt.heading[0] || "Continue setup"}
			</h3>
			{[...new Set(prompt.heading.slice(1))].map((line) => (
				<p key={line}>
					<SetupMessage text={line} />
				</p>
			))}
			{prompt.kind === "text" ? (
				<>
					<label htmlFor={field}>Your answer</label>
					<input
						id={field}
						type={prompt.mask ? "password" : "text"}
						autoComplete="off"
						spellCheck={false}
						maxLength={4096}
						value={value}
						disabled={busy}
						onChange={(event) => setValue(event.target.value)}
						aria-describedby={prompt.hint ? `${field}-hint` : undefined}
					/>
					{prompt.mask && prompt.heading.some((line) => /API key/iu.test(line)) && (
						<p className="connection-setup__hint">Credentials are stored with mode 0600, not encrypted.</p>
					)}
					{prompt.hint && (
						<p id={`${field}-hint`} className="connection-setup__hint">
							{prompt.hint}
						</p>
					)}
				</>
			) : (
				<>
					{prompt.searchable && (
						<label className="connection-setup__filter">
							Find a model or provider
							<input type="search" value={filter} onChange={(event) => setFilter(event.target.value)} />
						</label>
					)}
					<fieldset className="connection-setup__choices" disabled={busy}>
						<legend className="sr-only">Choose an option</legend>
						{choices.map((choice) => (
							<label key={choice.id} className="connection-setup__choice" data-selected={selected === choice.id}>
								<input
									type="radio"
									name={field}
									value={choice.id}
									checked={selected === choice.id}
									onChange={() => setSelected(choice.id)}
								/>
								<span>
									<strong>{choice.label}</strong>
									{choice.hint && <small>{choice.hint}</small>}
								</span>
							</label>
						))}
						{!choices.length && <p>No matching choices. Clear the search to see the list.</p>}
					</fieldset>
				</>
			)}
			<div className="connection-setup__actions">
				<button type="button" disabled={busy} onClick={() => answer({ promptId: prompt.id, action: "back" })}>
					Back
				</button>
				<button
					type="submit"
					className="primary"
					disabled={busy || (prompt.kind === "select" && !choices.some((choice) => choice.id === selected))}
				>
					{busy
						? "Working…"
						: prompt.kind === "select" &&
								/^(Save|Check again)/u.test(prompt.choices.find((choice) => choice.id === selected)?.label ?? "")
							? (prompt.choices.find((choice) => choice.id === selected)?.label ?? "Continue")
							: "Continue"}
				</button>
			</div>
		</form>
	);
}

/** A small browser presentation of the existing configure wizard, without browser-owned config. */
export function ConnectionSetup({
	client,
	targetId,
	compact = false,
	bare = false,
	onSaved,
}: {
	client: Client;
	targetId?: string;
	compact?: boolean;
	/** Inside a first-run step that supplies its own heading and description. */
	bare?: boolean;
	onSaved?: () => void;
}) {
	const queries = useQueryClient();
	const readiness = useSetupStatus(client);
	const [id, setId] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [completed, setCompleted] = useState(false);
	const owned = useRef<string | null>(null);
	const alive = useRef(true);
	const locked = useRef(false);
	const notified = useRef<string | null>(null);
	const state = useQuery({
		queryKey: ["setup", id],
		queryFn: () => client.call(routes.setupState, { ...emptyInput, params: { id: id ?? "" } }),
		enabled: !!id,
		refetchInterval: (query) =>
			query.state.data && ["saved", "cancelled", "failed"].includes(query.state.data.status) ? false : 400,
		refetchIntervalInBackground: false,
	});
	useEffect(() => {
		alive.current = true;
		return () => {
			alive.current = false;
			if (owned.current)
				void client.call(routes.setupCancel, { ...emptyInput, params: { id: owned.current } }).catch(() => {});
		};
	}, [client]);
	useEffect(() => {
		if (state.data?.status !== "saved" || notified.current === state.data.id) return;
		notified.current = state.data.id;
		owned.current = null;
		setCompleted(true);
		for (const key of [
			"setup-status",
			"settings-controls",
			"workspace-settings",
			"config-graph",
			"targets",
			"routing",
			"target-runtimes",
		])
			void queries.invalidateQueries({ queryKey: [key] });
		onSaved?.();
	}, [state.data, queries, onSaved]);
	const request = async (run: () => Promise<SetupState>) => {
		if (locked.current) return;
		locked.current = true;
		setBusy(true);
		setError(null);
		try {
			const next = await run();
			if (!alive.current) {
				if (["working", "prompt"].includes(next.status))
					await client.call(routes.setupCancel, { ...emptyInput, params: { id: next.id } });
				return;
			}
			queries.setQueryData(["setup", next.id], next);
			owned.current = ["working", "prompt"].includes(next.status) ? next.id : null;
			setId(next.id);
			if (["saved", "cancelled", "failed"].includes(next.status))
				void queries.invalidateQueries({ queryKey: ["setup-status"] });
		} catch (problem) {
			if (alive.current) setError(problem instanceof Error ? problem.message : "Setup is unavailable.");
		} finally {
			locked.current = false;
			if (alive.current) setBusy(false);
		}
	};
	const start = () => {
		setCompleted(false);
		void request(() => client.call(routes.setupStart, { ...emptyInput, body: targetId ? { targetId } : {} }));
	};
	const active = state.data && ["working", "prompt"].includes(state.data.status);
	if (targetId && !active)
		return (
			<div className="connection-setup__edit">
				<button type="button" disabled={busy} onClick={start}>
					{busy ? "Opening setup…" : "Repair or edit connection"}
				</button>
				{completed && <p role="status">Connection saved.</p>}
				{state.data?.status === "cancelled" && (
					<p role="status">
						Setup cancelled. Completed browser sign-in remains stored. Check your saved connection before trying again.
					</p>
				)}
				{(error || state.error || state.data?.problem) && (
					<p role="alert">{error ?? state.error?.message ?? state.data?.problem}</p>
				)}
			</div>
		);
	if (compact && !active)
		return (
			<div className="connection-setup__compact">
				<Link to="/settings/targets">
					Connections · Guided setup <span aria-hidden="true">→</span>
				</Link>
			</div>
		);
	return (
		<section
			className={`connection-setup trace-panel${bare ? " connection-setup--bare" : ""}`}
			aria-label={targetId ? "Edit connection" : "Connect a model"}
		>
			<div className="connection-setup__heading" hidden={bare && !active}>
				<div hidden={bare}>
					<p className="eyebrow">Connections / Guided setup</p>
					<h2>
						{targetId
							? "Edit your connection"
							: readiness.data?.state === "ready"
								? "Your model connection"
								: "Connect a model"}
					</h2>
				</div>
				{active && (
					<button
						type="button"
						disabled={busy}
						onClick={() => void request(() => client.call(routes.setupCancel, { ...emptyInput, params: { id: id ?? "" } }))}
					>
						Cancel setup
					</button>
				)}
			</div>
			{!active && (
				<>
					{bare ? null : (
						<p>
							{readiness.data?.targetId
								? `${readiness.data.targetId}${readiness.data.model ? ` · ${readiness.data.model}` : ""}. `
								: ""}
							{readiness.data?.message ?? "Choose the app, subscription, provider, or server you already use."}
						</p>
					)}
					{readiness.error && <p role="alert">Could not read saved setup: {readiness.error.message}</p>}
					{completed && <p role="status">Connection saved. You can open a project and start a conversation.</p>}
					{state.data?.status === "cancelled" && (
						<p role="status">
							Setup cancelled. Completed browser sign-in remains stored. Check your saved connection before trying again.
						</p>
					)}
					<button type="button" className="primary" disabled={busy} onClick={start}>
						{busy
							? "Opening setup…"
							: targetId
								? "Edit connection"
								: readiness.data?.state === "ready"
									? "Add a connection"
									: "Guided setup"}
					</button>
				</>
			)}
			{active && (
				<>
					<details
						className="connection-setup__messages"
						open={state.data?.status === "working" || state.data?.messages.some((message) => /Open: https?:/u.test(message))}
					>
						<summary>Connection details and sign-in</summary>
						<div>
							{[...new Set(state.data?.messages)].map((message) => (
								<p key={message}>
									<SetupMessage text={message} />
								</p>
							))}
						</div>
					</details>
					{state.data?.prompt ? (
						<SetupPrompt
							key={state.data.prompt.id}
							prompt={state.data.prompt}
							busy={busy}
							answer={(answer) =>
								void request(() => client.call(routes.setupAnswer, { params: { id: id ?? "" }, query: {}, body: answer }))
							}
						/>
					) : (
						<p role="status">Checking your connection…</p>
					)}
				</>
			)}
			{error || state.error || state.data?.problem ? (
				<p role="alert">
					{error ?? state.error?.message ?? state.data?.problem}
					<button type="button" onClick={() => void state.refetch()}>
						Refresh setup
					</button>
				</p>
			) : null}
		</section>
	);
}
