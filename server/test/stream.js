// A board's live stream read the way the browser reads it, for tests (live.test.js, board-settings.test.js).
const TAB_A = 'tab-aaaaaaaa';

/**
 * A live stream as a browser reads it: fetch, then the body's SSE frames one at a time. next() gives the next frame
 * ({ id, event, data } or { comment }), waiting up to `ms`; close() ends it the way a browser leaving does.
 */
export async function openStream(app, code, { since, tab = TAB_A, cookie, ip } = {}) {
  const ctl = new AbortController();
  const q = new URLSearchParams();
  if (since !== undefined) q.set('since', String(since));
  if (tab) q.set('tab', tab);
  const res = await fetch(`${app.base}/api/boards/${code}/live?${q}`, {
    headers: { ...(cookie ? { cookie } : {}), ...(ip ? { 'cf-connecting-ip': ip } : {}) },
    signal: ctl.signal,
  });
  const frames = [];
  const waiting = [];
  let ended = false;
  const push = (f) => (waiting.length ? waiting.shift()(f) : frames.push(f));
  if (res.headers.get('content-type')?.startsWith('text/event-stream')) {
    (async () => {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) !== -1) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            if (block.startsWith(':')) {
              push({ comment: block.slice(1).trim() });
              continue;
            }
            const f = {};
            for (const line of block.split('\n')) {
              const at = line.indexOf(': ');
              f[line.slice(0, at)] = line.slice(at + 2);
            }
            push({ id: f.id ? Number(f.id) : undefined, event: f.event, data: JSON.parse(f.data) });
          }
        }
      } catch {
        // aborted
      }
      ended = true;
      while (waiting.length) waiting.shift()(null);
    })();
  }
  return {
    res,
    status: res.status,
    async next(ms = 2000) {
      if (frames.length) return frames.shift();
      if (ended) return null;
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('no frame in time')), ms);
        waiting.push((f) => {
          clearTimeout(t);
          resolve(f);
        });
      });
    },
    /** The next frame that isn't a comment (heartbeat or the opening one). */
    async event(ms) {
      for (;;) {
        const f = await this.next(ms);
        if (!f || !f.comment) return f;
      }
    },
    async json() {
      return res.json();
    },
    close: () => ctl.abort(),
  };
}

