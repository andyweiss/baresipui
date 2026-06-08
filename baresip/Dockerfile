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
    git \
    pkg-config \
    wget \
    && rm -rf /var/lib/apt/lists/*



# Clone baresip source for headers
RUN git clone --depth 1 https://github.com/baresip/baresip.git /tmp/baresip-src
# Clone libre (re.h) separat
RUN git clone --depth 1 https://github.com/baresip/re.git /tmp/libre

# Copy presence module source
COPY modules/ /tmp/modules/

# Build presence module (nur das Modul, mit baresip-Headern)
WORKDIR /tmp/modules
RUN cmake . \
    && make \
    && cp libpresence.so /usr/lib/x86_64-linux-gnu/baresip/modules/presence.so



RUN echo '#!/usr/bin/env bash\n\
set -e\n\
\n\
if [ "$1" = "baresip" ]; then\n\
    # Start baresip  User-Agent, SIP trace and verbose debug\n\
    /usr/bin/baresip -a "Baresip AWAH" -s -v "$@"\n\
else\n\
    exec "$@"\n\
fi' > /entrypoint.sh && chmod +x /entrypoint.sh

WORKDIR /config

USER root