# Derived from DshMarketPlace/dsh-plugin-validator (MIT). See THIRD_PARTY_NOTICES.md.
FROM node:22-bookworm

ARG DSH_VERSION=0.1.1-rc.2
ARG PNPM_VERSION=10.34.5

ENV PNPM_HOME=/usr/local/pnpm \
    PATH=/usr/local/pnpm:$PATH \
    COREPACK_HOME=/usr/local/corepack \
    DSH_HOME=/work/home \
    npm_config_update_notifier=false \
    DSH_TELEMETRY_DISABLED=1

RUN corepack enable \
 && corepack prepare "pnpm@${PNPM_VERSION}" --activate \
 && chmod -R a+rX "$COREPACK_HOME" \
 && npm install -g "@deepseek-ai/dsh@${DSH_VERSION}" --loglevel=error \
 && npm cache clean --force

RUN mkdir -p /work && chown -R node:node /work

COPY --chown=node:node src/probe.mjs /usr/local/bin/probe.mjs

USER node
WORKDIR /work

ENTRYPOINT ["node", "/usr/local/bin/probe.mjs"]
