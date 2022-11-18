FROM node:12-alpine
WORKDIR /usr/src/app

COPY package.json package-lock.json ./
RUN apk add ca-certificates g++ make python3
RUN npm install --legacy-peer-deps
RUN npm install highlights language-lua

COPY . .

EXPOSE 3000
ENV NODE_ENV=production
CMD ["node", "index.js"]
