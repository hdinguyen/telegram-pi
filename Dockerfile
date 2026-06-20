FROM node:22-alpine

WORKDIR /app

# Install pi and required extensions
# ffmpeg + yt-dlp are runtime deps for pi-web-access video/YouTube features
RUN apk add --no-cache curl bash ffmpeg yt-dlp \
    && curl -fsSL https://pi.dev/install.sh | sh

ENV PI_CODING_AGENT_DIR=/app/.pi

# Copy pi settings (declares packages + compaction/retry config), then install packages
COPY settings.json /app/.pi/settings.json
COPY ./init/APPEND_SYSTEM.md /app/.pi/APPEND_SYSTEM.md
RUN pi install npm:pi-web-access

# Install dependencies first to leverage layer caching
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy application source
COPY src ./src

ENV NODE_ENV=production

# Persisted data: SQLite database (group -> session mapping) + session JSONL files.
# Mount this as a volume to keep per-group conversations across restarts.
ENV DATABASE_PATH=/app/data/sessions.db
ENV SESSION_DIR=/app/data/sessions
RUN mkdir -p /app/data/sessions
VOLUME ["/app/data"]

# node:sqlite is built in; it emits an "experimental" warning on Node 22 only.
CMD ["node", "src/index.js"]
