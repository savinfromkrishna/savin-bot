import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import type { WebSocket } from "ws";
import { WebSocketServer } from "ws";

export type SocketRoute = {
  path: RegExp;
  /** Whether the signed-in person may open it, decided before the upgrade completes. */
  allow?: (request: IncomingMessage, params: string[]) => Promise<boolean>;
  open: (socket: WebSocket, params: string[]) => void | Promise<void>;
};

const localHost = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const localOrigin = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/**
 * WebSockets for the terminal and the live browser. Any website may open a socket to
 * localhost, so only this app's own pages (checked by Origin and Host) can connect.
 */
export function attachSockets(server: Server, routes: SocketRoute[]) {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const { pathname } = new URL(request.url ?? "/", "http://localhost");
    const found = routes.map((route) => ({ route, match: route.path.exec(pathname) })).find(({ match }) => match);
    const trusted = localHost.test(request.headers.host ?? "") && localOrigin.test(request.headers.origin ?? "");
    if (!found?.match || !trusted) {
      socket.end(found ? "HTTP/1.1 403 Forbidden\r\n\r\n" : "HTTP/1.1 404 Not Found\r\n\r\n");
      return;
    }
    const params = found.match.slice(1).map((value) => decodeURIComponent(value));
    const { route } = found;
    void Promise.resolve(route.allow?.(request, params) ?? true).then(
      (allowed) => {
        if (!allowed) {
          socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
          return;
        }
        sockets.handleUpgrade(request, socket, head, (ws) => {
          Promise.resolve(route.open(ws, params)).catch(() => ws.close(1011, "Failed to open"));
        });
      },
      () => socket.end("HTTP/1.1 500 Internal Server Error\r\n\r\n"),
    );
  });
  return sockets;
}
