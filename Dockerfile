FROM node:20-slim

# Install python, pip, ffmpeg
RUN apt-get update && apt-get install -y python3 python3-pip ffmpeg && rm -rf /var/lib/apt/lists/*

# Install yt-dlp
RUN pip3 install --upgrade yt-dlp

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
