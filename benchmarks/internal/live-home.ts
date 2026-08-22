/**
 * Prepare a scratch Clio home for an interactive run and print its path.
 *
 * For an agent or operator who wants the real TUI in a tmux or herdr pane
 * rather than a scripted drive: the same isolation the other drivers use
 * (one configured target copied into a throwaway home, one credential entry
 * for the run only), plus a launcher, `<home>/clio`, that starts the built
 * binary with the run's environment and nothing else from the shell that
 * runs it. The credential variables the run needs are read from that shell
 * by name at start; they are never written to disk or to history.
 *
 * This is the one tree that keeps its credentials after the command returns,
 * because the pane has not started yet. Its lease (default 12h, `--lease`)
 * bounds that: the launcher refuses to start once it has expired, any driver
 * that starts after it expires scrubs and removes the tree, and `--release`
 * does so now. Release the home when the pane is done; do not leave it to
 * the sweep.
 *
 *   HOME_DIR=$(npm run -s live:home -- --target <id>)
 *   "$HOME_DIR/clio"                    # the TUI, isolated
 *   npm run -s live:home -- --release "$HOME_DIR"
 *
 * stdout is the home path and nothing else, so it can be captured. Details
 * go to stderr.
 */
import {
	LiveUsageError,
	parseLiveArgs,
	prepareLiveHome,
	rejectUnknown,
	releaseLiveHome,
	runDriver,
} from "./live-target.js";

const USAGE = `usage: npm run -s live:home -- --target <id> [--model <wireId>] [--thinking <level>] [--lease <duration>] [--pass-env <NAME>]...
       npm run -s live:home -- --release <dir>

Makes a throwaway Clio home holding only the chosen target and its one credential
entry, and prints its path. Start Clio with <dir>/clio; it passes only the run's
environment through. The tree keeps its credentials until you release it or its
lease expires (default 12h).
`;

await runDriver(USAGE, async () => {
	const argv = process.argv.slice(2);
	const releaseIndex = argv.indexOf("--release");
	if (releaseIndex !== -1) {
		const dir = argv[releaseIndex + 1];
		if (!dir) throw new LiveUsageError("--release needs a directory");
		if (argv.length !== 2) throw new LiveUsageError("--release takes no other arguments");
		releaseLiveHome(dir);
		process.stderr.write(`released ${dir}\n`);
		return true;
	}
	const args = parseLiveArgs(argv);
	rejectUnknown(args.rest);
	const home = prepareLiveHome(
		{ ...args, keep: true },
		{ prefix: "clio-live-home-", autonomy: "full-auto", retainSecrets: true, launcher: true },
	);
	process.stderr.write(
		[
			`live home: ${home.dir}`,
			`  target=${home.target.id} model=${home.model} thinking=${home.thinking}`,
			`  launch:  ${home.launcher}`,
			`  state:   ${home.stateDir}`,
			`  credential env vars read from the launching shell: ${home.authEnvNames.join(" ") || "(none)"}`,
			`  lease expires ${home.lease.expiresAt}; release when done:`,
			`    npm run -s live:home -- --release ${JSON.stringify(home.dir)}`,
			"",
		].join("\n"),
	);
	process.stdout.write(`${home.dir}\n`);
	return true;
});
