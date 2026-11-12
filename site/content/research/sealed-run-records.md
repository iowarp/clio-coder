What would it take to treat an agent run as a scientific record that someone else can check? CLIO Coder already writes a sealed record of each run. Nobody has yet studied what those records can support as evidence, how much two runs of one task differ, or what a reader in another lab would still need.

::: note Open question, described for v0.8.0
The records and commands on this page have shipped. The research use of them is new. No reproducibility study exists yet, so this page has no outcome numbers, and every experiment here is proposed and not yet run. The team, students, and outside researchers are welcome.
:::

## The question

- **Repeatability.** Given the same task, repository, and model, how far apart are the results of repeated runs, and which recorded facts explain the difference?
- **Sufficiency.** What must a shared record contain before an outside reader can judge a claim about a run without re-running it?
- **Method.** Can sealed records carry a controlled comparison between agent configurations well enough to publish?

## What is known so far

These are facts about the design, read from the source at this version. They are not study results.

A finished run writes its settlement, its result object, and an assessment, then seals them. A seal records a SHA-256 hash chain over the journal, plus the size and hash of every journal segment and stored object. `clio-coder telemetry verify` checks all of that using only the scope's own files, so it works on any machine.

**What a seal shows.** The record's files match their manifest and the chain is intact, so damage and partial edits are caught.

**What a seal does not show.** The chain is unkeyed and carries no signature, so someone with the files could write a consistent new record, and a seal cannot say who produced it. Verification also runs nothing. A verified seal says the record is intact, and leaves open whether the agent's work was correct or would come out the same again.

Other parts of the design matter to a researcher:

- Unknowns stay unknown. A missing token count reads as not recorded instead of zero, and a dropped or refused record leaves a gap record behind.
- An assessment keeps trust states separately, including whether a run's claims were grounded in commands that actually ran.
- Sharing has four profiles. `content-free` is the default, `structural` adds structure such as prompt and tool-schema manifests, `report` is structural with target ids anonymized too, for an archive linked from a public issue, and `research` adds content captured under consent.
- A share re-applies secret redaction, and below `research` it keeps only allowlisted fields and anonymizes identities. Redaction is best effort.

## Why it matters

A success rate and a description of the setup leave a reader unable to see what an agent did, what it cost, or which results were lost along the way. A record format that keeps those facts, and says plainly when one is missing, could raise the standard of evidence.

Every other page in this section depends on the answer. A study of decision models, memory, or compaction is only as good as the records behind it, and the variance between repeated runs sets how many episodes such a study needs.

## Directions to work on

**Measure run-to-run variance.** Model output varies, and so does what the agent chooses to read. A baseline spread for rounds, cost, and accepted results on a few task types would give every later study its sample size.

**Decide what provenance needs.** An unkeyed chain suits integrity on your own machine. A shared claim may need more, such as a signature or a published digest. Designing that, and testing whether it is worth its cost, is open work.

**Test what a reader can conclude.** Give someone a `content-free` archive and a claim. Find out which claims they can check, which need `structural` or `research`, and what is still missing.

**Build the analysis layer.** CLIO Coder exposes JSON reads over its journals, and it has no comparison tool. A small script that folds two sets of runs into a paired table would help every study here.

## Use CLIO Coder on it today

::: steps
### Run a task and read its record

```sh
clio-coder run --agent <agent-id> --json "<task>"
clio-coder telemetry inspect --run <run-id> --json
clio-coder telemetry cost --run <run-id> --json
```

`clio-coder agents` lists the agents. For a supported local or OpenAI-compatible runtime, `--temperature` sets the sampler for one run. The JSON stream ends with a result frame, and the run has its own scope.

### Verify it

```sh
clio-coder telemetry verify --run <run-id>
clio-coder fleet verify <run-id> --json
```

`telemetry verify` reports the seal. `fleet verify` also reads the settlement and reports the mismatch kind when a seal fails.

### Share it

```sh
clio-coder telemetry share --run <run-id> --profile content-free --dry-run
clio-coder telemetry share --run <run-id> --profile content-free --out run.tar.gz
clio-coder telemetry verify run.tar.gz
```

Nothing is uploaded. Read the `--dry-run` output before you send an archive to anyone. On another machine, `clio-coder telemetry import run.tar.gz` verifies the archive and places it for reading.

### Capture more, deliberately

```sh
clio-coder telemetry consent --workspace <dir>
```

Set `telemetry.mode: research` and turn on the `telemetry.research` flags you need. Content capture also needs consent for that workspace. Research capture is capped at 256 MiB per session, and a refusal leaves a gap record.
:::

## First experiment

::: note Proposed, not yet run
Nobody has run this protocol. If you do, the spread you measure is the first baseline this project has.
:::

**Measure the spread of one small task.**

::: steps
### Fix the setup

Choose a small repository with a test suite, and a task whose result those tests can accept or reject. Commit the starting state. Fix the model, route, and CLIO Coder version, and write them down.

### Run it ten times

Run the task ten times, each from a clean checkout of the same commit. Pass `--temperature 0` as well if your route supports it, then repeat the set without it if you have the budget.

### Fold the records

For each run, read `telemetry inspect --run <run-id> --json` and `telemetry cost --run <run-id> --json`. Tabulate tool calls, tokens, cost, duration, stop reason, and whether the tests accepted the result. Report the median and the range.

### Check it from outside

Share two runs with `--profile content-free`, then give the archives and your table to a colleague on another machine. Record what they could verify and what they had to take on trust.

### Report it

Open a GitHub issue with the setup, the table, and your colleague's notes. Ten runs is a small sample, so say so.
:::

Needs: any chat route and a repository with tests. A local model server avoids API keys and spend. A second machine is only needed for the last step.

## How to join

Open a GitHub issue on [the repository](https://github.com/iowarp/clio-coder/issues) saying what you want to try, before or after you run it, and read the [contributor guide](https://github.com/iowarp/clio-coder/blob/main/CONTRIBUTING.md) for code changes. Negative results and replications are welcome.

::: limits Boundaries
- A seal shows integrity of the record. It is not proof of correctness, authorship, or repeatability.
- Share profiles reduce what leaves your machine, and redaction is best effort, so read what you are about to share.
- Publish numbers and methods. Do not attach another person's session content without their agreement.
:::

::: next
- [See what a session cost and what a run did](/tutorials/see-what-a-session-cost-and-what-a-run-did.html)
- [Can a small decision model improve an agent's work?](/research/system-one-decisions.html)
- [All open questions](/research.html)
:::
