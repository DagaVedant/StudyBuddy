# Containerised GPU worker

Optional. `WORKER_ALLOWED_IPS` is not; see the root README.

`scripts/gpu-worker.ts` runs on the operator's machine, polls the deployed app
for jobs and calls Ollama on localhost. It dials out only. These files restrict
its outbound access to the three destinations it needs:

- the deployed app (`NEXT_PUBLIC_APP_URL`), for claiming jobs and posting results
- Ollama, over the host gateway
- DNS

## Status

Untested. This is written against the worker's imports and the compose
networking model but has never been run on a machine with a GPU, Ollama and a
Docker daemon. Verify it before relying on it.

Two areas most likely to need adjustment:

- `sharp` and `onnxruntime-node` ship per-platform prebuilt binaries. The
  Dockerfile installs them inside the image so they match the image's libc
  rather than copying `node_modules` in.
- Egress rules are enforced by an `iptables` chain in the container's network
  namespace and require `NET_ADMIN`. Where that capability is refused, apply the
  same restrictions in the host firewall or the Tailscale ACL.

## Use

```bash
cp .env.local deploy/worker/.env
cd deploy/worker
docker compose up --build
```

## Egress address

The container bounds where the worker can connect, not what address the app sees
it from. To fix the source address, run a Tailscale exit node on a VPS, route
the container's egress through it, and set `WORKER_ALLOWED_IPS` to the VPS
address so a stolen `WORKER_API_TOKEN` cannot be used elsewhere. This carries a
monthly cost and is left to the operator.
