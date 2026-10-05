# HPC Clusters

Clio Coder needs Node.js 22.19 or newer. Cluster login nodes often offer Node 18
or 20 through `module load nodejs`, run an old glibc (RHEL and CentOS 7 ship
2.17, while official Node 22 and 24 builds need 2.28), sit behind a proxy, or
have no internet at all. The installer handles each of these without root.

## Install on a login node

```bash
curl -fsSL https://coder.iowarp.ai/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"
clio-coder doctor
```

If coder.iowarp.ai is unreachable from the cluster, fetch the same script from the
latest GitHub release:
`https://github.com/iowarp/clio-coder/releases/latest/download/install.sh`.

The script (`scripts/install.sh`) is POSIX sh and needs `curl` or `wget`, `tar`
with `xz` or `gzip`, and a SHA-256 tool (`sha256sum`, `shasum` or `openssl`). It
never uses `module load`, the system `node`, or `sudo`, and it refuses to run
under `sudo` because that would install into root's home. It picks a Node build
for the host:

| Host | Node build |
| --- | --- |
| Linux x64 or arm64, glibc 2.28 or newer (a glibc host that also carries the musl loader, as Debian's `musl` package installs, still gets this build) | Official `linux-x64` or `linux-arm64` from nodejs.org |
| Linux x64, glibc 2.17 to 2.27 (RHEL/CentOS 7 class) | Unofficial `linux-x64-glibc-217` from unofficial-builds.nodejs.org |
| Linux on musl (Alpine) | `linux-x64-musl` (official) or `linux-arm64-musl` (unofficial) |
| macOS arm64 or x64 | Official `darwin-arm64` or `darwin-x64` |
| Linux arm64 with glibc older than 2.28 | None exists; use conda-forge `nodejs` and `npm install -g @iowarp/clio-coder` with it |

`CLIO_CODER_NODE_BUILD` forces a build when detection is wrong, for example
`CLIO_CODER_NODE_BUILD=linux-x64-glibc-217` on a node whose `getconf` reports a
newer glibc than its compute nodes run.

Everything lands in your home directory: the runtime and package versions under
`~/.local/share/clio-coder-install` (or `--install-dir`), and the launcher in
`~/.local/bin`. A version takes about 460 MB with the Claude Agent SDK, roughly
half of it the SDK binary; the installer skips the SDK unless `--include-claude-sdk`
is passed, and Node adds about 210 MB. The installer refuses to start with under
about 732 MB free at the install root. On a small home quota, put the install root
on a project filesystem with `--install-dir /project/$USER/clio-coder` and keep the
launcher in `~/.local/bin`. Compute nodes that mount the same home directory run
the same launcher. `--dry-run` prints the plan without downloading anything. The
full flag list is in [Installer options](installation-and-lifecycle.md).

Shell startup files are edited only when you pass `--modify-path`; otherwise
the installer prints the `export PATH=...` line to add yourself.

## How downloads are verified

Every Node download is checked against `SHASUMS256.txt` from the same release,
and a mismatch stops the install. For official builds, the script also checks the
OpenPGP signature on `SHASUMS256.txt.asc` against the Node.js release team's
keys, fetched from the `nodejs/release-keys` repository rather than from the
download host, when `gpgv` or `gpg` is present. A bad signature stops the
install. An unavailable keyring or missing `gpg` is reported, and the install
continues on the checksum alone unless `CLIO_CODER_REQUIRE_SIGNATURE=1` is set.
unofficial-builds.nodejs.org publishes no signatures, so the glibc-2.17 and musl
arm64 builds are verified by checksum over HTTPS only.

The npm package itself is fetched and checked by npm against the registry's
integrity hashes, like any npm install.

## Proxies

`curl`, `wget` and npm all read `https_proxy` and `http_proxy` (and npm also
reads `HTTPS_PROXY`). Export them before running the installer:

```bash
export https_proxy=http://proxy.example.org:3128 http_proxy=$https_proxy
curl -fsSL https://coder.iowarp.ai/install.sh | sh
```

## Airgapped and mirrored sites

Point the installer at mirrors laid out like the upstream directories. A
`file://` URL works for a mirror on a shared filesystem:

| Variable | Purpose |
| --- | --- |
| `CLIO_CODER_NODE_MIRROR` | Base URL laid out like `https://nodejs.org/dist` (`index.tab`, `v<ver>/node-v<ver>-<build>.tar.xz`, `SHASUMS256.txt`, `SHASUMS256.txt.asc`) |
| `CLIO_CODER_NODE_UNOFFICIAL_MIRROR` | The same for unofficial-builds.nodejs.org |
| `CLIO_CODER_NODE_KEYRING` | A local copy of the release keyring (`gpg-only-active-keys/pubring.kbx` from `nodejs/release-keys`) |
| `CLIO_CODER_NODE_TARBALL` | One Node tarball by path, with its `SHASUMS256.txt` next to it or named by `CLIO_CODER_NODE_SHASUMS` |
| `CLIO_CODER_PACKAGE` | A local `npm pack` tarball of `@iowarp/clio-coder` |
| `npm_config_registry` | An npm registry mirror (Artifactory, Nexus, Verdaccio) for the package's dependencies |

A local package tarball still needs its dependencies from a registry, so a fully
offline site needs a registry mirror as well as the Node mirror. Without one,
npm waits on its retries and then fails.

The script itself fails closed on a bad signature or checksum, so a mirror that
serves a modified file is refused rather than installed.

## Choosing versions

| Option | Effect |
| --- | --- |
| `--version 0.6.0` or `CLIO_CODER_VERSION` | Install that Clio Coder version or dist-tag |
| `--channel beta` or `CLIO_CODER_CHANNEL` | Follow a release channel (`latest`, `beta`, `dev`) |
| `--node-version 24` or `CLIO_CODER_NODE_VERSION` | Install the newest Node of a major, or an exact version |
| `--refresh-runtime` | Download Node again even when the wanted one is present |
| `--rollback` | Point the launcher back at the previous installed version |

An exact version such as `--version 0.6.0` pins the install: `clio-coder upgrade`
and background updates leave it there, and `--version latest` (or `beta`, `dev`)
releases the pin. `--rollback` moves a pin to the version it restores. The
[installation guide](installation-and-lifecycle.md) has the details.

`clio-coder upgrade` installs the next version beside the current one and keeps
the managed Node unless you pass `--refresh-runtime`.
`clio-coder uninstall --remove-binary` removes the launcher, the runtime and
every installed version.

## Using a Node you already have

If the site provides Node 22.19 or newer somewhere other than the default `PATH`,
for example a module whose `node` you cannot put first, point Clio Coder at it:

```bash
export CLIO_CODER_NODE=/path/to/node22/bin/node
clio-coder --version
```

The package's `clio-coder` command checks the Node before loading anything else.
When `CLIO_CODER_NODE` is set and names a different binary, it reruns itself
under that Node. Otherwise, on an older Node, it prints the installer command and
these options, naming the glibc limit when the host's glibc is older than 2.28.

## Checking the login node

`clio-coder doctor` reports a `toolchain <name>` row for the compilers, MPI
launchers, build systems, `python3` and `sbatch` it finds on `PATH`, so a login
node can be inspected before a workspace validation contract names any of them
([Doctor](doctor.md)). Slurm access through the clio-kit MCP server is covered in
[Slurm](slurm.md).
