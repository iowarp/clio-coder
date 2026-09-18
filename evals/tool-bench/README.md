# Tool bench

Per-tool performance and behavior suites for Clio Coder tools. Each scenario
calls one tool through the same path the agent loop uses and reports latency,
filesystem call count, memory, CPU, and a behavior digest. This directory
holds the `edit` suites; `read`, `write`, `grep`, and `find` come next.

| Path | Role |
| --- | --- |
| `lib/corpus.ts` | Seeded scenario generator and the one scenario table |
| `lib/driver.ts` | Runs one scenario and prints one `clio-coder.eval.measure.v1` line |
| `lib/fs-counter.ts` | Wraps the counted `node:fs` functions |
| `lib/suite-gen.ts` | Writes the suite YAML files from the scenario table |
| `lib/link-deps.sh` | Runner step that links `src` and `node_modules` into the task workspace |
| `edit.yaml`, `edit.holdout.yaml` | Default profile, 22 scenarios, search and holdout splits |
| `edit.full.yaml`, `edit.full.holdout.yaml` | Full profile, 29 scenarios, adds the 100 MB case |

## Run one scenario by hand

```sh
node --import tsx evals/tool-bench/lib/driver.ts --scenario edit.search.size-64k-middle --seed 1 --split search
```

`--warmup <n>` sets the discarded warmup calls (default 3). Stdout carries the
measure line, stderr carries one diagnostic JSON line with the outcome, the
normalized error message, and the per-function `fs` counts. Exit 0 means the
scenario's expected outcome and post-state held.

List or materialize a corpus:

```sh
node --import tsx evals/tool-bench/lib/corpus.ts --seed 1 --split holdout --profile full --out /tmp/edit-corpus
```

## Run a suite against a candidate

Run the pinned release from the candidate checkout and point
`--clio-coder-entry` at the candidate build:

```sh
cd <candidate checkout> && pnpm run build
~/.local/share/clio-coder-0.4.9/node_modules/.bin/clio-coder eval run \
  --suite evals/tool-bench/edit.yaml --trials 5 --out /tmp/edit-search.json \
  --clio-coder-entry "$PWD/dist/cli/index.js"
```

Each scenario is one eval task whose id is the scenario id, because within a
trial the last measure line wins per key. Read `results[].metrics` per trial.

The eval runner copies the workspace for every task, and `--trials` forces
that copy even for a `local` workspace. The suites therefore declare a
`temp-copy` workspace that leaves out `src`, `node_modules`, and everything the
tool path never loads. `lib/link-deps.sh` then links `src` and `node_modules`
from the checkout that holds `CLIO_CODER_ENTRY`, which the eval runner sets to
the `--clio-coder-entry` path. So the suite, corpus, and driver come from the
checkout the suite was loaded from, and the tool source under test comes from
the checkout of the candidate build through the driver's relative import of
`../../../src`. Without `--clio-coder-entry` the entry is the running binary,
and the runner step fails with a message unless that binary sits in a
checkout with `node_modules`.

The copy carries two symlinks the checkout lacks, so `patch.filesChanged` reads
2 on every task. That value describes the harness, not the tool.

## Seed, split, and profile

The suite format has no run-time parameters, and every task id names its
split, so each (split, profile) pair is its own committed file with the seed
written into each measure command. The committed files use seed 1.
Regenerate after editing the scenario table, or to change the seed:

```sh
node --import tsx evals/tool-bench/lib/suite-gen.ts [--seed <int>]
node --import tsx evals/tool-bench/lib/suite-gen.ts --check
```

`tests/contracts/tool-bench-edit.test.ts` fails when a committed suite differs
from the generator output. The two splits draw from separate sfc32 streams
keyed by SHA-256 over the corpus schema, tool, split, seed, and template, and
their scenario ids carry the split name. The same test proves that ids,
scenario content hashes, and file hashes never overlap across splits. Nothing
in the corpus reads the clock, the environment, or `Math.random`.

The default profile keeps one trial under a minute. Most of that time is the
per-task process start: loading the tool registry module graph through tsx
costs about 1.2 s. The full profile adds the 100 MB case and six overlapping
variants and runs past a minute per trial.

## Scenarios

Dimensions covered by the default profile: file size (1 KB, 64 KB, 900 KB,
4 MB, 16 MB; 100 MB in full), line length (0 to 6 characters, 2 to 6 KB, one
256 KB line with no terminator), text (ASCII, multibyte UTF-8, UTF-8 BOM),
line endings (LF, CRLF), edit density (1 to 512 edits in one call), edit
position (head, middle, tail, spread), replacement shape (same length,
multiline growth, deletion), a mode 0755 target, a symlinked target, and the
error paths: missing file, no match, ambiguous match, overlapping edits,
invalid UTF-8, mixed line endings (and a NUL byte in full). Files under 1 MiB
take the tool's fuzzy and diff path; larger files take the exact path.

