/**
 * 在线访客（Cloudflare Workers 版）：Workers 本身不保存状态，连接都交给同一个 Durable Object 管。
 * 用的是可休眠的 WebSocket：没有变化时它不占运行时间；读者标识和所在页面放在每个连接的附件里，休眠醒来也还在。
 * 规则和 Node 版（presence.ts）一样。绑定见 wrangler.example.toml 的 ONLINE。
 */
import { cleanPage, tally, type Seat } from './presence.ts';

declare const WebSocketPair: { new (): { 0: any; 1: any } };
declare const WebSocketRequestResponsePair: { new (req: string, res: string): unknown };

export class OnlinePresence {
  private state: any;
  /** 上次推出去的消息；休眠醒来后是空的，第一次变化时总会推一次 */
  private last = '';

  constructor(state: any) {
    this.state = state;
    // 页面每 45 秒发一个 ping 保持连接，这里自动回 pong，不用把对象叫醒
    state.setWebSocketAutoResponse?.(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(req: Request) {
    const url = new URL(req.url);
    if (url.pathname === '/count') return Response.json({ online: this.snapshot().online });
    if (url.pathname === '/views' || url.pathname === '/likes') { // 记了一次阅读、点赞数变了：推给只看的连接
      const msg = JSON.stringify({ [url.pathname.slice(1)]: Number(await req.text()) });
      for (const ws of this.state.getWebSockets()) if (!seat(ws).visitor) try { ws.send(msg); } catch { /* 已断开 */ }
      return new Response(null, { status: 204 });
    }
    if (req.headers.get('upgrade') !== 'websocket') return new Response('需要 WebSocket', { status: 426 });
    const pair = new WebSocketPair();
    const visitor = url.searchParams.get('visitor') || null;
    this.state.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ visitor, page: visitor ? cleanPage(url.searchParams.get('page')) : null });
    if (!this.changed()) pair[1].send(this.last);
    return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit);
  }

  /** 读者换了页：{"page": "/posts/x/"} */
  webSocketMessage(ws: any, msg: string | ArrayBuffer) {
    if (typeof msg !== 'string' || msg.length >= 1000) return;
    const s = seat(ws);
    if (!s.visitor) return;
    let page: string | null;
    try { page = cleanPage(JSON.parse(msg).page); } catch { return; }
    if (page === s.page) return;
    ws.serializeAttachment({ ...s, page });
    this.changed();
  }

  webSocketClose(ws: any) { this.changed(ws); }
  webSocketError(ws: any) { this.changed(ws); }

  /** gone：正在关闭、但还在列表里的那个连接 */
  private snapshot(gone?: any) {
    return tally(this.state.getWebSockets().filter((ws: any) => ws !== gone).map(seat));
  }

  private changed(gone?: any) {
    const msg = JSON.stringify(this.snapshot(gone));
    if (msg === this.last) return false;
    this.last = msg;
    for (const ws of this.state.getWebSockets()) if (ws !== gone) try { ws.send(msg); } catch { /* 已断开 */ }
    return true;
  }
}

const seat = (ws: any): Seat => {
  const a = ws.deserializeAttachment?.() ?? {};
  return { visitor: a.visitor || null, page: a.page ?? null };
};
