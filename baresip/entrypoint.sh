#!/usr/bin/env bash
set -e

DEFAULT_CONFIG=/usr/share/baresip-defaults/config
CONFIG_DIR=/config

if [ ! -f "$CONFIG_DIR/config" ] && [ -f "$DEFAULT_CONFIG" ]; then
    echo "No config found at $CONFIG_DIR/config - seeding project default"
    mkdir -p "$CONFIG_DIR"
    cp "$DEFAULT_CONFIG" "$CONFIG_DIR/config"
fi

if [ "$1" = "baresip" ]; then
    # Start baresip with User-Agent. BARESIP_DEBUG_ARGS is baked in at image
    # build time: "-s -v" for dev builds, empty for GitHub-released images.
    # Intentionally unquoted for word-splitting when set to multiple flags.
    /usr/bin/baresip -a "Baresip AWAH" ${BARESIP_DEBUG_ARGS} "$@"
else
    exec "$@"
fi
