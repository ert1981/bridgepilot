import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../../src/config/env.js';
import { createServices, type Services } from '../../src/services.js';
import { createApp } from './app.js';

export function startServer(svc: Services, port = svc.config.port, host = svc.config.host) {
  const handler = createApp(svc);
  const server = createServer((req, res) => {
    handler(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"status":"error","error":{"code":"INTERNAL_ERROR"}}');
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  return new Promise<{ server: typeof server; port: number }>((resolve) => {
    server.listen(port, host, () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === 'object' && addr ? addr.port : port });
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const config = loadConfig();
  const svc = createServices(config);
  startServer(svc).then(({ port }) => {
    console.log(`BridgePilot listening on :${port} (providers=${svc.registry.ids().join(',')}, mode=${config.providerMode}, x402=${config.x402.mode})`);
  });
  const shutdown = async () => {
    await svc.audit.flush();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
