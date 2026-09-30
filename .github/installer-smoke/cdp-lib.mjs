// Shared Chrome DevTools Protocol helpers for the Windows smoke VM.
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function findTarget(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await res.json();
      last = targets;
      const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return { page, targets };
    } catch (error) {
      last = String(error);
    }
    await sleep(2000);
  }
  throw new Error(`no CDP page target within ${timeoutMs} ms: ${JSON.stringify(last)}`);
}

export function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    };
    ws.onerror = (e) => reject(new Error(`websocket error ${e?.message ?? ""}`));
    ws.onopen = () =>
      resolve({
        send(method, params = {}) {
          id += 1;
          const msgId = id;
          ws.send(JSON.stringify({ id: msgId, method, params }));
          return new Promise((res) => pending.set(msgId, res));
        },
        close: () => ws.close(),
      });
  });
}

export async function evaluate(cdp, expression) {
  const res = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    timeout: 120000,
  });
  if (res.error) throw new Error(JSON.stringify(res.error));
  if (res.result?.exceptionDetails) {
    throw new Error(JSON.stringify(res.result.exceptionDetails).slice(0, 2000));
  }
  return res.result?.result?.value;
}

