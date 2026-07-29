# Cloud Run image for the hosted Streamable HTTP MCP server (mcp.jobdatalake.com).
FROM node:20-alpine

WORKDIR /app

# Install deps (incl. devDeps for the TypeScript build).
COPY package*.json ./
RUN npm ci

# Build.
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Drop dev dependencies to slim the runtime image.
RUN npm prune --omit=dev

ENV NODE_ENV=production
# Cloud Run injects PORT (defaults to 8080 locally).
EXPOSE 8080
CMD ["node", "dist/http.js"]
