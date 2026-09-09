/**
 * `agent-doctor ui` — localhost の顕微鏡
 *
 * READ ONLY。127.0.0.1 にだけ bind する（環境の中身を配るので外に出さない）。
 * GET 以外は受け付けない。ファイルも書かない。
 *
 * データは起動時に 1 回 scan して持つ。`/api/data` が返す。ページは外部依存を持たない単一 HTML。
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { renderPage } from './page.js';
import type { UiData } from './data.js';

export interface UiServerOptions {
  port: number;
  /** 再 scan の関数。ブラウザの Reload で最新を取れるようにする */
  rescan: () => Promise<UiData>;
}

export async function startUiServer(opts: UiServerOptions): Promise<{ url: string; close: () => Promise<void> }> {
  let cached = await opts.rescan();
  const html = renderPage();

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // READ ONLY。GET / HEAD 以外は受けない
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD' });
      res.end('This viewer is read only. Only GET is accepted.\n');
      return;
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const send = (code: number, type: string, body: string) => {
      res.writeHead(code, {
        'content-type': type,
        'cache-control': 'no-store',
        // ページは自分で完結している。外部を読み込ませない
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'none'; base-uri 'none'; form-action 'none'",
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    };

    if (url.pathname === '/' || url.pathname === '/index.html') {
      send(200, 'text/html; charset=utf-8', html);
      return;
    }
    if (url.pathname === '/api/data') {
      if (url.searchParams.get('rescan') === '1') cached = await opts.rescan();
      send(200, 'application/json; charset=utf-8', JSON.stringify(cached));
      return;
    }
    send(404, 'text/plain; charset=utf-8', 'not found\n');
  };

  const server = createServer((req, res) => {
    handler(req, res).catch((e) => {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`error: ${e instanceof Error ? e.message : String(e)}\n`);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // localhost にだけ bind する
    server.listen(opts.port, '127.0.0.1', () => resolve());
  });

  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : opts.port;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
