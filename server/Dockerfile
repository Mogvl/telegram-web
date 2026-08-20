FROM node:24-alpine

WORKDIR /app

COPY server.js ./

ENV DOWNLOAD_DIR=/data/downloads \
    PORT=9090

EXPOSE 9090

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:9090/health >/dev/null || exit 1

CMD ["node", "server.js"]