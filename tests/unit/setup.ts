// jsdom 下补齐浏览器能力：IndexedDB、BroadcastChannel、Web Locks。
import 'fake-indexeddb/auto';
import { afterEach } from 'vitest';

type Listener = (ev: MessageEvent) => void;

interface FakeChannel {
  name: string;
  postMessage(data: unknown): void;
  close(): void;
  onmessage: Listener | null;
  onmessageerror: Listener | null;
}

const registry = new Map<string, Set<FakeChannel>>();

(globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = class
  implements FakeChannel
{
  onmessage: Listener | null = null;
  onmessageerror: Listener | null = null;
  constructor(public name: string) {
    let set = registry.get(name);
    if (!set) {
      set = new Set();
      registry.set(name, set);
    }
    set.add(this);
  }
  postMessage(data: unknown) {
    const peers = registry.get(this.name);
    if (!peers) return;
    for (const peer of [...peers]) {
      if (peer === this || peer.onmessage === null) continue;
      // 异步派发，贴近真实 BroadcastChannel。
      queueMicrotask(() => {
        try {
          peer.onmessage?.({ data } as MessageEvent);
        } catch {
          /* 监听器异常不影响发送方 */
        }
      });
    }
  }
  close() {
    registry.get(this.name)?.delete(this);
  }
};

// 极简 Web Locks：同名排他锁，FIFO 队列；释放后自动授予下一个等待者。
const heldLocks = new Set<string>();
const waitQueues = new Map<string, Array<() => void>>();

// 每个用例前清空残留的锁队列（上个用例未结束的 sleep 定时器可能在后续触发）。
export function _resetLocksForTests(): void {
  heldLocks.clear();
  waitQueues.clear();
}
if (typeof afterEach === 'function') {
  afterEach(() => _resetLocksForTests());
}

function tryGrant(name: string) {
  if (heldLocks.has(name)) return;
  const q = waitQueues.get(name);
  const next = q?.shift();
  if (!next) return;
  heldLocks.add(name);
  next();
}

if (
  typeof (globalThis as { navigator?: object }).navigator === 'undefined'
) {
  Object.defineProperty(globalThis, 'navigator', {
    value: {},
    configurable: true,
  });
}

const locks = {
  // 与 navigator.locks.request 对齐：callback 收到 release promise；
  // 同时容忍 callback 把它当函数直接调用（测试里更顺手）。
  request(
    name: string,
    ...rest: unknown[]
  ): Promise<void> {
    const callback = (
      rest.length > 1 ? rest[1] : rest[0]
    ) as (release: (() => void) & PromiseLike<void>) => Promise<void> | void;

    return new Promise<void>((resolveCaller) => {
      let released = false;
      const wait = () => {
        const doRelease = () => {
          if (released) return;
          released = true;
          heldLocks.delete(name);
          resolveCaller();
          // 单独排一个任务再授予下一位：贴近真实浏览器 —— 上一任的
          // 后续逻辑（如失锁/交接清理）先跑完，队列里的下一位才获锁。
          setTimeout(() => tryGrant(name), 0);
        };

        let resolveRelease: () => void = () => {};
        const releasedPromise = new Promise<void>((res) => {
          // resolve 内部 promise = 释放锁（与浏览器语义一致）。
          resolveRelease = () => {
            res();
            doRelease();
          };
        });
        // release 既是 thenable（生产代码 await 它）也可直接当函数调用。
        const releaseHandle = Object.assign(
          () => resolveRelease(),
          {
            then: (
              onfulfilled?: (value: void) => unknown,
              onrejected?: (err: unknown) => unknown,
            ) => releasedPromise.then(onfulfilled, onrejected),
          },
        ) as (() => void) & PromiseLike<void>;

        try {
          // 浏览器语义：callback 返回的 Promise 一落定（resolve/reject）即放锁。
          Promise.resolve()
            .then(() => callback(releaseHandle))
            .then(
              () => doRelease(),
              () => doRelease(),
            );
        } catch {
          doRelease();
        }
      };
      let q = waitQueues.get(name);
      if (!q) {
        q = [];
        waitQueues.set(name, q);
      }
      q.push(wait);
      tryGrant(name);
    });
  },
  query: async () => ({ held: [], pending: [] }),
};

Object.defineProperty(navigator, 'locks', {
  value: locks,
  configurable: true,
  writable: true,
});
