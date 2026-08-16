# Containerising the GPU worker (spec §3.3.1)

Optional. `WORKER_ALLOWED_IPS` is not; see SETUP.md.

## What this is for

`scripts/gpu-worker.ts` runs on the operator's machine, polls the deployed app
for jobs, and calls Ollama on localhost. It only ever dials out, so there is no
inbound port to close. What it does have is unrestricted outbound access to
everything else on the machine and everything else on the internet, which is
what spec §3.3.1 asks to bound: the worker handles other people's worksheet
pages, and the fewer places it can send them the better.

The files here deny it everything except the three destinations it needs:

- the deployed app (`NEXT_PUBLIC_APP_URL`), for claiming jobs and posting results
- Ollama, reached over the host gateway rather than the internet
- DNS, so the first of those can be resolved

## Honest status

**This has not been run.** It was written against the worker's actual imports
and the compose networking model, and it is the shape spec §3.3.1 describes, but
nobody has started it: the machine this was authored on has no GPU, no Ollama
and no Docker daemon. Treat it as a starting point that needs one real run
before it is trusted, not as a tested artifact.

Two things most likely to need adjusting on a real machine:

- **`sharp` and `onnxruntime-node`** ship prebuilt native binaries per platform.
  The Dockerfile installs them inside the image so they match the image's libc,
  which is why it does not just copy `node_modules` in.
- **The egress rules** are enforced by an `iptables` chain in the container's own
  network namespace, which needs `NET_ADMIN`. On a host with a restrictive
  Docker setup that capability may be refused, in which case the same effect
  belongs in the host firewall or in the Tailscale ACL instead.

## Use

```bash
cp .env.local deploy/worker/.env      # the worker reads the same variables
cd deploy/worker
docker compose up --build
```

## Hiding the operator's home address

Separate concern, same section of the spec. The container above bounds *where*
the worker can talk; it does nothing about *what address* the app sees it from.
For that, run a Tailscale exit node on a cheap VPS, route the container's egress
through it, and set `WORKER_ALLOWED_IPS` to the VPS address so a stolen
`WORKER_API_TOKEN` is useless from anywhere else.

That is a deployment decision with a monthly cost attached and is deliberately
left to the operator rather than scripted here.
