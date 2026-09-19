FROM oven/bun:1.4.0-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
ENV NODE_ENV=production
EXPOSE 3000
CMD ["bun", "src/server.js"]
