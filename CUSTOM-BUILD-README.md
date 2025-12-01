# Baresip Custom Build Setup

This setup allows you to build baresip completely from source code to apply custom patches and modifications.

## Structure

```
baresip/
├── Dockerfile.build-from-source   # Multi-stage build for libre + baresip
├── BUILD.md                        # Detailed build documentation
├── patches/                        # Patches for libre and baresip (create this folder)
│   ├── libre-*.patch              # Patches for re library
│   └── baresip-*.patch            # Patches for baresip
├── modules/                        # Custom modules (presence, notifier)
└── config/                         # baresip configuration

baresip-build.sh                   # Helper script for build and deployment
compose.build-from-source.yaml     # Docker Compose for custom build
```

## Build Status

✅ **Successfully built and tested!**

The build system is working with:
- libre: main branch (latest development version)
- baresip: main branch (latest development version)  
- Compiler: clang-19 with relaxed implicit function declaration warnings
- Image size: ~259 MB (optimized multi-stage build)

## Quick Start

### 1. Start initial build
```bash
./baresip-build.sh build
```

This command:
- Builds libre (v3.16.0)
- Builds baresip (v4.2.0)  
- Compiles custom modules (presence, notifier)
- Creates image `baresip-custom:latest`

**Duration**: ~15-25 minutes for first build

### 2. Start stack
```bash
./baresip-build.sh up
```

### 3. Check logs
```bash
./baresip-build.sh logs
```

## Adding Patches

### Step 1: Create patches/ folder
```bash
mkdir -p /home/debdev/baresipui/baresip/patches
```

### Step 2: Create patch

Example for `;ob` parameter in Contact header:

**patches/libre-add-ob-to-contact.patch**:
```patch
diff --git a/src/sipsess/reply.c b/src/sipsess/reply.c
index abc123..def456 100644
--- a/src/sipsess/reply.c  
+++ b/src/sipsess/reply.c
@@ -XXX,X +XXX,X @@
-	err = mbuf_printf(mb, "Contact: <%H>\r\n", uri_encode, &sess->cuser);
+	err = mbuf_printf(mb, "Contact: <%H;ob>\r\n", uri_encode, &sess->cuser);
```

### Step 3: Enable in Dockerfile

Uncomment these lines in `Dockerfile.build-from-source`:

**For libre** (Stage 1):
```dockerfile
# Apply patches if any
COPY patches/libre-*.patch ./
RUN for p in libre-*.patch; do [ -f "$p" ] && git apply "$p" || true; done
```

**For baresip** (Stage 2):
```dockerfile
# Apply patches if any  
COPY patches/baresip-*.patch ./
RUN for p in baresip-*.patch; do [ -f "$p" ] && git apply "$p" || true; done
```

### Step 4: Rebuild
```bash
./baresip-build.sh rebuild  # No cache, to ensure patches are applied
```

## Commands

```bash
./baresip-build.sh build      # Build (with cache)
./baresip-build.sh rebuild    # Complete rebuild (without cache)
./baresip-build.sh up         # Start stack
./baresip-build.sh down       # Stop stack
./baresip-build.sh restart    # Restart baresip
./baresip-build.sh logs       # Show logs
./baresip-build.sh shell      # Open shell in container
```

## Changing Versions

Modify ARG values in Dockerfile:
```dockerfile
ARG RE_VERSION=v3.16.0      # libre version
ARG BARESIP_VERSION=v4.2.0  # baresip version
```

Or pass during build:
```bash
docker build \
  --build-arg RE_VERSION=v3.17.0 \
  --build-arg BARESIP_VERSION=v4.3.0 \
  -f Dockerfile.build-from-source \
  -t baresip-custom:latest \
  /home/debdev/baresipui/baresip
```

## Debugging

### Enter container
```bash
./baresip-build.sh shell
```

### Check libraries
```bash
docker exec baresip-custom ldd /usr/bin/baresip
```

### List modules
```bash
docker exec baresip-custom ls -la /usr/lib/x86_64-linux-gnu/baresip/modules/
```

## Troubleshooting

### Build fails
- Check internet connection (git clone)
- Check disk space (`docker system df`)
- Check logs: Build output shows errors

### Patches not applied
- Check patch format (`git diff` format)
- Check paths in patch (must be relative to repo root)
- Rebuild without cache: `./baresip-build.sh rebuild`

### Runtime errors
- Check logs: `./baresip-build.sh logs`
- Missing libraries? Check runtime dependencies in Final Stage

## Next Steps

1. ✅ Build system created
2. ⏳ Create patch for `;ob` parameter
3. ⏳ Test if SDP-rewriting works with it
4. ⏳ Possibly additional patches for NAT-handling
