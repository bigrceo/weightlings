FROM node:24-slim
WORKDIR /app
COPY . .
ENV DATA_DIR=/data PORT=8080
EXPOSE 8080
CMD ["node", "server/index.mjs"]
