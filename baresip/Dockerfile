# Supported default image: build baresip and mediasoup_bridge together.
# Keep this build aligned with Dockerfile.build-from-source.

# ============================================================
# Stage 1: Build libre (re library - SIP/RTP core)
# ============================================================
FROM debian:trixie-slim AS libre-builder

ARG RE_VERSION=main
ARG DEBIAN_FRONTEND=noninteractive

WORKDIR /root/

RUN apt-get update && apt-get install --no-install-recommends -y \
    clang-19 \
    make \
    cmake \
    dpkg-dev \
    pkg-config \
    git \
    libssl-dev \
    ca-certificates \
    libz-dev \
    patch \
    && rm -rf /var/lib/apt/lists/*

# Clone and patch libre
RUN git clone -b ${RE_VERSION} --depth=1 https://github.com/baresip/re.git

WORKDIR /root/re

COPY patches/ ./patches/
RUN set -eu; \
    for p in patches/re-*.patch; do \
        [ -f "$p" ] || continue; \
        echo "=== Applying RE patch: $p ==="; \
        patch --batch --forward --fuzz=0 -p1 < "$p"; \
        echo "=== Patch $p applied successfully ==="; \
    done

RUN cmake -B build \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_C_FLAGS="-g" \
    -DCMAKE_C_COMPILER=clang-19 \
    -DCMAKE_CXX_COMPILER=clang++-19 \
    -DCMAKE_INSTALL_PREFIX=/usr && \
    cmake --build build -j$(nproc) && \
    cmake --install build --prefix dist && \
    cp -a dist/* /usr/


# ============================================================
# Stage 2: Build patched baresip core and all custom modules
# ============================================================
FROM libre-builder AS baresip-builder

ARG BARESIP_VERSION=main
ARG DEBIAN_FRONTEND=noninteractive

# fdk-aac (needed for the "aac" module) lives in Debian's non-free component,
# which the slim base image doesn't enable by default.
RUN sed -i 's/Components: main$/Components: main non-free/' /etc/apt/sources.list.d/debian.sources && \
    apt-get update && apt-get install -y \
    libopus-dev \
    libasound2-dev \
    libmosquitto-dev \
    libspandsp-dev \
    libpulse-dev \
    libfdk-aac-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /root/

RUN git clone -b ${BARESIP_VERSION} --depth=1 \
    https://github.com/baresip/baresip.git

WORKDIR /root/baresip

# Replace upstream presence with the project version.
RUN rm -rf modules/presence

COPY modules/presence.c modules/subscriber.c modules/notifier.c \
     modules/publisher.c modules/presence.h modules/CMakeLists.txt \
     modules/presence/

COPY modules/rtcpstats_cmd/ modules/rtcpstats_cmd/
COPY modules/vumeter_stereo/ modules/vumeter_stereo/
COPY modules/mediasoup_bridge/ modules/mediasoup_bridge/

# The mediasoup patch changes the core and module as one compatibility unit.
COPY patches/baresip-*.patch ./
RUN set -eu; \
    for p in baresip-*.patch; do \
        [ -f "$p" ] || continue; \
        echo "=== Applying baresip patch: $p ==="; \
        patch --batch --forward --fuzz=0 -p1 < "$p"; \
        echo "=== Patch $p applied successfully ==="; \
    done

RUN cmake -B build \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_C_FLAGS="-g -Wno-error=implicit-function-declaration -Wno-error=int-conversion" \
    -DCMAKE_CXX_FLAGS="-g" \
    -DCMAKE_C_COMPILER=clang-19 \
    -DCMAKE_CXX_COMPILER=clang++-19 \
    -DEXTRA_MODULES="rtcpstats_cmd;vumeter_stereo;mediasoup_bridge" \
    -DCMAKE_INSTALL_PREFIX=/usr && \
    cmake --build build -j$(nproc) && \
    cmake --install build --prefix dist && \
    cp -a dist/* /usr/ && \
    test -s "/usr/lib/$(dpkg-architecture -qDEB_HOST_MULTIARCH)/baresip/modules/mediasoup_bridge.so"

RUN mkdir -p /root/dist/usr && \
    cp -a /root/re/dist/* /root/dist/usr/ && \
    cp -a /root/baresip/dist/* /root/dist/usr/


# ============================================================
# Stage 3: Final runtime image
# ============================================================
FROM debian:trixie-slim

ARG DEBIAN_FRONTEND=noninteractive

RUN sed -i 's/Components: main$/Components: main non-free/' /etc/apt/sources.list.d/debian.sources && \
    apt-get update && apt-get install -y --no-install-recommends \
    libopus0 \
    ca-certificates \
    openssl \
    libasound2 \
    libmosquitto1 \
    libspandsp2 \
    libpulse0 \
    pulseaudio \
    alsa-utils \
    libfdk-aac2t64 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=baresip-builder /root/dist/usr/ /usr/
RUN for module in /usr/lib/*/baresip/modules/mediasoup_bridge.so; do \
        if [ -s "$module" ]; then exit 0; fi; \
    done; \
    exit 1

WORKDIR /root
USER root
ENV USER=root

RUN echo '#!/usr/bin/env bash\n\
set -e\n\
\n\
if [ "$1" = "baresip" ]; then\n\
    # Start baresip with User-Agent, SIP trace and verbose debug\n\
    /usr/bin/baresip -a "Baresip AWAH" -s -v "$@"\n\
else\n\
    exec "$@"\n\
fi' > /entrypoint.sh && chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
CMD ["baresip"]
