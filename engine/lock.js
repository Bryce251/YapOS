import net from 'node:net';

export const LOCK_PORT = 47391;

export function takeLock({ port = Number(process.env.YAPOS_LOCK_PORT) || LOCK_PORT } = {}) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => socket.destroy());
    server.once('error', (e) => {
      if (e.code === 'EADDRINUSE') resolve({ ok: false, port });
      else reject(e);
    });
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
      server.unref();
      resolve({ ok: true, port, release: () => new Promise((r) => server.close(() => r())) });
    });
  });
}
