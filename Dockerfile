# Three images from one file:
#   web     nginx with the built site (docker compose service "web")
#   api     the intake service: queue, review, publish (service "api")
#   worker  Chromium that opens candidates and reports back (service "worker")

ARG NPM_REGISTRY=https://registry.npmjs.org
# Alpine mirror for builds in mainland China, e.g. mirrors.aliyun.com. Empty = official.
ARG APK_MIRROR=

FROM node:24-alpine AS build
ARG NPM_REGISTRY
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm config set registry "$NPM_REGISTRY" \
 && PUPPETEER_SKIP_DOWNLOAD=1 npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM nginx:1.27-alpine AS web
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80

# No third-party packages: node:sqlite and fetch are built in.
FROM node:24-alpine AS api
ENV NODE_ENV=production DATA_DIR=/data
WORKDIR /app
COPY package.json ./
COPY shared ./shared
COPY server ./server
USER node
EXPOSE 3000
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.mjs"]

FROM node:24-alpine AS worker
ARG NPM_REGISTRY
ARG APK_MIRROR
# font-noto-cjk matters: without it every Chinese page is screenshotted as empty boxes.
RUN if [ -n "$APK_MIRROR" ]; then sed -i "s#dl-cdn.alpinelinux.org#$APK_MIRROR#g" /etc/apk/repositories; fi \
 && apk add --no-cache chromium font-noto-cjk font-noto-emoji nss freetype harfbuzz ca-certificates \
      mesa-dri-gallium mesa-egl mesa-gles
# Alpine's Chromium has no SwiftShader; WebGL comes from Mesa's llvmpipe (CHROME_GPU=mesa).
# Without it every 3D work is screenshotted blank.
ENV NODE_ENV=production \
    CHROME_PATH=/usr/bin/chromium-browser \
    CHROME_NO_SANDBOX=1 \
    CHROME_GPU=mesa \
    HOME=/tmp
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm config set registry "$NPM_REGISTRY" \
 && PUPPETEER_SKIP_DOWNLOAD=1 npm ci --omit=dev --no-audit --no-fund
COPY shared ./shared
COPY worker ./worker
USER node
CMD ["node", "worker/index.mjs"]
