FROM node:18-alpine
WORKDIR /app

# Copy package files and install dependencies first (for better caching)
COPY package*.json ./
RUN npm ci --only=production

# Copy application code
COPY app.js db.js jellyfinWebhook.js ./
COPY web ./web

# Create data directory with proper permissions BEFORE switching to node user
# FileStore may create /app/sessions, so we give write permissions to /app
RUN mkdir -p /app/data && \
    chmod -R 777 /app

EXPOSE 8282

USER node

CMD ["node", "app.js"]