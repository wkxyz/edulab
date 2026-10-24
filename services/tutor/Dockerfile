FROM node:24-bookworm-slim
WORKDIR /app/services/tutor
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg espeak-ng fonts-noto-cjk ca-certificates && rm -rf /var/lib/apt/lists/*
COPY services/tutor/package.json ./
RUN npm install --ignore-scripts --no-audit --no-fund && npx playwright install --with-deps chromium && chmod -R a+rX /ms-playwright
COPY skills/edu-math-video/lesson /app/skills/edu-math-video/lesson
COPY services/tutor /app/services/tutor
COPY apps/web /app/apps/web
ENV HOST=0.0.0.0 PORT=8788 TUTOR_DATA_DIR=/data LIVE_ENABLED=false
RUN mkdir /data && chown -R node:node /data /app
USER node
EXPOSE 8788
CMD ["node","--disable-warning=ExperimentalWarning","--env-file-if-exists=.env","server.mjs"]
