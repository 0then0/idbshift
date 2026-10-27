import { createServer } from 'vite';

/** Owns only a loopback Vite adapter host. Call close in finally. */
export async function startAdapterServer(root = process.cwd()) {
  const server = await createServer({
    configFile: false,
    root,
    server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false, ws: false },
    appType: 'spa',
    logLevel: 'error',
  });
  try {
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === 'string') throw new Error('Missing local adapter origin');
    return { origin: `http://127.0.0.1:${address.port}`, close: () => server.close() };
  } catch (error) {
    await server.close();
    throw error;
  }
}
