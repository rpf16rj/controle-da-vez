FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js session.js users.js index.html app.js style.css admin.html admin.js ./
EXPOSE 3100
CMD ["node", "server.js"]
