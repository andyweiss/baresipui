# Dockerfile
FROM ghcr.io/baresip/docker/baresip:latest

USER root

RUN apt-get update && apt-get install -y \
    alsa-utils \
    libasound2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /config

USER root