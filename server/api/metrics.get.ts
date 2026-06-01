import { registry } from '../services/prometheus';

export default defineEventHandler(async (event) => {
  setHeader(event, 'Content-Type', registry.contentType);
  return registry.metrics();
});
