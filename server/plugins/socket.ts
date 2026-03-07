import { Server as SocketIOServer } from 'socket.io';
import { stateManager } from '../services/state-manager';
import type { NitroApp } from 'nitropack';

let io: SocketIOServer | null = null;

export default defineNitroPlugin((nitroApp: NitroApp) => {
  nitroApp.hooks.hook('request', async (event) => {
    // Initialize Socket.IO server on first request
    if (!io && event.node.req.socket?.server) {
      
      io = new SocketIOServer(event.node.req.socket.server, {
        cors: {
          origin: '*',
          methods: ['GET', 'POST']
        },
        path: '/socket.io/',
        transports: ['websocket', 'polling'],
        allowUpgrades: true
      });

      io.on('connection', (socket) => {
        // Send initial data
        const initData = stateManager.getInitData();
        socket.emit('message', initData);

        // Store socket for broadcasting
        stateManager.addSocketClient(socket);

        socket.on('disconnect', () => {
          stateManager.removeSocketClient(socket);
        });

        socket.on('error', (error) => {
          console.error('Socket.IO: Socket error:', socket.id, error);
        });

        socket.on('command', async () => {
          // Commands handled via HTTP API
        });
      });

      io.engine.on('connection_error', (err) => {
        console.error('Socket.IO Engine: Connection error:', err);
      });
    }
  });
});

export { io };
