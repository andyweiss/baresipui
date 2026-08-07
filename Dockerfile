FROM node:20-alpine AS builder

ARG BARESIP_HOST=baresip
ARG BARESIP_PORT=4444
ARG APP_VERSION=unknown
ARG TALKTOME_TESTED_VERSION=1.1.3

WORKDIR /app

COPY package*.json ./

RUN npm ci

COPY . .

ENV BARESIP_HOST=${BARESIP_HOST}
ENV BARESIP_PORT=${BARESIP_PORT}
ENV TALKTOME_TESTED_VERSION=${TALKTOME_TESTED_VERSION}

# Write version to file
RUN echo "${APP_VERSION}" > /app/public/version.js

RUN npm run build

FROM node:20-alpine

ARG TALKTOME_TESTED_VERSION=1.1.3

WORKDIR /app

COPY --from=builder /app/.output ./.output
COPY --from=builder /app/package*.json ./

EXPOSE 3000

ENV HOST=0.0.0.0
ENV PORT=3000
ENV TALKTOME_TESTED_VERSION=${TALKTOME_TESTED_VERSION}

CMD ["node", ".output/server/index.mjs"]
