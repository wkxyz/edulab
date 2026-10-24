FROM node:24-bookworm-slim
WORKDIR /app/services/tutor
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg espeak-ng fonts-noto-cjk ca-certificates python3 python3-sympy && rm -rf /var/lib/apt/lists/*
COPY services/tutor/package.json services/tutor/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund && npx playwright install --with-deps chromium && chmod -R a+rX /ms-playwright
COPY skills /app/skills
COPY services/tutor /app/services/tutor
COPY apps/web /app/apps/web
ENV HOST=0.0.0.0 PORT=8788 TUTOR_DATA_DIR=/data LIVE_ENABLED=false
RUN mkdir /data && chown -R node:node /data /app
USER node
EXPOSE 8788
CMD ["node","--disable-warning=ExperimentalWarning","--env-file-if-exists=.env","server.mjs"]
