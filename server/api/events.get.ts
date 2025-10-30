import { stateManager } from '../services/state-manager';

export default defineEventHandler(async (event) => {
  // Set headers for Server-Sent Events
  setResponseHeaders(event, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  const stream = createEventStream(event);

  // Send initial data
  const initData = {
    type: 'init',
    accounts: stateManager.getAccounts(),
    contacts: stateManager.getContacts()
  };
  
  await stream.push(JSON.stringify(initData));
  console.log('📤 SSE: Sent init data to client');

  // Store stream for broadcasting
  stateManager.addSSEStream(stream);

  // Cleanup on close
  event.node.req.on('close', () => {
    console.log('❌ SSE: Client disconnected');
    stateManager.removeSSEStream(stream);
    stream.close();
  });

  // Keep connection alive
  return stream.send();
});
