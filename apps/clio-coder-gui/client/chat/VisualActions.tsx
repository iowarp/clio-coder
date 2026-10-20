import { useEffect, useId, useRef, useState } from "react";
import { Icon } from "../design/icons.js";
import { Dialog } from "../interaction/Dialog.js";
import type { CommandFields, CommandPlan } from "./command-model.js";
import { planCommand } from "./command-model.js";
import type { SlashEntry } from "./slash-model.js";
import type { ActionGroup, VisualAction } from "./visual-actions-model.js";
import {
	ACTION_GROUPS,
	actionCategoryRows,
	actionLabel,
	actionWaitsForTurn,
	matchesChanges,
	visualActions,
} from "./visual-actions-model.js";
import "./visual-actions.css";

export function VisualActions({
	entries,
	paneAvailable,
	loading,
	error,
	busy,
	running,
	formDrafts,
	onFormDraft,
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
	running: boolean;
	formDrafts: Readonly<Record<string, CommandFields>>;
	onFormDraft: (id: string, fields: CommandFields) => void;
	onRetry: () => void;
	onClose: () => void;
	onPick: (entry: SlashEntry) => void;
	onShowChanges: () => void;
	onRun: (plan: CommandPlan) => void;
}) {
	const search = useRef<HTMLInputElement>(null);
	const [query, setQuery] = useState("");
	const [selected, setSelected] = useState<VisualAction | null>(null);
	const [category, setCategory] = useState<ActionGroup | "All actions">("All actions");
	useEffect(() => {
		if (selected === null) search.current?.focus();
	}, [selected]);
	const allItems = visualActions(entries, query);
	const items = actionCategoryRows(allItems, category);
	const changesMatch = paneAvailable && matchesChanges(query);
	const showChanges = changesMatch && (category === "All actions" || category === "Task details");

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
					busy={busy || actionWaitsForTurn(selected.entry, running)}
					waitingForTurn={actionWaitsForTurn(selected.entry, running)}
					fields={
						formDrafts[selected.entry.id] ?? (selected.entry.subcommand ? { subcommand: selected.entry.subcommand } : {})
					}
					onFields={(fields) => onFormDraft(selected.entry.id, fields)}
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
							onChange={(event) => {
								setQuery(event.target.value);
								setCategory("All actions");
							}}
							placeholder="Find an action…"
						/>
					</label>
					<nav className="visual-actions__categories" aria-label="Action categories">
						{(["All actions", ...ACTION_GROUPS] as const).map((group) => (
							<button type="button" key={group} aria-pressed={category === group} onClick={() => setCategory(group)}>
								{group}
								<span>
									{actionCategoryRows(allItems, group).length +
										(changesMatch && (group === "All actions" || group === "Task details") ? 1 : 0)}
								</span>
							</button>
						))}
					</nav>
					<p className="visual-actions__results" role="status">
						{items.length + (showChanges ? 1 : 0)} available actions{query.trim() ? ` matching “${query}”` : ""}
					</p>
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
								{query ? "No matching actions. Try another name or description." : "No actions are available in this category."}
								<button
									type="button"
									onClick={() => {
										setQuery("");
										setCategory("All actions");
										search.current?.focus();
									}}
								>
									Show all available actions
								</button>
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
	waitingForTurn,
	fields,
	onFields,
	onBack,
	onRun,
}: {
	action: VisualAction;
	entry: Extract<SlashEntry, { kind: "command" }>;
	busy: boolean;
	waitingForTurn: boolean;
	fields: CommandFields;
	onFields: (fields: CommandFields) => void;
	onBack: () => void;
	onRun: (plan: CommandPlan) => void;
}) {
	const id = useId();
	const form = useRef<HTMLFormElement>(null);
	useEffect(() => {
		(
			form.current?.querySelector<HTMLElement>("input, select, textarea") ?? form.current?.querySelector<HTMLElement>("h3")
		)?.focus();
	}, []);
	const [error, setError] = useState<string | null>(null);
	const args = entry.subcommand ? entry.command.args.subcommands?.[entry.subcommand] : entry.command.args;
	const planned = planCommand(entry.command, fields);
	const set = (key: string, value: string | boolean) => {
		onFields({ ...fields, [key]: value });
		setError(null);
	};
	return (
		<form
			className="visual-actions__form"
			ref={form}
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
			<button type="button" className="visual-actions__back" onClick={onBack}>
				<Icon name="arrowLeft" /> All actions
			</button>
			<div className="visual-actions__form-heading">
				<Icon name={action.icon} />
				<h3 tabIndex={-1}>{action.title}</h3>
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
			{(args?.flags?.length ?? 0) > 0 && (
				<details className="visual-actions__optional">
					<summary>Optional controls · {args?.flags?.length}</summary>
					<div className="visual-actions__optional-fields">
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
					</div>
				</details>
			)}
			<div className="visual-actions__preview" data-ready={!!planned.plan}>
				<strong>{planned.plan ? `Ready: ${action.title}` : "Complete the required fields"}</strong>
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
			{busy ? (
				<p role="status">
					{waitingForTurn
						? "This action starts a prompt. Wait for the current turn to finish; your choices stay here."
						: "Wait for the current operation to finish. Your choices are kept here."}
				</p>
			) : null}
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
