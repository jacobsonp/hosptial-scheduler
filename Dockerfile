FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
# data/ is excluded by .dockerignore; mount a Railway volume at /app/data to persist the DB
RUN mkdir -p /app/data
EXPOSE 3000
CMD ["node", "--experimental-sqlite", "server.js"]
