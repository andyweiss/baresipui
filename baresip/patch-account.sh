#!/bin/sh
# Patch account.c to always add ;ob to Contact header

cd /root/baresip

# Find the line with "else if (pl_isset(&acc->ob_uri))" and replace the condition
# so it always adds ;ob regardless of ob_uri being set

sed -i 's/else if (pl_isset(&acc->ob_uri)) {/else {/' src/account.c

echo "Patched account.c to always add ;ob parameter"
