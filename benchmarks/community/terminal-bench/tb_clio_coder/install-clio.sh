#!/usr/bin/env bash
# Install Clio Coder into a Terminal-Bench task container and point it at the local fleet.
# Sourced by AbstractInstalledAgent.perform_task after setup-env.sh exports CLIO_CODER_* vars.
#
# The harness sources this file inside the recorded tmux pane and appends
# `; tmux wait -S done` to the same command line, so `exit` here would kill the
# operator's shell before that signal ever runs and the harness would block
# forever on a run it already lost. Every failure path returns from a function
# instead, and the one status decision at the bottom returns when sourced and
# exits when the file is executed directly.
set -u

log() { echo "[install-clio] $*"; }
# Failures print the tail of the tool output that produced them. A silenced
# failure reported "Node unavailable and could not be installed" on a container
# whose actual problem was that curl is not installed, which sent a reader to
# look at Node.
log_tail() { [ -s "$1" ] && tail -n "${2:-8}" "$1" | sed 's/^/[install-clio]   /'; }

clio_install() {
  local out=/tmp/install-clio.out

  # 0. A downloader. The terminal-bench core images are Debian slim and ship
  #    neither curl nor wget, and every step below needs one.
  if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
    log "no curl or wget; installing curl"
    if command -v apt-get >/dev/null 2>&1; then
      apt-get update -qq >"$out" 2>&1 && apt-get install -y -qq curl ca-certificates >>"$out" 2>&1
    elif command -v apk >/dev/null 2>&1; then
      apk add --no-cache curl ca-certificates >"$out" 2>&1
    elif command -v dnf >/dev/null 2>&1; then
      dnf install -y -q curl ca-certificates >"$out" 2>&1
    fi
  fi
  if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
    log "no downloader available and curl could not be installed"
    log_tail "$out"
    return 1
  fi

  # 1. Node >= 22 (Clio engine requirement). Debian's own nodejs is older than
  #    that, so the NodeSource setup script is the path even when apt has one.
  if ! command -v node >/dev/null 2>&1; then
    log "installing Node 22"
    if command -v apt-get >/dev/null 2>&1; then
      fetch_to https://deb.nodesource.com/setup_22.x /tmp/nodesource.sh >"$out" 2>&1 &&
        bash /tmp/nodesource.sh >>"$out" 2>&1 &&
        apt-get install -y -qq nodejs >>"$out" 2>&1
    fi
  fi
  if ! command -v node >/dev/null 2>&1; then
    log "Node unavailable and could not be installed"
    log_tail "$out"
    return 1
  fi
  log "node $(node --version)"

  # 2. Clio itself. A tarball URL the container can reach is preferred so a run
  #    measures the working tree rather than the last published release; the npm
  #    registry is the fallback.
  if [ -n "${CLIO_CODER_TARBALL_URL:-}" ]; then
    log "fetching clio tarball from CLIO_CODER_TARBALL_URL"
    if ! fetch_to "$CLIO_CODER_TARBALL_URL" /tmp/clio.tgz >"$out" 2>&1; then
      log "tarball fetch failed: $CLIO_CODER_TARBALL_URL"
      log_tail "$out"
      return 1
    fi
    if ! npm i -g /tmp/clio.tgz >"$out" 2>&1; then
      log "npm install of tarball failed"
      log_tail "$out"
      return 1
    fi
  else
    log "no CLIO_CODER_TARBALL_URL; trying npm registry"
    if ! npm i -g @iowarp/clio-coder >"$out" 2>&1; then
      log "clio install failed: set CLIO_CODER_TARBALL_URL to a reachable npm-pack tarball"
      log_tail "$out"
      return 1
    fi
  fi
  if ! command -v clio-coder >/dev/null 2>&1; then
    log "clio-coder not on PATH after install"
    return 1
  fi
  log "clio-coder $(clio-coder --version 2>/dev/null || echo unknown)"

  # 3. Fleet config pointing at the operator's nodes.
  if [ -z "${CLIO_CODER_MAIN_URL:-}" ] || [ -z "${CLIO_CODER_WORKER_URL:-}" ]; then
    log "CLIO_CODER_MAIN_URL and CLIO_CODER_WORKER_URL must be set for Terminal-Bench runs"
    return 1
  fi
  CLIO_CODER_MAIN_TARGET=${CLIO_CODER_MAIN_TARGET:-local-main}
  CLIO_CODER_WORKER_TARGET=${CLIO_CODER_WORKER_TARGET:-local-worker}
  # Each node's runtime and thinking level travel from the operator's fleet.
  # Hardcoding them described an LM Studio orchestrator as llama.cpp and raised
  # the thinking level the operator had turned off, so the container ran a
  # different fleet than the one being benchmarked.
  CLIO_CODER_MAIN_RUNTIME=${CLIO_CODER_MAIN_RUNTIME:-llamacpp}
  CLIO_CODER_WORKER_RUNTIME=${CLIO_CODER_WORKER_RUNTIME:-lmstudio-native}
  CLIO_CODER_MAIN_THINKING=${CLIO_CODER_MAIN_THINKING:-off}
  CLIO_CODER_WORKER_THINKING=${CLIO_CODER_WORKER_THINKING:-off}
  local main_key_env worker_key_env
  main_key_env=$(key_env_for_runtime "$CLIO_CODER_MAIN_RUNTIME")
  worker_key_env=$(key_env_for_runtime "$CLIO_CODER_WORKER_RUNTIME")
  mkdir -p "$HOME/.config/clio-coder"
  cat > "$HOME/.config/clio-coder/settings.yaml" <<YAML
version: 1
identity: clio
autonomy: ${CLIO_CODER_AUTONOMY:-full-auto}
targets:
  - id: ${CLIO_CODER_MAIN_TARGET}
    runtime: ${CLIO_CODER_MAIN_RUNTIME}
    url: ${CLIO_CODER_MAIN_URL}
    auth:
      apiKeyEnvVar: ${main_key_env}
    wireModels:
      - ${CLIO_CODER_MAIN_MODEL}
    defaultModel: ${CLIO_CODER_MAIN_MODEL}
    gateway: true
  - id: ${CLIO_CODER_WORKER_TARGET}
    runtime: ${CLIO_CODER_WORKER_RUNTIME}
    url: ${CLIO_CODER_WORKER_URL}
    auth:
      apiKeyEnvVar: ${worker_key_env}
    wireModels:
      - ${CLIO_CODER_WORKER_MODEL}
    defaultModel: ${CLIO_CODER_WORKER_MODEL}
    gateway: true
orchestrator:
  target: ${CLIO_CODER_MAIN_TARGET}
  model: ${CLIO_CODER_MAIN_MODEL}
  thinkingLevel: ${CLIO_CODER_MAIN_THINKING}
workers:
  default:
    target: ${CLIO_CODER_WORKER_TARGET}
    model: ${CLIO_CODER_WORKER_MODEL}
    thinkingLevel: ${CLIO_CODER_WORKER_THINKING}
  onPermission: deny
YAML

  # State the freshly written settings describe: doctor creates the data, state,
  # and cache trees so the first turn is not also a first-install.
  clio-coder doctor --fix >/dev/null 2>&1 || true

  # 4. Connectivity preflight so a network-isolated container fails loudly, not
  #    silently. Both nodes are checked: a reachable orchestrator with an
  #    unreachable worker fails only once dispatch starts, which reads as a
  #    mid-episode agent fault.
  probe_url "${CLIO_CODER_MAIN_URL}/v1/models" ||
    log "WARNING: cannot reach fleet main at ${CLIO_CODER_MAIN_URL} from container; runs will fail"
  probe_url "${CLIO_CODER_WORKER_URL}/v1/models" ||
    log "WARNING: cannot reach fleet workers at ${CLIO_CODER_WORKER_URL} from container; dispatch will fail"

  # 5. Deterministic Stage 1 index so code_nav has data immediately.
  clio-coder context index >/dev/null 2>&1 || true
  log "ready"
  return 0
}

key_env_for_runtime() {
  case "$1" in
    lmstudio-native|lmstudio) echo CLIO_CODER_LMSTUDIO_KEY ;;
    *) echo CLIO_CODER_LLAMACPP_KEY ;;
  esac
}

fetch_to() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1" -o "$2"
  else
    wget -q -O "$2" "$1"
  fi
}

probe_url() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsS -m 8 "$1" >/dev/null 2>&1
  else
    wget -q -T 8 -O /dev/null "$1" >/dev/null 2>&1
  fi
}

clio_install
clio_install_status=$?
if [ "$clio_install_status" -ne 0 ]; then
  # Sourced: hand the status back so the harness's `|| echo INSTALL_FAIL_STATUS`
  # fires and the shell survives to signal `tmux wait`. Executed: exit with it.
  (return 0 2>/dev/null) && return "$clio_install_status" || exit "$clio_install_status"
fi
