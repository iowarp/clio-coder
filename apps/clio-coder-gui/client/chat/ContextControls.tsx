import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { routes } from "../../contracts/routes.js";
import type { CommandRequest } from "../../contracts/steering.js";
import type { Client } from "../api/client.js";
import type { CommandFields } from "./command-model.js";
import {
	CONTEXT_FIELD_LABELS,
	CONTEXT_FLAG_LABELS,
	contextActions,
	contextCommand,
	planContextCommand,
} from "./context-controls-model.js";
import "./context-work.css";

/** The Context view hosts only the operations this ACP peer actually offers. */
export function ContextControls({
	client,
	sessionId,
	busy,
	onSettled,
}: {
	client: Client;
	sessionId: string;
	busy: boolean;
	onSettled: () => void;
}) {
	const id = useId();
	const queries = useQueryClient();
	const [selected, setSelected] = useState("");
	const [fields, setFields] = useState<CommandFields>({});
	const [error, setError] = useState<string | null>(null);
	const catalog = useQuery({
		queryKey: ["session-commands", sessionId],
		queryFn: ({ signal }) =>
			client.call(routes.sessionCommands, { params: { id: sessionId }, query: {}, body: {} }, undefined, signal),
		staleTime: 30_000,
		retry: false,
	});
	const command = contextCommand(catalog.data);
	const actions = contextActions(command);
	const action = actions.some((item) => item.key === selected) ? selected : (actions[0]?.key ?? "");
	const args = command?.args.subcommands?.[action];
	const run = useMutation({
		mutationFn: (request: CommandRequest) =>
			client.call(routes.invokeSessionCommand, { params: { id: sessionId }, query: {}, body: request }),
		onSettled: () => {
			onSettled();
			for (const key of ["session-context", "session-usage", "session-artifacts", "session-board", "session-tree"])
				void queries.invalidateQueries({ queryKey: [key, sessionId] });
		},
	});
	const set = (key: string, value: string | boolean) => setFields((previous) => ({ ...previous, [key]: value }));
	const disabled = busy || run.isPending;
	return (
		<details className="drill__section context-controls">
			<summary>Manage context</summary>
			{catalog.isPending ? (
				<p className="drill__note" role="status">
					Reading available actions…
				</p>
			) : null}
			{catalog.error ? (
				<p className="drill__note" role="alert">
					{catalog.error.message}
				</p>
			) : null}
			{!catalog.isPending && !catalog.error && actions.length === 0 ? (
				<p className="drill__note">This task has no context actions available.</p>
			) : null}
			{command && args ? (
				<form
					className="drill__form drill__form--stacked context-controls__form"
					onSubmit={(event) => {
						event.preventDefault();
						if (disabled) return;
						const planned = planContextCommand(command, action, fields);
						if (!planned.plan) {
							setError(planned.error);
							return;
						}
						setError(null);
						run.mutate(planned.plan.request);
					}}
				>
					<label htmlFor={`${id}-action`}>Action</label>
					<select
						id={`${id}-action`}
						value={action}
						disabled={disabled}
						onChange={(event) => {
							setSelected(event.target.value);
							setFields({});
							setError(null);
							run.reset();
						}}
					>
						{actions.map((item) => (
							<option value={item.key} key={item.key}>
								{item.label}
							</option>
						))}
					</select>
					<p className="drill__note">{actions.find((item) => item.key === action)?.summary}</p>
					{action === "init" ? (
						<p className="drill__note">
							Initialize when project context needs work. Existing instructions load when a task opens.
						</p>
					) : null}
					{(args.positionals ?? []).map((positional, index) => {
						const key = `pos:${index}`;
						return (
							<label key={key} htmlFor={`${id}-${key}`} className="context-controls__field">
								<span>{CONTEXT_FIELD_LABELS[positional.name] ?? positional.name}</span>
								{positional.values ? (
									<select
										id={`${id}-${key}`}
										value={String(fields[key] ?? "")}
										disabled={disabled}
										required={positional.required}
										onChange={(event) => set(key, event.target.value)}
									>
										<option value="">Choose…</option>
										{positional.values.map((value) => (
											<option value={value} key={value}>
												{value}
											</option>
										))}
									</select>
								) : positional.rest ? (
									<textarea
										id={`${id}-${key}`}
										value={String(fields[key] ?? "")}
										disabled={disabled}
										required={positional.required}
										rows={3}
										onChange={(event) => set(key, event.target.value)}
									/>
								) : (
									<input
										id={`${id}-${key}`}
										value={String(fields[key] ?? "")}
										disabled={disabled}
										required={positional.required}
										onChange={(event) => set(key, event.target.value)}
									/>
								)}
							</label>
						);
					})}
					{(args.flags ?? [])
						.filter((flag) => flag.name !== "--include-global" || !args.flags?.some((entry) => entry.name === "--global"))
						.map((flag) => {
							const key = `flag:${flag.name}`;
							return (
								<label
									key={key}
									htmlFor={`${id}-${key}`}
									className={flag.takesValue ? "context-controls__field" : "context-controls__check"}
								>
									{flag.takesValue ? (
										<>
											<span>{CONTEXT_FLAG_LABELS[flag.name] ?? flag.name}</span>
											{flag.values ? (
												<select
													id={`${id}-${key}`}
													value={String(fields[key] ?? "")}
													disabled={disabled}
													onChange={(event) => set(key, event.target.value)}
												>
													<option value="">Default</option>
													{flag.values.map((value) => (
														<option value={value} key={value}>
															{value}
														</option>
													))}
												</select>
											) : (
												<input
													id={`${id}-${key}`}
													value={String(fields[key] ?? "")}
													disabled={disabled}
													onChange={(event) => set(key, event.target.value)}
												/>
											)}
										</>
									) : (
										<>
											<input
												id={`${id}-${key}`}
												type="checkbox"
												checked={fields[key] === true}
												disabled={disabled}
												onChange={(event) => set(key, event.target.checked)}
											/>
											<span>{CONTEXT_FLAG_LABELS[flag.name] ?? flag.name}</span>
										</>
									)}
								</label>
							);
						})}
					{action === "reset" ? (
						<p className="drill__note">
							Reset removes generated project context. The handbook is preserved unless “Also remove CLIO-CODER.md” is
							selected.
						</p>
					) : null}
					{fields["flag:--rewrite"] === true ? (
						<p className="context-work__warning">This requests a rewrite of CLIO-CODER.md.</p>
					) : null}
					{error || run.error ? (
						<p role="alert" className="drill__note drill__note--error">
							{error ?? run.error?.message}
						</p>
					) : null}
					<button type="submit" className="drill__btn drill__btn--line" disabled={disabled}>
						{run.isPending ? "Running…" : "Run action"}
					</button>
					{busy ? <p className="drill__note">Wait for the current work to finish before changing context.</p> : null}
					{run.data?.lines.length ? (
						<p className="drill__note" role="status">
							{run.data.lines.join("\n")}
						</p>
					) : null}
				</form>
			) : null}
		</details>
	);
}
