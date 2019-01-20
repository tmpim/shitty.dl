FROM node:8-alpine

WORKDIR /app

COPY . .
RUN apk update
RUN apk add build-base python3-dev
RUN npm install --only=production

CMD [ "node", "index.js" ]
