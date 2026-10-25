# syntax=docker/dockerfile:1

# --- build -----------------------------------------------------------------
FROM node:22-alpine AS builder

WORKDIR /app

# Manifests first so a source-only change does not reinstall the dependency tree.
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund

COPY . .

# Only VITE_-prefixed variables reach the bundle, and none are needed: every
# request goes to a relative path that nginx proxies at runtime.
RUN npm run build

# --- runtime ---------------------------------------------------------------
FROM nginx:1.27-alpine AS runtime

COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf.template /etc/nginx/templates/default.conf.template

# The nginx image renders /etc/nginx/templates/*.template with envsubst on
# start, so this is a substitution default rather than a fixed value.
ENV SL_API_URL=http://api:8000 \
    NGINX_ENVSUBST_TEMPLATE_SUFFIX=.template

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1
