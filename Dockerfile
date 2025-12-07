FROM node:20-alpine AS builder

ARG BARESIP_HOST=baresip
ARG BARESIP_PORT=4444

WORKDIR /app

COPY package*.json ./

RUN npm ci

COPY . .

ENV BARESIP_HOST=${BARESIP_HOST}
ENV BARESIP_PORT=${BARESIP_PORT}

RUN npm run build

FROM node:20-alpine

# Install Docker CLI for log streaming
RUN apk add --no-cache docker-cli

WORKDIR /app

COPY --from=builder /app/.output ./.output
COPY --from=builder /app/package*.json ./

EXPOSE 3000

ENV HOST=0.0.0.0
ENV PORT=3000

CMD ["node", ".output/server/index.mjs"]
