import { Server as SocketIOServer } from 'socket.io';
import { stateManager } from '../services/state-manager';
import { getBaresipLogger } from '../utils/logger';
import type { NitroApp } from 'nitropack';

let io: SocketIOServer | null = null;

function initSocketIO(httpServer: any) {
  if (io) return;

  io = new SocketIOServer(httpServer, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST']
    },
    path: '/socket.io/',
    transports: ['websocket', 'polling'],
    allowUpgrades: true,
    pingInterval: 10000,   // Send ping every 10s (default: 25s)
    pingTimeout: 60000,    // Wait 60s for pong before disconnect (default: 20s)
    connectTimeout: 10000
  });

  io.on('connection', (socket) => {
    console.log(`Socket.IO: client connected (${socket.id})`);
    // Send both dedicated 'init' event AND wrapped 'message' for compatibility
    const initData = stateManager.getInitData();
    socket.emit('init', initData);

    // Store socket for broadcasting
    stateManager.addSocketClient(socket);

    socket.on('disconnect', (reason) => {
      console.log(`Socket.IO: client disconnected (${socket.id}), reason: ${reason}`);
      stateManager.removeSocketClient(socket);
    });

    // Log room: clients subscribe when opening the logs page
    socket.on('subscribeLogs', () => {
      socket.join('logs');
      // Send historical logs from both baresip-logger and state-manager
      try {
        const logger = getBaresipLogger();
        const baresipLogs = logger.getLogs(500);
        if (baresipLogs.length > 0) {
          socket.emit('logHistory', { logs: baresipLogs });
        }
      } catch (e) {
        // Logger might not be ready
      }
      const stateLogs = stateManager.getLogs(500);
      if (stateLogs.length > 0) {
        socket.emit('logHistory', { logs: stateLogs });
      }
    });

    socket.on('unsubscribeLogs', () => {
      socket.leave('logs');
    });

    socket.on('error', (error) => {
      console.error('Socket.IO: Socket error:', socket.id, error);
    });
  });

  io.engine.on('connection_error', (err) => {
    console.error('Socket.IO Engine: Connection error:', err);
  });

  console.log('Socket.IO: server initialized');

  // Give stateManager access to io for room-based broadcasting
  stateManager.setIO(io);
}

export default defineNitroPlugin((nitroApp: NitroApp) => {
  // Primary: hook into the Node.js listen event for reliable initialization
  // @ts-ignore - Nitro hook type not defined for 'listen:node' in all versions
  nitroApp.hooks.hook('listen:node', (server: any) => {
    initSocketIO(server);
  });

  // Fallback: also try on first request in case listen:node didn't fire
  nitroApp.hooks.hook('request', async (event) => {
    if (!io && event.node.req.socket?.server) {
      initSocketIO(event.node.req.socket.server);
    }
  });
});
