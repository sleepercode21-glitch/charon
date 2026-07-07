FROM node:20-bullseye-slim

ENV NODE_ENV=production \
    PORT=3000 \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    PUPPETEER_HEADLESS=true \
    PUPPETEER_PROTOCOL_TIMEOUT_MS=120000

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        chromium \
        dbus \
        dbus-x11 \
        dumb-init \
        fonts-liberation \
        libappindicator3-1 \
        libasound2 \
        libatk-bridge2.0-0 \
        libatk1.0-0 \
        libcups2 \
        libdbus-1-3 \
        libdrm2 \
        libgbm1 \
        libgtk-3-0 \
        libnspr4 \
        libnss3 \
        libx11-xcb1 \
        libxcomposite1 \
        libxdamage1 \
        libxfixes3 \
        libxrandr2 \
        libxshmfence1 \
        libxtst6 \
        procps \
        xdg-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --chown=node:node package*.json ./
RUN npm ci --omit=dev

COPY --chown=node:node . .

RUN mkdir -p /app/.wwebjs_auth /app/.wwebjs_cache /home/node/.cache /home/node/.config /tmp/chromium-cache /tmp/chrome-user-data \
    && chown -R node:node /app/.wwebjs_auth /app/.wwebjs_cache /home/node/.cache /home/node/.config /tmp/chromium-cache /tmp/chrome-user-data

USER node

EXPOSE 3000

CMD ["dumb-init", "npm", "start"]
