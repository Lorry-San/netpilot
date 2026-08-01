FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production DB_PATH=/data/netpilot.sqlite PORT=8080
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
RUN mkdir -p /data && chown -R node:node /app /data
USER node
EXPOSE 8080
VOLUME ["/data"]
CMD ["node", "src/server.js"]
