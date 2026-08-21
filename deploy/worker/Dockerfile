FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends iptables ca-certificates dnsutils \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY tsconfig.json ./
COPY lib ./lib
COPY scripts ./scripts
COPY models ./models

COPY deploy/worker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["npx", "tsx", "scripts/gpu-worker.ts"]
