# The operator's GPU worker, containerised so its egress can be bounded.
#
# Node rather than a distroless base: the worker shells out to nothing, but
# `sharp` and `onnxruntime-node` both load prebuilt native binaries and want a
# glibc image. Slim rather than alpine for the same reason, since musl builds of
# those two are the ones that are missing.
FROM node:22-slim

# iptables is the whole point of the image: entrypoint.sh installs the egress
# rules in the container's own network namespace before the worker starts.
# ca-certificates because everything the worker calls is HTTPS.
RUN apt-get update \
  && apt-get install -y --no-install-recommends iptables ca-certificates dnsutils \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first, so a change to the worker source does not reinstall them.
# The native packages are built here rather than copied from the host, where
# they would have been built against a different libc.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Only what the worker actually reaches. `scripts/gpu-worker.ts` imports from
# lib/, and AGENTS.md is explicit that a scan of app/ misses those imports, so
# this copies the three source trees rather than trying to be clever about it.
COPY tsconfig.json ./
COPY lib ./lib
COPY scripts ./scripts
COPY models ./models

COPY deploy/worker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Drops to a non-root user *after* the entrypoint has installed the rules,
# which is the one thing in here that needs privilege.
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["npx", "tsx", "scripts/gpu-worker.ts"]
