FROM ghcr.io/puppeteer/puppeteer:24.38.0

ENV NODE_ENV=production \
    PORT=3000 \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable \
    PUPPETEER_HEADLESS=true \
    PUPPETEER_PROTOCOL_TIMEOUT_MS=120000

USER root
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

RUN mkdir -p /app/.wwebjs_auth /app/.wwebjs_cache /home/pptruser/.cache /home/pptruser/.config \
    && chown -R pptruser:pptruser /app /home/pptruser/.cache /home/pptruser/.config

USER pptruser

EXPOSE 3000

CMD ["node", "index.js"]
