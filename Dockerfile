FROM node:16-alpine
WORKDIR /usr/src/app

COPY package*.json ./
RUN apk add ca-certificates
RUN npm install --legacy-peer-deps

COPY . .

EXPOSE 3000
ENV NODE_ENV=production
CMD ["node", "index.js"]
