# Build stage
FROM --platform=linux/amd64 node:12-alpine AS build

WORKDIR /app
COPY ab-bot/package*.json ./
RUN npm install

COPY ab-bot/ .
RUN npm run build

# Run stage
FROM node:12-alpine

WORKDIR /app

# Copy built files and dependencies
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package*.json ./
COPY start-bots.sh ./

# Make the start script executable
RUN chmod +x start-bots.sh

# If your bot needs any additional system dependencies, add them here
# RUN apk add --no-cache something

ENV NODE_ENV=production

# Use the start script as the entry point
CMD ["./start-bots.sh"]
