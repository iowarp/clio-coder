# Check your installation

Diagnose installation and connection problems with doctor.

## Start with the standard check

Run doctor from your project:

```sh
clio-coder doctor
```

It checks the installation, configured connections, model-list evidence, local worker capacity, and relevant tools. Standard doctor is read-only, uses passive probes, and sends no model generation request. In the terminal, `/doctor` shows the findings in your session.

| Flag | Effect |
| --- | --- |
| `--verbose` | Print every row instead of folding quiet families |
| `--json` | Emit findings as JSON on stdout |
| `--deep` | Add the live tool probe and validation dry run |
| `--tools-timeout <seconds>` | Bound each tool probe; default 120, needs `--deep` |

Doctor exits 0 when no row is an error, 1 when one is, and 2 on a usage error.

## Read the findings

| Badge | Meaning |
| --- | --- |
| OK | The check passed |
| INFO | A fact that usually needs no action, such as an HPC compiler that is not on `PATH` |
| WARN | Worth attention; Clio Coder can still work |
| !! | A broken requirement; doctor exits with an error |

A live model list, a cached list, and a provider catalog are distinct evidence. A reachable endpoint does not establish that a model will answer well or call tools. The capacity row reports CPUs and available memory; it does not measure GPU memory or model fit.

## Common rows and their fix

The first row, `chat`, says whether chat can run and what to run when it cannot.

| Row | Usual cause | Fix |
| --- | --- | --- |
| `settings.yaml` | Invalid keys, named in the row | Edit those keys |
| `credentials` | `credentials.yaml` is missing or not `0600` | `clio-coder doctor --fix` |
| `lifecycle migrations` | Migrations are pending after an update | `clio-coder upgrade` |
| `connection <id>` | Missing credential or no endpoint answer | Check the target and sign-in |
| `model <id>` | The role model is missing from a live list | Pick a listed model |
| `external tool <id>` | A pinned helper is missing | `clio-coder tools install <id>` |

## HPC toolchain rows

`toolchain <name>` rows cover compilers, MPI, `nvcc`, build tools, `python3`, and `sbatch`. An absent tool is `INFO`. It is `WARN` when your validation contract's validators need it, or when a tool's `--version` fails, as with an unconfigured Slurm client.

## Repair or investigate further

`clio-coder doctor --fix` creates missing directories and template files, makes `settings.yaml` and `credentials.yaml` owner-only, rewrites retired setting values such as `safety.autonomy: auto-edit` and YAML `on` and `off` booleans while keeping your comments, and records fleet preflight results. Plain `doctor` previews the settings rewrite. Version migrations still run through `clio-coder upgrade`.

The `shell sandbox` row says whether this host contains your commands and where they may write.

For a live tool-use probe and validation-contract dry run:

```sh
clio-coder doctor --deep
```

Deep checks send model requests and may consume tokens. Allow more time for a cold local model with `--tools-timeout <seconds>`. Use `--json` for structured findings.

A `tools <target>` row is `OK` when the model streamed a valid tool call and `WARN` when the call was malformed or the target did not answer. A `validator <n>` row says whether each validator command would run without an approval ask; nothing is executed. In a session, use `/doctor --deep`.

If a connection remains unavailable, follow [troubleshooting](/docs/guide/troubleshooting.html).
