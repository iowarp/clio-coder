## Install without root

The installer brings its own Node.js, so you do not need `module load nodejs` or a system Node. It never uses `sudo` and refuses to run under it.

```sh
curl -fsSL https://coder.iowarp.ai/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"
clio-coder doctor
```

It needs `curl` or `wget`, `tar` with `xz` or `gzip`, and a SHA-256 tool. The runtime and package go under `~/.local/share/clio-coder-install` and the launcher under `~/.local/bin`. Compute nodes that mount the same home directory run the same launcher.

## Old glibc, proxies, and quotas

The installer picks a Node build for the host. Official builds cover Linux with glibc 2.28 or newer, macOS, and Alpine on x64. An unofficial build covers x64 hosts with glibc 2.17 to 2.27, the RHEL and CentOS 7 class. Linux arm64 with an older glibc has no build; use conda-forge Node and npm instead.

Export `https_proxy` before running the installer behind a proxy. A version takes about 190 MB, or 460 MB with `--include-claude-sdk`, and Node adds about 210 MB. On a small home quota, move the install root:

```sh
curl -fsSL https://coder.iowarp.ai/install.sh | sh -s -- --install-dir /project/$USER/clio-coder
```

## Verified downloads

Every Node download is checked against its release `SHASUMS256.txt`, and a mismatch stops the install. When `gpgv` or `gpg` is present, the installer also verifies the OpenPGP signature on official builds. Set `CLIO_CODER_REQUIRE_SIGNATURE=1` to fail when no signature verifies.

## Airgapped sites and your own Node

Point `CLIO_CODER_NODE_MIRROR` at a mirror laid out like nodejs.org/dist, `CLIO_CODER_NODE_UNOFFICIAL_MIRROR` at one for the glibc 2.17 build, and `npm_config_registry` at a registry mirror for the package's dependencies. A Node mirror can be a `file://` URL on a shared filesystem.

If the site already provides Node 22.19 or newer, you can install with its npm instead: `npm install -g @iowarp/clio-coder`. When an older `node` comes first on `PATH`, set `CLIO_CODER_NODE` to the newer binary.

Pick versions with `--version` or `--channel`, and undo an upgrade with `--rollback`. The full guide covers the mirror variables; `sh install.sh --help` lists every option.
