# Ships Chromium and its system libs; the tag must match playwright in package.json.
FROM mcr.microsoft.com/playwright:v1.61.1-noble

WORKDIR /app
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

# Chromium refuses to run as root without --no-sandbox; the image ships this user for it.
USER pwuser

EXPOSE 3001
CMD ["node", "src/server.js"]
