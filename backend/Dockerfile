FROM node:20-alpine

WORKDIR /app

COPY package*.json ./

RUN apk add --no-cache bash curl && npm ci --only=production

COPY src ./src

EXPOSE 4000

CMD ["npm", "start"]
