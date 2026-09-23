import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { memo, useId, useState } from "react";
import { routes } from "../../contracts/routes.js";
import type { CommandDescriptor, CommandRequest } from "../../contracts/steering.js";
import type { Client } from "../api/client.js";
import { StatusMark } from "../design/status.js";
import { type CommandFields, type CommandPlan, commandOptions, planCommand } from "./command-model.js";
import "./command-panel.css";

function Arguments({ command, subcommand }: { command: CommandDescriptor; subcommand: string }) {
	const controlId = useId();
	const args = subcommand ? command.args.subcommands?.[subcommand] : command.args;
	return (
		<>
			{(args?.flags ?? []).map((flag) => (
				<label
					key={flag.name}
					htmlFor={`${controlId}-${flag.name}`}
					className={flag.takesValue ? "command-panel__field" : "command-panel__check"}
				>
					{flag.takesValue ? (
						<>
							{flag.name} {flag.repeatable ? "(one per line)" : ""}
							{flag.values && !flag.repeatable ? (
								<select id={`${controlId}-${flag.name}`} name={`flag:${flag.name}`} defaultValue="">
									<option value="">Not set</option>
									{flag.values.map((value) => (
										<option key={value} value={value}>
											{value}
										</option>
									))}
								</select>
							) : flag.repeatable ? (
								<textarea id={`${controlId}-${flag.name}`} name={`flag:${flag.name}`} rows={2} maxLength={4096} />
							) : (
								<input
									id={`${controlId}-${flag.name}`}
									name={`flag:${flag.name}`}
									maxLength={4096}
									placeholder={flag.valueName ?? "Optional"}
								/>
							)}
						</>
					) : (
						<>
							<input id={`${controlId}-${flag.name}`} type="checkbox" name={`flag:${flag.name}`} /> {flag.name}
						</>
					)}
				</label>
			))}
			{(args?.positionals ?? []).map((positional, index) => (
				<label key={positional.name} htmlFor={`${controlId}-pos-${index}`} className="command-panel__field">
					{positional.name} {positional.required ? "(required)" : "(optional)"}
					{positional.values ? (
						<select id={`${controlId}-pos-${index}`} name={`pos:${index}`} defaultValue="" required={positional.required}>
							<option value="">Choose {positional.name}</option>
							{positional.values.map((value) => (
								<option key={value} value={value}>
									{value}
								</option>
							))}
						</select>
					) : positional.rest ? (
						<textarea
							id={`${controlId}-pos-${index}`}
							name={`pos:${index}`}
							rows={3}
							maxLength={4096}
							required={positional.required}
						/>
					) : (
						<input id={`${controlId}-pos-${index}`} name={`pos:${index}`} maxLength={4096} required={positional.required} />
					)}
				</label>
			))}
			{(args?.flags?.length ?? 0) === 0 && (args?.positionals?.length ?? 0) === 0 ? (
				<p className="command-panel__note">No additional information needed.</p>
			) : null}
			{command.streams ? (
				<p className="command-panel__note">Work starts here; progress continues in the conversation's fleet activity.</p>
			) : null}
			{command.injectsUserTurn ? (
				<p className="command-panel__note">This action may add a user turn to the conversation.</p>
			) : null}
			{command.name === "doctor" ? <p className="command-panel__note">Deep checks may probe a live local model.</p> : null}
		</>
	);
}

