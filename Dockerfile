FROM node:8-alpine

WORKDIR /app

COPY . .
RUN apk update
RUN apk add build-base python2-dev
RUN PYTHON=python2 npm install --only=production

CMD [ "node", "index.js" ]
