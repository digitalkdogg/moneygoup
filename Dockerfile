# Use a Node.js image for the build stage to build the Next.js application
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package.json and package-lock.json first to leverage Docker cache
COPY package*.json ./

# Install Node.js dependencies
RUN npm install

# Copy the rest of the application code
COPY . .

# Build the Next.js application
RUN npm run build

# Use a smaller Node.js image for the production stage
FROM node:20-alpine AS runner

WORKDIR /app

# Copy Next.js build output and node_modules from the builder stage
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./

# Copy public directory
COPY public ./public

# Copy Python scripts and their dependencies
COPY populate_daily_prices.py ./
COPY update_tickers.py ./

# Install Python and its dependencies
RUN apk add --no-cache python3 py3-pip && \
    pip3 install mysql-connector-python python-dotenv requests textblob

# Expose the port the Next.js app runs on (as per memory, port 3001)
EXPOSE 3001

# Set the command to start the Next.js application
CMD ["npm", "start"]
