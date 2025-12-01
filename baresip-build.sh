#!/usr/bin/env bash
# Build and run custom baresip from source

set -e

ACTION="${1:-build}"

case "$ACTION" in
    build)
        echo "🔨 Building baresip from source..."
        cd /home/debdev/baresipui/baresip
        docker build -f Dockerfile.build-from-source -t baresip-custom:latest .
        echo "✅ Build complete!"
        ;;
    
    rebuild)
        echo "🔨 Rebuilding baresip from source (no cache)..."
        cd /home/debdev/baresipui/baresip
        docker build --no-cache -f Dockerfile.build-from-source -t baresip-custom:latest .
        echo "✅ Rebuild complete!"
        ;;
    
    up)
        echo "🚀 Starting custom baresip stack..."
        cd /home/debdev/baresipui
        docker compose -f compose.build-from-source.yaml up -d
        echo "✅ Stack started!"
        echo "📊 Logs: docker logs baresip-custom -f"
        ;;
    
    down)
        echo "🛑 Stopping custom baresip stack..."
        cd /home/debdev/baresipui
        docker compose -f compose.build-from-source.yaml down
        echo "✅ Stack stopped!"
        ;;
    
    restart)
        echo "🔄 Restarting custom baresip..."
        cd /home/debdev/baresipui
        docker compose -f compose.build-from-source.yaml restart baresip-custom
        echo "✅ Restarted!"
        ;;
    
    logs)
        echo "📋 Showing logs..."
        docker logs baresip-custom -f
        ;;
    
    shell)
        echo "🐚 Opening shell in baresip container..."
        docker exec -it baresip-custom /bin/bash
        ;;
    
    *)
        echo "Usage: $0 {build|rebuild|up|down|restart|logs|shell}"
        echo ""
        echo "Commands:"
        echo "  build     - Build baresip from source (with cache)"
        echo "  rebuild   - Rebuild from source (no cache)"
        echo "  up        - Start the custom baresip stack"
        echo "  down      - Stop the stack"
        echo "  restart   - Restart baresip container"
        echo "  logs      - Show baresip logs"
        echo "  shell     - Open shell in baresip container"
        exit 1
        ;;
esac
