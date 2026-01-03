docker build -f Dockerfile.build-from-source -t baresip-custom:latest .
docker build --no-cache -f Dockerfile.build-from-source -t baresip-custom:latest .
docker build \

# Build baresip from source
# This Dockerfile builds libre, baresip, and custom modules

## Versions
- **libre**: main branch (latest - needed for API compatibility)
- **baresip**: main branch (latest - v4.2.0 has clang-19 compile errors)
- **Custom modules**: presence.so, notifier.so
- **Compiler**: clang-19 with relaxed warnings for implicit declarations

## Build process

### Quick build (without cache clear):
```bash
cd /home/debdev/baresipui/baresip
docker build -f Dockerfile.build-from-source -t baresip-custom:latest .
```

### Full build (with cache clear):
```bash
docker build --no-cache -f Dockerfile.build-from-source -t baresip-custom:latest .
```

### Build with different baresip/libre version:
```bash
docker build \
  --build-arg RE_VERSION=v3.16.0 \
  --build-arg BARESIP_VERSION=v4.2.0 \
  -f Dockerfile.build-from-source \
  -t baresip-custom:latest .
```

## Adding patches

1. Create a `patches/` directory
2. Place patches there:
   - `libre-*.patch` for libre
   - `baresip-*.patch` for baresip
3. Uncomment the COPY/RUN lines in the Dockerfile

## Build time

- **First build**: ~15-25 minutes
- **Re-build with cache**: ~2-5 minutes (only changed stages)
- **Only custom modules**: ~30 seconds

## Multi-stage advantages

- **Small image size**: Only runtime dependencies in the final image
- **Fast rebuilds**: Cached stages for libre/baresip
- **Flexibility**: Patches can be easily added
