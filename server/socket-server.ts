import { Server as SocketIOServer } from 'socket.io';
import { stateManager } from './services/state-manager';

let io: SocketIOServer | null = null;
let isInitialized = false;

export function initSocketIO(httpServer: any) {
  if (isInitialized) {
    console.log('⚠️ Socket.IO already initialized');
    return io;
  }

  console.log('🚀 Initializing Socket.IO on Nuxt HTTP server...');
  
  io = new SocketIOServer(httpServer, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST']
    },
    path: '/socket.io/',
    transports: ['polling'],
    allowUpgrades: false,
    allowEIO3: true
  });

  io.on('connection', (socket) => {
    console.log('✅ Socket.IO: Client connected:', socket.id);
    
    // Send initial data
    const initData = stateManager.getInitData();
    
    socket.emit('message', initData);
    console.log('📤 Socket.IO: Sent init data to client:', socket.id);

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
      console.log('📨 Socket.IO: Received command from client:', data);
    });
  });

  io.engine.on('connection_error', (err) => {
    console.error('❌ Socket.IO Engine: Connection error:', err);
  });

  isInitialized = true;
  console.log('✅ Socket.IO initialized on Nuxt port (same as HTTP server)');
  
  return io;
}

// Auto-initialize when HTTP server is available
if (process.server) {
  const nitroApp = useNitroApp();
  
  nitroApp.hooks.hook('request', async (event) => {
    if (!isInitialized && event.node.req.socket?.server) {
      initSocketIO(event.node.req.socket.server);
    }
  });
}

export { io };