/** A deliberately separate instrument: slash commands never become chat prompts or palette navigation. */
export const CommandPanel = memo(function CommandPanel({
	client,
	sessionId,
	sessionOpen,
}: {
	client: Client;
	sessionId: string;
	sessionOpen: boolean;
}) {
	const [expanded, setExpanded] = useState(false);
	const [name, setName] = useState("");
	const [subcommand, setSubcommand] = useState("");
	const [review, setReview] = useState<{ plan: CommandPlan; key: string } | null>(null);
	const [validation, setValidation] = useState<string | null>(null);
	const helpId = useId();
	const queries = useQueryClient();
	const params = { params: { id: sessionId }, query: {}, body: {} };
	const capabilities = useQuery({
		queryKey: ["session-capabilities", sessionId],
		queryFn: () => client.call(routes.sessionCapabilities, params),
		enabled: expanded && sessionOpen,
		staleTime: Number.POSITIVE_INFINITY,
		retry: false,
	});
	const catalog = useQuery({
		queryKey: ["session-commands", sessionId],
		queryFn: () => client.call(routes.sessionCommands, params),
		enabled: expanded && sessionOpen && !!capabilities.data?.commands,
		staleTime: Number.POSITIVE_INFINITY,
		retry: false,
	});
	const options = commandOptions(catalog.data);
	const selected = options.find((command) => command.name === name);
	const invoke = useMutation({
		mutationFn: ({ request, key }: { request: CommandRequest; key: string }) =>
			client.call(routes.invokeSessionCommand, { ...params, body: request }, key),
		onSuccess: () => {
			setReview(null);
			void queries.invalidateQueries({ queryKey: ["session", sessionId] });
		},
	});
	const reset = () => {
		if (invoke.isPending) return;
		setReview(null);
		setValidation(null);
		invoke.reset();
	};
	return (
		<details className="command-panel" onToggle={(event) => setExpanded(event.currentTarget.open)}>
			<summary>Clio Coder commands</summary>
			<p id={helpId} className="command-panel__note">
				Only commands exposed by this session appear here. Review the arguments before sending; commands are not chat
				messages.
			</p>
			{!sessionOpen ? <p>This session is not open. Start or load a session to use commands.</p> : null}
			{sessionOpen && capabilities.isPending ? <p>Checking session capabilities…</p> : null}
			{capabilities.error ? <p role="alert">{capabilities.error.message}</p> : null}
			{sessionOpen && capabilities.data && !capabilities.data.commands ? (
				<p>This Clio Coder session does not expose operator commands.</p>
			) : null}
			{catalog.isPending && capabilities.data?.commands ? <p>Reading commands…</p> : null}
			{catalog.error ? <p role="alert">{catalog.error.message}</p> : null}
			{catalog.data && options.length === 0 ? <p>No commands are available in this session.</p> : null}
			{sessionOpen && options.length > 0 ? (
				<>
					<form
						className="command-panel__form"
						inert={invoke.isPending}
						aria-describedby={helpId}
						onChange={reset}
						onSubmit={(event) => {
							event.preventDefault();
							if (!selected) return;
							const data = new FormData(event.currentTarget);
							const fields: Record<string, string | boolean> = {};
							for (const [key, value] of data) fields[key] = String(value);
							for (const flag of (subcommand ? selected.args.subcommands?.[subcommand] : selected.args)?.flags ?? [])
								if (!flag.takesValue) fields[`flag:${flag.name}`] = data.has(`flag:${flag.name}`);
							const planned = planCommand(selected, fields as CommandFields);
							if (!planned.plan) {
								setValidation(planned.error);
								return;
							}
							setReview({ plan: planned.plan, key: crypto.randomUUID() });
						}}
					>
						<label className="command-panel__field">
							Command
							<select
								value={name}
								onChange={(event) => {
									setName(event.target.value);
									setSubcommand("");
									reset();
								}}
							>
								<option value="">Choose a command</option>
								{options.map((command) => (
									<option key={command.name} value={command.name}>
										/{command.name} — {command.summary}
									</option>
								))}
							</select>
						</label>
						{selected ? (
							<>
								<p className="command-panel__note">
									{selected.summary} · <code>{selected.usage}</code>
								</p>
								{selected.args.subcommands ? (
									<label className="command-panel__field">
										Action
										<select
											name="subcommand"
											value={subcommand}
											onChange={(event) => {
												setSubcommand(event.target.value);
												reset();
											}}
											required={selected.requiresSubcommand}
										>
											<option value="">{selected.requiresSubcommand ? "Choose an action" : "Default action"}</option>
											{Object.keys(selected.args.subcommands).map((action) => (
												<option key={action} value={action}>
													{action} — {selected.subcommandSummaries?.[action] ?? "Available action"}
												</option>
											))}
										</select>
									</label>
								) : null}
								{!selected.requiresSubcommand || subcommand ? (
									<Arguments key={`${name}:${subcommand}`} command={selected} subcommand={subcommand} />
								) : null}
								<button type="submit" disabled={invoke.isPending}>
									Review request
								</button>
							</>
						) : null}
					</form>
					{validation ? <p role="alert">{validation}</p> : null}
					{review ? (
						<div className="command-panel__review">
							<strong>Review before sending</strong>
							<code>{review.plan.description}</code>
							<p>This command runs in the current Clio Coder session. It may change its project or session state.</p>
							<div className="command-panel__actions">
								<button type="button" disabled={invoke.isPending} onClick={() => setReview(null)}>
									Back
								</button>
								<button
									type="button"
									className="primary"
									disabled={invoke.isPending || !sessionOpen}
									onClick={() => invoke.mutate({ request: review.plan.request, key: review.key })}
								>
									{invoke.isPending ? "Sending…" : "Send command"}
								</button>
							</div>
						</div>
					) : null}
					{invoke.error ? <p role="alert">{invoke.error.message}</p> : null}
					{invoke.data ? (
						<div className="command-panel__result" role="status">
							<StatusMark
								tone={
									invoke.data.level === "error"
										? "fail"
										: invoke.data.level === "warn"
											? "warn"
											: invoke.data.level === "success"
												? "success"
												: "neutral"
								}
								label={`Command ${invoke.data.level}`}
							/>
							{invoke.data.lines.length ? (
								// biome-ignore lint/a11y/noNoninteractiveTabindex: the bounded result can scroll horizontally with keyboard arrows.
								<pre tabIndex={0}>{invoke.data.lines.join("\n")}</pre>
							) : (
								<p>Clio Coder returned no lines. Check the conversation for any ongoing work.</p>
							)}
						</div>
					) : null}
				</>
			) : null}
		</details>
	);
});
