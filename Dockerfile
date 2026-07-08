FROM node:20-bullseye-slim

ENV NODE_ENV=production \
    PORT=3000 \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    PUPPETEER_HEADLESS=false \
    PUPPETEER_PROTOCOL_TIMEOUT_MS=120000

USER root
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        chromium \
        dbus \
        dumb-init \
        fonts-liberation \
        libasound2 \
        libatk-bridge2.0-0 \
        libatk1.0-0 \
        libcairo2 \
        libcups2 \
        libdbus-1-3 \
        libdrm2 \
        libexpat1 \
        libgbm1 \
        libglib2.0-0 \
        libgtk-3-0 \
        libnspr4 \
        libnss3 \
        libpango-1.0-0 \
        libx11-6 \
        libx11-xcb1 \
        libxcb1 \
        libxcomposite1 \
        libxdamage1 \
        libxext6 \
        libxfixes3 \
        libxkbcommon0 \
        libxrandr2 \
        libxss1 \
        libxtst6 \
        xauth \
        xvfb \
        xdg-utils \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd -r pptruser \
    && useradd -r -g pptruser -G audio,video -m -d /home/pptruser pptruser

COPY --chown=pptruser:pptruser package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=pptruser:pptruser . .

RUN mkdir -p /app/.wwebjs_auth /app/.wwebjs_cache /home/pptruser/.cache /home/pptruser/.config /tmp/chromium-cache /tmp/chrome-user-data \
    && chown -R pptruser:pptruser /app /home/pptruser/.cache /home/pptruser/.config /tmp/chromium-cache /tmp/chrome-user-data

USER pptruser

EXPOSE 3000

CMD ["dumb-init", "--", "dbus-run-session", "--", "xvfb-run", "-a", "--server-args=-screen 0 1280x720x24 -ac +extension RANDR", "node", "index.js"]
