# Build baresip from source
# This Dockerfile builds libre, baresip, and custom modules

## Versions
- **libre**: main branch (latest - needed for API compatibility)
- **baresip**: main branch (latest - v4.2.0 has clang-19 compile errors)
- **Custom modules**: presence.so, notifier.so
- **Compiler**: clang-19 with relaxed warnings for implicit declarations

## Build-Prozess

### Schnell-Build (ohne Cache-Clear):
```bash
cd /home/debdev/baresipui/baresip
docker build -f Dockerfile.build-from-source -t baresip-custom:latest .
```

### Full-Build (mit Cache-Clear):
```bash
docker build --no-cache -f Dockerfile.build-from-source -t baresip-custom:latest .
```

### Build mit anderem baresip/libre Version:
```bash
docker build \
  --build-arg RE_VERSION=v3.16.0 \
  --build-arg BARESIP_VERSION=v4.2.0 \
  -f Dockerfile.build-from-source \
  -t baresip-custom:latest .
```

## Patches hinzufügen

1. Erstelle `patches/` Verzeichnis
2. Patches dort ablegen:
   - `libre-*.patch` für libre
   - `baresip-*.patch` für baresip
3. Uncomment die COPY/RUN Zeilen im Dockerfile

## Build-Zeit

- **Erster Build**: ~15-25 Minuten
- **Re-Build mit Cache**: ~2-5 Minuten (nur geänderte Stages)
- **Nur Custom-Modules**: ~30 Sekunden

## Multi-Stage Vorteile

- **kleine Image-Größe**: Nur Runtime-Dependencies im Final Image
- **schnelle Rebuilds**: Cached Stages für libre/baresip
- **Flexibilität**: Patches können einfach hinzugefügt werden
