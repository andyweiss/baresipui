import type { Peer } from 'crossws';
import { stateManager } from '../services/state-manager';

export default defineWebSocketHandler({
  open(peer: Peer) {
    console.log('WebSocket client connected:', peer.id);
    stateManager.addWsClient(peer);

    peer.send(JSON.stringify(stateManager.getInitData()));
  },

  close(peer: Peer) {
    console.log('WebSocket client disconnected:', peer.id);
    stateManager.removeWsClient(peer);
  },

  error(peer: Peer, error) {
    console.error('WebSocket error for peer:', peer.id, error);
    stateManager.removeWsClient(peer);
  }
});
