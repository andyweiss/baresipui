import { Server as SocketIOServer } from 'socket.io';
import { stateManager } from '../services/state-manager';
import type { NitroApp } from 'nitropack';

let io: SocketIOServer | null = null;

export default defineNitroPlugin((nitroApp: NitroApp) => {
  console.log('🔌 Socket.IO Plugin: Initializing...');

  nitroApp.hooks.hook('request', async (event) => {
    // Initialize Socket.IO server on first request
    if (!io && event.node.req.socket?.server) {
      console.log('🚀 Socket.IO Plugin: Creating Socket.IO server...');
      
      io = new SocketIOServer(event.node.req.socket.server, {
        cors: {
          origin: '*',
          methods: ['GET', 'POST']
        },
        path: '/socket.io/',
        transports: ['websocket', 'polling']
      });

      io.on('connection', (socket) => {
        console.log('✅ Socket.IO: Client connected:', socket.id);
        
        // Send initial data
        const initData = {
          type: 'init',
          accounts: stateManager.getAccounts(),
          contacts: stateManager.getContacts()
        };
        
        socket.emit('message', initData);
        console.log('📤 Sent init data to client:', socket.id);

        // Store socket for broadcasting
        stateManager.addSocketClient(socket);

        socket.on('disconnect', (reason) => {
          console.log('❌ Socket.IO: Client disconnected:', socket.id, 'Reason:', reason);
          stateManager.removeSocketClient(socket);
        });

        socket.on('error', (error) => {
          console.error('❌ Socket.IO: Socket error:', socket.id, error);
        });

        socket.on('command', async (data) => {
          console.log('📨 Received command from client:', data);
        });
      });

      io.engine.on('connection_error', (err) => {
        console.error('❌ Socket.IO Engine: Connection error:', err);
      });

      console.log('✅ Socket.IO server initialized');
    }
  });
});

export { io };
