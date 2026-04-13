# Build stage
FROM node:22-alpine AS builder

WORKDIR /app

# Install build dependencies for better-sqlite3
RUN apk add --no-cache python3 make g++

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

# Production stage
FROM node:22-alpine

WORKDIR /app

# Install runtime dependencies for better-sqlite3
RUN apk add --no-cache python3 make g++ ripgrep

# Pinned Claude CLI version — the stream-json format is undocumented and
# may drift between releases. Update in lockstep with EXPECTED_CLAUDE_VERSION
# in server/src/index.ts.
ARG CLAUDE_CLI_VERSION=2.1.104
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CLI_VERSION} \
    && npm cache clean --force

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --omit=dev && npm cache clean --force

# Copy built files
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src/db/schema.sql ./dist/db/schema.sql

# Create data + account-home directories
RUN mkdir -p /app/data /app/data/accounts

# Set environment variables
ENV NODE_ENV=production
ENV PORT=8082
ENV DATABASE_PATH=/app/data/opium.db
ENV OPIUM_HOME_ROOT=/app/data/accounts
ENV CLAUDE_BIN=/usr/local/bin/claude

# Expose port
EXPOSE 8082

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8082/health || exit 1

# Run the server
CMD ["node", "dist/index.js"]
