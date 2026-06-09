import { Server as SocketIOServer } from 'socket.io';
import { stateManager } from './services/state-manager';

let io: SocketIOServer | null = null;
let isInitialized = false;

export function initSocketIO(httpServer: any) {
  if (isInitialized) {
    return io;
  }

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
    const initData = stateManager.getInitData();
    socket.emit('message', initData);

    // Store socket for broadcasting
    stateManager.addSocketClient(socket);

    socket.on('disconnect', (_reason) => {
      stateManager.removeSocketClient(socket);
    });

    socket.on('error', (error) => {
      console.error('❌ Socket.IO: Socket error:', socket.id, error);
    });

    socket.on('command', async (_data) => {});
  });

  io.engine.on('connection_error', (err) => {
    console.error('❌ Socket.IO Engine: Connection error:', err);
  });

  isInitialized = true;
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
