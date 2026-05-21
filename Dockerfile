FROM node:20-alpine
WORKDIR /app
COPY package.json .
COPY server.js .
EXPOSE 8181
CMD ["node", "server.js"]
