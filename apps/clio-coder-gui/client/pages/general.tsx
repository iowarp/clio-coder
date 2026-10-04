import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { routes } from "../../contracts/routes.js";
import { type Client, emptyInput } from "../api/client.js";
import { THEME_COLORS } from "../design/navigation.js";
import { AppPreferencesPanel } from "../design/pwa.js";
import { KEYBINDINGS } from "../interaction/keybindings.js";
import { chordHint } from "../shell/chords.js";
import { useShell } from "../shell/shell-context.js";
import { setThemeChoice, type ThemeChoice, useTheme } from "../shell/theme.js";
import "./general.css";

const THEME_CHOICES: readonly { id: ThemeChoice; label: string; hint: string }[] = [
	{ id: "system", label: "System", hint: "Follow this device" },
	{ id: "light", label: "Light", hint: "Warm paper" },
	{ id: "dark", label: "Dark", hint: "Black ground" },
];

const SHORTCUTS = [
	"newTask",
	"openWorkspace",
	"palette",
	"sidebar",
	"focusComposer",
	"sessionPanel",
	"cancelTurn",
] as const;

export function GeneralPage({ client }: { client: Client }) {
	const shell = useShell();
	const theme = useTheme();
	const meta = useQuery({ queryKey: ["meta"], queryFn: () => client.call(routes.meta, emptyInput) });
	return (
		<section className="general">
			<div className="panel-heading">
				<div>
					<h1>General</h1>
				</div>
			</div>

			<section className="general__block" aria-labelledby="general-appearance">
				<div className="general__label">
					<h2 id="general-appearance">Appearance</h2>
					<p>Choose how Clio Coder looks. System follows your device and changes with it.</p>
				</div>
				<div className="general__control">
					<div className="theme-choice" role="radiogroup" aria-labelledby="general-appearance">
						{THEME_CHOICES.map((choice) => (
							<label key={choice.id}>
								<input
									type="radio"
									name="theme"
									className="sr-only"
									checked={theme.choice === choice.id}
									onChange={() => setThemeChoice(choice.id)}
								/>
								<span
									className="theme-choice__swatch"
									aria-hidden="true"
									style={{
										background:
											choice.id === "system"
												? `linear-gradient(135deg, ${THEME_COLORS.light} 50%, ${THEME_COLORS.dark} 50%)`
												: THEME_COLORS[choice.id],
									}}
								/>
								<strong>{choice.label}</strong>
								<small>{choice.hint}</small>
							</label>
						))}
					</div>
				</div>
			</section>

			<section className="general__block" aria-labelledby="general-models">
				<div className="general__label">
					<h2 id="general-models">Models</h2>
					<p>Connections, credentials and which model answers by default.</p>
				</div>
				<div className="general__control">
					<Link className="general__link" to="/settings/targets">
						Manage models and connections <span aria-hidden="true">→</span>
					</Link>
				</div>
			</section>

			<section className="general__block" aria-labelledby="general-keys">
				<div className="general__label">
					<h2 id="general-keys">Keyboard</h2>
					<p>Every shortcut is also in the command palette.</p>
				</div>
				<div className="general__control">
					<dl className="shortcut-list">
						{SHORTCUTS.map((id) => (
							<div key={id}>
								<dt>{KEYBINDINGS[id].action}</dt>
								<dd>
									<kbd>{chordHint(id)}</kbd>
								</dd>
							</div>
						))}
					</dl>
					<button type="button" onClick={() => shell?.openHelp()}>
						Open the full reference
					</button>
				</div>
			</section>

			<section className="general__block" aria-labelledby="general-app">
				<div className="general__label">
					<h2 id="general-app">This app</h2>
					<p>Version, installation and this browser's connection.</p>
				</div>
				<div className="general__control">
					<AppPreferencesPanel
						desktopManaged={meta.data?.desktopManaged ?? false}
						enabled={meta.data?.pwa ?? false}
						version={meta.data?.clio}
						platform={meta.data?.platform}
					/>
				</div>
			</section>
		</section>
	);
}
