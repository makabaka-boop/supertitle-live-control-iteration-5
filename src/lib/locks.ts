// Web Locks 封装：跨页面（含投影页、其他控制页）竞争同一把排他锁。
// 胜者才是唯一有效操控者；持锁页面崩溃 / 关闭时浏览器自动释放，
// 等待队列中的下一个页面获得回调并接管。
//
// 除“失锁退出”外，持锁页还可以 yieldAndRequeue：按持久交接记录裁决自己
// 不是被指定目标时，主动让锁、等待一小段时间后重新排队，整个过程不开新
// 代次、不触发 lost（本页仍是候选）；被指定页接管或授权过期后由
// wakeYield 提前唤醒，保证系统不因目标关闭 / 超时而停摆。

export const LOCK_NAME = 'opera-stage-controller';

export type LockState = 'idle' | 'waiting' | 'leader';

export interface StageLockEvents {
  /** 获得锁，成为当前唯一控制者（随后按持久状态裁决如何使用锁）。 */
  granted(): void;
  /**
   * 锁最终离开本页（页面被回收、steal、或主动退场）。
   * yieldAndRequeue 不算 lost：那只是不改代次地让锁重排队。
   * 本页必须立即禁用一切操控动作；迟到消息在投影侧由代次栅栏拦截。
   */
  lost(): void;
}

function interruptibleSleep(
  delayMs: number,
  waker: { wake: () => void },
): Promise<void> {
  if (delayMs <= 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      waker.wake = () => {};
      resolve();
    }, delayMs);
    waker.wake = () => {
      clearTimeout(timer);
      waker.wake = () => {};
      resolve();
    };
  });
}

export class StageLock {
  state: LockState = 'idle';
  private release: (() => void) | null = null;
  private stopped = false;
  private reattempt = false;
  private yieldDelayMs = 0;
  private yieldWaker: { wake: () => void } = { wake: () => {} };

  constructor(private readonly events: StageLockEvents) {}

  /**
   * 进入竞争队列；获锁后回调 granted。回调可调用 yieldAndRequeue 让锁
   * 重排队（不开新代次），也可调用 releaseLock 退场。页面关闭 / 崩溃时
   * 浏览器直接回收锁，等待页照常被授予。
   */
  async acquire(): Promise<void> {
    if (this.state !== 'idle') return;
    this.stopped = false;

    while (!this.stopped) {
      this.state = 'waiting';
      let requeue = false;

      await navigator.locks.request(
        LOCK_NAME,
        // 独占模式（默认），同一时刻全源只有一个 granted。
        () =>
          new Promise<void>((resolve) => {
            if (this.stopped) {
              // releaseLock 在 granted 前就被调用的极端时序。
              resolve();
              return;
            }
            this.release = resolve;
            this.state = 'leader';
            try {
              this.events.granted();
            } catch {
              // 事件回调异常不能把锁卡死：清理状态并让外层统一走 lost。
              this.release = null;
              this.state = 'idle';
              resolve();
            }
          }),
      );

      // 锁回调结束（resolve 被调用）。区分：yield 重排队 vs 最终退场。
      if (this.reattempt && !this.stopped) {
        requeue = true;
      }
      this.reattempt = false;
      this.release = null;

      if (!requeue) break;

      // 等待期间本页不持锁也不持代次；被唤醒（新控制者 / 授权到期附近）
      // 或延迟结束后重新排队，由持久状态再次裁决。
      this.state = 'waiting';
      await interruptibleSleep(this.yieldDelayMs, this.yieldWaker);
      this.yieldDelayMs = 0;
      if (this.stopped) break;
    }

    this.state = 'idle';
    this.release = null;
    this.events.lost();
  }

  /**
   * 让锁并在 delayMs 后重新排队（不改代次、不触发 lost）。
   * 必须在 granted 回调（及其异步延续）中调用：仅设置重排队标记并放锁。
   */
  async yieldAndRequeue(delayMs: number): Promise<void> {
    this.reattempt = true;
    this.yieldDelayMs = Math.max(0, delayMs);
    const r = this.release;
    this.release = null;
    if (r) r();
  }

  /** 提前结束 yield 等待（例如看到更新代次的控制者广播）。 */
  wakeYield(): void {
    this.yieldWaker.wake();
  }

  /** 主动退场（“退场交权”按钮或页面卸载）：触发 lost，不再重排队。 */
  async releaseLock(): Promise<void> {
    this.stopped = true;
    this.reattempt = false;
    this.yieldWaker.wake();
    const r = this.release;
    this.release = null;
    if (r) r();
  }

  get isLeader(): boolean {
    return this.state === 'leader';
  }
}

/** 查询当前锁占用情况（诊断用：列出持锁 / 等待者）。 */
export async function queryLock(): Promise<LockManagerSnapshot | null> {
  if (typeof navigator === 'undefined' || !navigator.locks?.query) {
    return null;
  }
  return navigator.locks.query();
}
