# Use official Node.js LTS image
FROM node:20-alpine

# Install dependencies for yt-dlp
RUN apk add --no-cache python3 py3-pip ffmpeg

# Install yt-dlp globally
RUN pip install --upgrade yt-dlp

# Set working directory
WORKDIR /app

# Copy package.json and lock files first (for caching)
COPY package*.json ./

# Install Node.js dependencies
RUN npm install --production

# Copy rest of the app
COPY . .

# Expose the port
EXPOSE 3000

# Start the server
CMD ["node", "server.js"]
