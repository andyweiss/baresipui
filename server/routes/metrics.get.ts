import { registry } from '../services/prometheus';

export default defineEventHandler(async (event) => {
  event.node.res.setHeader('Content-Type', registry.contentType);
  return registry.metrics();
});
