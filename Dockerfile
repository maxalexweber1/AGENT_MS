FROM node:22-alpine
ENV NODE_ENV=production TZ=Europe/Berlin
RUN apk add --no-cache tzdata
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY scripts ./scripts
COPY SKILL.md CLAUDE.md ./
# memory/state/journal/reports live on a volume; the observer lease file too
RUN mkdir -p /app/data /app/reports /root/.midnight-city
VOLUME ["/app/data", "/app/reports", "/root/.midnight-city"]
CMD ["node", "scripts/life.mjs"]
