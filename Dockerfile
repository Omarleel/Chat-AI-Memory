FROM node:26-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --chown=node:node package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY --chown=node:node src ./src
COPY --chown=node:node examples ./examples
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "src/main.mjs"]
