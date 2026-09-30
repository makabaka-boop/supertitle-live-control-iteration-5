# syntax=docker/dockerfile:1

# ---- 构建阶段：编译并产出纯静态产物 ----
FROM node:20-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json vite.config.ts playwright.config.ts index.html ./
COPY src ./src
COPY tests ./tests
RUN npm run build

# ---- 运行阶段：纯静态托管，不联网 ----
FROM nginx:1.27-alpine AS runtime
COPY <<'EOF' /etc/nginx/conf.d/default.conf
server {
    listen 80;
    server_name _;
    root /usr/share/nginx/html;
    index index.html;

    # 单页应用：哈希路由无需 fallback，任何未知路径仍回 index。
    location / {
        try_files $uri $uri/ /index.html;
    }
}
EOF
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=10s --timeout=3s CMD wget -qO- http://127.0.0.1/ >/dev/null 2>&1 || exit 1

# ---- 校验阶段：Vitest + Playwright 多页面验收 ----
FROM build AS verify
# Chromium 运行所需系统库。
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       libnspr4 libnss3 libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0 \
       libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 \
       libxfixes3 libxrandr2 libgbm1 libasound2 libpango-1.0-0 \
       libcairo2 libatspi2.0-0 \
    && rm -rf /var/lib/apt/lists/*
RUN npx playwright install --with-deps chromium

# preview / e2e 需要 dist（已在 build 阶段产出）；默认入口跑全部校验。
CMD ["sh", "-c", "npm run test:unit && npm run test:e2e"]
