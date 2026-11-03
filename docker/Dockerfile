# Imagem única usada pelos dois serviços (bridge e agent).
FROM node:22.21.1-bookworm-slim

ARG INSTALL_BROWSER=1
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers \
    NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git curl ripgrep procps \
 && rm -rf /var/lib/apt/lists/*

# Opcional: CAs extras (ex.: proxy corporativo com inspeção TLS). Coloque arquivos *.crt em docker/certs/.
COPY docker/certs/ /usr/local/share/ca-certificates/extra/
RUN update-ca-certificates >/dev/null 2>&1 || true
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt

WORKDIR /opt/poc
COPY package.json package-lock.json ./
RUN npm ci --no-audit \
 && if [ "$INSTALL_BROWSER" = "1" ]; then \
      ./node_modules/.bin/playwright install --with-deps chromium && rm -rf /var/lib/apt/lists/*; \
    fi

COPY bridge ./bridge
COPY scripts ./scripts
COPY mock ./mock

RUN mkdir -p /opt/poc/logs /codex-home /workspace && chown node:node /opt/poc/logs /codex-home /workspace
USER node
