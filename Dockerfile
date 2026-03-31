FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
# Ensure the data directory exists; mount a volume here to persist the DB across deployments
RUN mkdir -p /app/data
VOLUME ["/app/data"]
EXPOSE 3000
CMD ["node", "--experimental-sqlite", "server.js"]
