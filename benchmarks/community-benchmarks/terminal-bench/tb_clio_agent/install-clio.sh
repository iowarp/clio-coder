#!/usr/bin/env bash
# Install Clio Coder into a Terminal-Bench task container and point it at the local fleet.
# Sourced by AbstractInstalledAgent.perform_task after setup-env.sh exports CLIO_* vars.
set -u

log() { echo "[install-clio] $*"; }

# 1. Node >= 22 (Clio engine requirement).
if ! command -v node >/dev/null 2>&1; then
  log "installing Node 22"
  if command -v apt-get >/dev/null 2>&1; then
    (curl -fsSL https://deb.nodesource.com/setup_22.x | bash -) >/dev/null 2>&1 || true
    apt-get install -y nodejs >/dev/null 2>&1 || true
  fi
fi
if ! command -v node >/dev/null 2>&1; then
  log "Node unavailable and could not be installed"; exit 1
fi
log "node $(node --version)"

# 2. Clio itself. Not on npm: prefer a tarball URL the container can reach.
if [ -n "${CLIO_TARBALL_URL:-}" ]; then
  log "fetching clio tarball from CLIO_TARBALL_URL"
  curl -fsSL "$CLIO_TARBALL_URL" -o /tmp/clio.tgz || { log "tarball fetch failed"; exit 1; }
  npm i -g /tmp/clio.tgz >/dev/null 2>&1 || { log "npm install of tarball failed"; exit 1; }
else
  log "no CLIO_TARBALL_URL; trying npm registry"
  npm i -g @iowarp/clio-coder >/dev/null 2>&1 || {
    log "clio install failed: set CLIO_TARBALL_URL to a reachable npm-pack tarball"; exit 1;
  }
fi
command -v clio >/dev/null 2>&1 || { log "clio not on PATH after install"; exit 1; }
log "clio $(clio --version 2>/dev/null || echo unknown)"

# 3. Fleet config pointing at the operator's nodes.
mkdir -p "$HOME/.config/clio"
cat > "$HOME/.config/clio/settings.yaml" <<YAML
version: 1
identity: clio
autonomy: ${CLIO_AUTONOMY:-full-auto}
targets:
  - id: mini
    runtime: llamacpp
    url: ${CLIO_MAIN_URL}
    auth:
      apiKeyEnvVar: CLIO_LLAMACPP_KEY
    wireModels:
      - ${CLIO_MAIN_MODEL}
    defaultModel: ${CLIO_MAIN_MODEL}
    gateway: true
  - id: dynamo
    runtime: lmstudio-native
    url: ${CLIO_WORKER_URL}
    auth:
      apiKeyEnvVar: CLIO_LMSTUDIO_KEY
    wireModels:
      - ${CLIO_WORKER_MODEL}
    defaultModel: ${CLIO_WORKER_MODEL}
    gateway: true
orchestrator:
  target: mini
  model: ${CLIO_MAIN_MODEL}
  thinkingLevel: low
workers:
  default:
    target: dynamo
    model: ${CLIO_WORKER_MODEL}
    thinkingLevel: low
  onPermission: deny
YAML

# 4. Connectivity preflight so a network-isolated container fails loudly, not silently.
if ! curl -fsS -m 8 "${CLIO_MAIN_URL}/v1/models" >/dev/null 2>&1; then
  log "WARNING: cannot reach fleet main at ${CLIO_MAIN_URL} from container; runs will fail"
fi

# 5. Deterministic Stage 1 index so code_nav has data immediately.
clio context-index >/dev/null 2>&1 || true
log "ready"
