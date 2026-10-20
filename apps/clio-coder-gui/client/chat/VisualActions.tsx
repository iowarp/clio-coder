import { useEffect, useId, useRef, useState } from "react";
import { Icon } from "../design/icons.js";
import { Dialog } from "../interaction/Dialog.js";
import type { CommandFields, CommandPlan } from "./command-model.js";
import { planCommand } from "./command-model.js";
import type { SlashEntry } from "./slash-model.js";
import { ACTION_GROUPS, actionLabel, visualActions } from "./visual-actions-model.js";
import type { VisualAction } from "./visual-actions-model.js";
import "./visual-actions.css";

export function VisualActions({
	entries,
	paneAvailable,
	loading,
	error,
	busy,
	onRetry,
	onClose,
	onPick,
	onShowChanges,
	onRun,
}: {
	entries: readonly SlashEntry[];
	paneAvailable: boolean;
	loading: boolean;
	error: string | null;
	busy: boolean;
	onRetry: () => void;
	onClose: () => void;
	onPick: (entry: SlashEntry) => void;
	onShowChanges: () => void;
	onRun: (plan: CommandPlan) => void;
}) {
	const search = useRef<HTMLInputElement>(null);
	const [query, setQuery] = useState("");
	const [selected, setSelected] = useState<VisualAction | null>(null);
	useEffect(() => {
		if (selected === null) search.current?.focus();
	}, [selected]);
	const items = visualActions(entries, query);
	const showChanges =
		paneAvailable &&
		query
			.toLowerCase()
			.trim()
			.split(/\s+/u)
			.every((word) => "changes files review edited touched paths".includes(word));
	return (
		<Dialog
			title="Actions"
			eyebrow="Your conversation, at hand"
			className="visual-actions"
			size="wide"
			initialFocus={search}
			onClose={onClose}
		>
			{selected?.entry.kind === "command" ? (
				<ActionForm
					key={selected.entry.id}
					action={selected}
					entry={selected.entry}
					busy={busy}
					onBack={() => setSelected(null)}
					onRun={onRun}
				/>
			) : (
				<>
					<p className="visual-actions__intro">Ask alongside your work, continue a conversation, or take a closer look.</p>
					<label className="visual-actions__search">
						<Icon name="search" />
						<span className="sr-only">Search actions</span>
						<input
							ref={search}
							type="search"
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							placeholder="Find an action…"
						/>
					</label>
					{loading ? (
						<p className="visual-actions__note" role="status">
							Reading available actions…
						</p>
					) : null}
					{error ? (
						<p className="visual-actions__note" role="alert">
							Some actions could not be loaded. {error}{" "}
							<button type="button" onClick={onRetry}>
								Try again
							</button>
						</p>
					) : null}
					<div className="visual-actions__groups">
						{ACTION_GROUPS.map((group) => {
							const rows = items.filter((item) => item.group === group);
							if (!rows.length && !(group === "Task details" && showChanges)) return null;
							return (
								<section key={group} className="visual-actions__group" aria-label={group}>
									<h3>{group}</h3>
									<div className="visual-actions__rows">
										{rows.map((item) => (
											<button
												type="button"
												className="visual-actions__row"
												key={item.entry.id}
												onClick={() => (item.entry.kind === "command" ? setSelected(item) : onPick(item.entry))}
											>
												<Icon name={item.icon} />
												<span>
													<strong>{item.title}</strong>
													<small>{item.description}</small>
												</span>
												<Icon name="chevronRight" />
											</button>
										))}
										{group === "Task details" && showChanges ? (
											<button type="button" className="visual-actions__row" onClick={onShowChanges}>
												<Icon name="fileDiff" />
												<span>
													<strong>Changes and files</strong>
													<small>Review changed files and paths used in this conversation</small>
												</span>
												<Icon name="chevronRight" />
											</button>
										) : null}
									</div>
								</section>
							);
						})}
						{!loading && !items.length && !showChanges ? (
							<p className="visual-actions__note">
								{query ? "No matching actions. Try another name or description." : "This session has no actions available yet."}
							</p>
						) : null}
					</div>
					<p className="visual-actions__footer">
						<Icon name="compose" /> Your message draft stays in the composer.
					</p>
				</>
			)}
		</Dialog>
	);
}

