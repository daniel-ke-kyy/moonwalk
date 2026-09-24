FROM golang:1.25-bookworm AS ppt-sandbox
WORKDIR /src
COPY server/ppt/linuxSandbox/ ./
RUN CGO_ENABLED=0 go build -mod=readonly -trimpath -o /ppt-sandbox .

FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    libreoffice \
    libreoffice-impress \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    poppler-utils \
    python3 \
    python3-venv \
    git \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --include=dev

COPY . .
COPY --from=ppt-sandbox /ppt-sandbox /usr/local/bin/ppt-sandbox
RUN npm run setup:ppt-planning \
  && .ppt-runtime/venv/bin/python -m pip install playwright==1.58.0 \
  && PLAYWRIGHT_BROWSERS_PATH=/app/.ppt-runtime/browsers .ppt-runtime/venv/bin/python -m playwright install --with-deps chromium --only-shell \
  && chmod 755 /app/.ppt-runtime
ENV PPT_MASTER_SKILL_ROOT=/app/.ppt-runtime/ppt-master/skills/ppt-master \
    PPT_PYTHON=/app/.ppt-runtime/venv/bin/python \
    PPT_BROWSER_ROOT=/app/.ppt-runtime/browsers \
    PPT_LINUX_SANDBOX=/usr/local/bin/ppt-sandbox
RUN npm run build

CMD ["node", "server/ppt/cloudProbe.js"]
