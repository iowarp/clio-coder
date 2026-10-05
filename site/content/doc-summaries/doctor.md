## Start with the standard check

Run doctor from your project:

```sh
clio-coder doctor
```

It checks the installation, configured connections, model-list evidence, local worker capacity, and relevant tools. Standard doctor is read-only, uses passive probes, and sends no model generation request. In the terminal, `/doctor` shows the findings in your session.

## Read the findings

| Badge | Meaning |
| --- | --- |
| OK | The check passed |
| INFO | A fact that usually needs no action, such as an HPC compiler that is not on `PATH` |
| WARN | Worth attention; Clio Coder can still work |
| !! | A broken requirement; doctor exits with an error |

A live model list, a cached list, and a provider catalog are distinct evidence. A reachable endpoint does not establish that a model will answer well or call tools. The capacity row reports CPUs and available memory; it does not measure GPU memory or model fit.

## Repair or investigate further

`clio-coder doctor --fix` creates missing directories and template files, makes `settings.yaml` and `credentials.yaml` owner-only, rewrites retired setting values such as `safety.autonomy: auto-edit` and YAML `on` and `off` booleans while keeping your comments, and records fleet preflight results. Plain `doctor` previews the settings rewrite. Version migrations still run through `clio-coder upgrade`.

For a live tool-use probe and validation-contract dry run:

```sh
clio-coder doctor --deep
```

Deep checks send model requests and may consume tokens. Allow more time for a cold local model with `--tools-timeout <seconds>`. Use `--json` for structured findings.

If a connection remains unavailable, follow [troubleshooting](/docs/guide/troubleshooting.html).
