# Semantic context

Search your project by meaning with a local embedding route.

## What it does

Semantic context is a beta local search index for code maps, wiki pages, approved memory, authorized evidence, recorded worker output, and folders you register. It uses a separate embedding target. It starts disabled, and ordinary startup scans and embeds nothing until you configure it.

## Set it up and search

Create a target for an embedding route you already run. Clio Coder does not start a server for it. Then configure, refresh, and search:

```sh
clio-coder semantic configure --help
clio-coder semantic inbox preview ./experiment-data
clio-coder semantic inbox add ./experiment-data --id experiments
clio-coder semantic refresh
clio-coder semantic status
clio-coder semantic search "Which run produced the delayed oscillation?" --limit 5
```

`--qualify` checks that a route accepts requests and returns vectors of the right shape. It does not check retrieval quality. A result is a candidate to read, and it does not prove anything by itself.

Follow [the tutorial](/tutorials/semantic-context-and-recordings.html) for a full walkthrough.
