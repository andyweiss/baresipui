# Dockerfile
FROM ghcr.io/baresip/docker/baresip:latest

USER root

RUN apt-get update && apt-get install -y \
    alsa-utils \
    libasound2 \
    build-essential \
    gcc \
    libc6-dev \
    cmake \
    && rm -rf /var/lib/apt/lists/*

# Copy custom module source
COPY modules/ /tmp/modules/

# Build and install custom presence modules with cmake
RUN cd /tmp/modules && \
    mkdir -p build && cd build && \
    cmake .. && \
    make && \
    cp libpresence.so /usr/lib/x86_64-linux-gnu/baresip/modules/presence.so && \
    rm -rf /tmp/modules

# Create custom entrypoint to set pjsip-compatible User-Agent
RUN echo '#!/usr/bin/env bash\n\
set -e\n\
\n\
if [ "$1" = "baresip" ]; then\n\
    # Start baresip with pjsip-compatible User-Agent\n\
    /usr/bin/baresip -a "PJSUA v2.10 Linux-5.4.0.0/x86_64/glibc-2.31" "$@"\n\
else\n\
    exec "$@"\n\
fi' > /entrypoint.sh && chmod +x /entrypoint.sh

WORKDIR /config

USER root