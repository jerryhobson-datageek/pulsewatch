FROM node:22-alpine

WORKDIR /app

# Copy app files (runtime data lives in /data via volume)
COPY server.js index.html public.html ./

# /data holds config.json, maintenance.json, history.db
ENV DATA_DIR=/data
RUN mkdir -p /data

EXPOSE 3000

CMD ["node", "server.js"]