## Measurement

Each scenario runs in a private scratch root created fresh with `mkdtemp`.
Every warmup call and the measured call get their own fresh copy of the
scenario files, their own freshly built safety contract and registry
(`createWorkerToolRegistry` at autonomy `auto-edit`), and a `chdir` into their
root, since tool paths resolve against `process.cwd()`. The call is
`invokeRegisteredTool`: argument validation, safety admission and autonomy,
before and after hooks, the tool body, and result shaping. A blocked or error
verdict throws; the driver records the error class and message.

| Metric | Meaning |
| --- | --- |
| `custom.latency.wall_ms` | `process.hrtime.bigint()` around the measured `invokeRegisteredTool` call |
| `custom.counters.fs_ops` | Counted `fs` calls during that call; deterministic per revision |
| `custom.memory.max_rss_kb` | `process.resourceUsage().maxRSS` after the call; the process peak, so it includes corpus generation and warmups |
| `custom.cpu.user_ms` | User CPU delta of `process.resourceUsage()` across the call |
| `custom.cpu.system_ms` | System CPU delta across the call |
| `custom.digest.behavior` | SHA-256 over the canonical behavior document below |
| `custom.corpus.seed`, `custom.corpus.holdout` | The seed and split this trial measured |
| `custom.bench.warmup` | Warmup calls discarded before the measured one |
| `task.solved` | From the driver's exit code: expected outcome and post-state held |

The digest hashes canonical JSON (sorted keys) of: the outcome (`ok` or
`error`); the shaped result the model would see; the error class and message
for a thrown verdict; and the scratch-root state as sorted relative paths with
kind, size, SHA-256 of contents, and mode bits, or the target for a symlink.
Before hashing, the scratch root's path (and its realpath) becomes `<scratch>`
in every string, and keys that carry time (`mtimeMs`, `durationMs`,
`timestamp`, and similar) become `<volatile>`. A changed error message
therefore changes the digest, as does any change to the result text, the diff,
or a file byte.

Counted functions are the ones below, wrapped on the module objects before any
tool module loads and pushed into ESM named exports with
`syncBuiltinESMExports`. A call counts once however much I/O it does.

- `node:fs` sync: `accessSync appendFileSync chmodSync chownSync closeSync copyFileSync cpSync existsSync fchmodSync fdatasyncSync fstatSync fsyncSync ftruncateSync futimesSync linkSync lstatSync mkdirSync mkdtempSync openSync opendirSync readFileSync readSync readdirSync readlinkSync readvSync realpathSync renameSync rmSync rmdirSync statSync statfsSync symlinkSync truncateSync unlinkSync utimesSync writeFileSync writeSync writevSync`
- `node:fs` callback: `access appendFile chmod close copyFile cp createReadStream createWriteStream exists fchmod fdatasync fstat fsync ftruncate futimes link lstat mkdir mkdtemp open opendir read readFile readdir readlink readv realpath rename rm rmdir stat statfs symlink truncate unlink utimes watch watchFile write writeFile writev`
- `node:fs/promises`: `access appendFile chmod copyFile cp link lstat mkdir mkdtemp open opendir readFile readdir readlink realpath rename rm rmdir stat statfs symlink truncate unlink utimes writeFile`
- `FileHandle` methods: `appendFile chmod close datasync read readFile readv stat sync truncate utimes write writeFile writev`

What the measurement leaves out: `invokeRegisteredTool` passes no turn id, so
the per-turn observation budget is off; no telemetry sink is attached; the
loop guard starts empty for every call because each call gets a fresh safety
contract; and calls through `realpathSync.native` or `realpath.native` are
not counted, because those properties keep the original functions.

## Tests

- `tests/contracts/tool-bench-edit.test.ts`: corpus determinism, split
  disjointness, suite drift, two in-process runs of every default scenario
  with identical digests and `fs_ops`, a faulty edit and a reworded result
  each changing the digest (through the driver's `replaceTool` seam, not
  `src/tools`), and measure keys that pass the eval channel's admission rules.
- `tests/extended/tool-bench-edit.test.ts`: two separate driver processes per
  default scenario with identical digests and `fs_ops`, and one task through
  `clio-coder eval run` whose sealed artifact carries the driver's digest.
