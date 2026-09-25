FROM node:22-alpine AS deps

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force


FROM node:22-alpine AS runtime

ENV NODE_ENV=production \
    PORT=3000 \
    CACHE_DIR=/data/srt

WORKDIR /app

RUN apk add --no-cache tini

COPY --from=deps /app/node_modules ./node_modules
COPY package.json main.js ./

RUN mkdir -p "$CACHE_DIR" && chown -R node:node /app /data

USER node

EXPOSE 3000
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/missing').then(r=>process.exit(r.status===404?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "main.js"]