function ActionForm({
	action,
	entry,
	busy,
	onBack,
	onRun,
}: {
	action: VisualAction;
	entry: Extract<SlashEntry, { kind: "command" }>;
	busy: boolean;
	onBack: () => void;
	onRun: (plan: CommandPlan) => void;
}) {
	const id = useId();
	const back = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		back.current?.focus();
	}, []);
	const [fields, setFields] = useState<CommandFields>(entry.subcommand ? { subcommand: entry.subcommand } : {});
	const [error, setError] = useState<string | null>(null);
	const args = entry.subcommand ? entry.command.args.subcommands?.[entry.subcommand] : entry.command.args;
	const planned = planCommand(entry.command, fields);
	const set = (key: string, value: string | boolean) => {
		setFields((previous) => ({ ...previous, [key]: value }));
		setError(null);
	};
	return (
		<form
			className="visual-actions__form"
			onSubmit={(event) => {
				event.preventDefault();
				if (busy) return;
				if (!planned.plan) {
					setError(planned.error);
					return;
				}
				onRun(planned.plan);
			}}
		>
			<button type="button" className="visual-actions__back" ref={back} onClick={onBack}>
				<Icon name="arrowLeft" /> All actions
			</button>
			<div className="visual-actions__form-heading">
				<Icon name={action.icon} />
				<h3>{action.title}</h3>
			</div>
			<p className="visual-actions__intro">{action.description}</p>
			{(args?.positionals ?? []).map((positional, index) => {
				const key = `pos:${index}`;
				return (
					<label className="visual-actions__field" htmlFor={`${id}-${key}`} key={key}>
						<span>
							{actionLabel(positional.name)}
							{positional.required ? " (required)" : " (optional)"}
						</span>
						{positional.values ? (
							<select
								id={`${id}-${key}`}
								value={String(fields[key] ?? "")}
								required={positional.required}
								onChange={(event) => set(key, event.target.value)}
							>
								<option value="">Choose…</option>
								{positional.values.map((value) => (
									<option key={value} value={value}>
										{actionLabel(value)}
									</option>
								))}
							</select>
						) : (
							<input
								id={`${id}-${key}`}
								value={String(fields[key] ?? "")}
								required={positional.required}
								onChange={(event) => set(key, event.target.value)}
							/>
						)}
					</label>
				);
			})}
			{(args?.flags ?? []).map((flag) => {
				const key = `flag:${flag.name}`;
				return (
					<label
						className={flag.takesValue ? "visual-actions__field" : "visual-actions__check"}
						htmlFor={`${id}-${key}`}
						key={key}
					>
						{flag.takesValue ? (
							<>
								<span>
									{actionLabel(flag.name)} (optional){flag.repeatable ? "; one value per line" : ""}
								</span>
								{flag.repeatable ? (
									<textarea
										id={`${id}-${key}`}
										rows={3}
										value={String(fields[key] ?? "")}
										onChange={(event) => set(key, event.target.value)}
									/>
								) : flag.values ? (
									<select
										id={`${id}-${key}`}
										value={String(fields[key] ?? "")}
										onChange={(event) => set(key, event.target.value)}
									>
										<option value="">Default</option>
										{flag.values.map((value) => (
											<option key={value} value={value}>
												{actionLabel(value)}
											</option>
										))}
									</select>
								) : (
									<input
										id={`${id}-${key}`}
										value={String(fields[key] ?? "")}
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
									onChange={(event) => set(key, event.target.checked)}
								/>
								<span>{actionLabel(flag.name)}</span>
							</>
						)}
					</label>
				);
			})}
			<div className="visual-actions__preview">
				<strong>Ready to run: {action.title}</strong>
				<p>{planned.plan ? "Your message and attachments stay in the composer." : planned.error}</p>
				<dl>
					{Object.entries(fields)
						.filter(([key, value]) => key !== "subcommand" && value !== false && value !== "")
						.map(([key, value]) => {
							const name = key.startsWith("pos:")
								? (args?.positionals?.[Number(key.slice(4))]?.name ?? "Value")
								: key.slice(5);
							return (
								<div key={key}>
									<dt>{actionLabel(name)}</dt>
									<dd>{value === true ? "Yes" : String(value)}</dd>
								</div>
							);
						})}
				</dl>
			</div>
			{error ? <p role="alert">{error}</p> : null}
			{busy ? <p role="status">Wait for the current operation to finish. Your choices are kept here.</p> : null}
			<div className="visual-actions__form-actions">
				<button type="button" onClick={onBack}>
					Back
				</button>
				<button className="visual-actions__run" type="submit" disabled={busy || !planned.plan}>
					<Icon name="play" /> Run action
				</button>
			</div>
		</form>
	);
}
