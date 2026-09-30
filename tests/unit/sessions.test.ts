import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FrameContent } from '../../src/types';
import {
  _resetDatabaseForTests,
  loadFrame,
} from '../../src/lib/db';
import { adoptCues } from './program';
import { ControllerSession, ViewerSession } from '../../src/lib/sessions';
import type { SessionSnapshot } from '../../src/lib/sessions';
import type { FrameState } from '../../src/types';

const cue = (id: string, source: string, translation: string) => ({
  id,
  kind: 'subtitle' as const,
  source,
  translation,
  note: '',
});

const sub = (id: string, s: string, t: string): FrameContent => ({
  kind: 'subtitle',
  cueId: id,
  source: s,
  translation: t,
});

function snap(session: { current: SessionSnapshot }): SessionSnapshot {
  return session.current;
}

const flush = () => new Promise((r) => setTimeout(r, 20));

beforeEach(async () => {
  await _resetDatabaseForTests();
  await adoptCues([cue('c1', 'Ah', '啊'), cue('c2', 'Oh', '哦')]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('唯一锁竞争与接管', () => {
  it('先入者持锁成为 leader；后入者等待，释放后自动接管为新代次', async () => {
    const first = new ControllerSession({ id: 'a', label: '甲' });
    void first.enterContention();
    await flush();
    expect(snap(first).status.role).toBe('leader');
    const genA = (snap(first).status as { generation: number }).generation;
    expect(genA).toBe(1);

    const second = new ControllerSession({ id: 'b', label: '乙' });
    void second.enterContention();
    await flush();
    expect(snap(second).status.role).toBe('waiting');

    // 甲发布一句并确认。
    await first.publish(sub('c1', 'Ah', '啊'));
    await flush();

    await first.standDown();
    await flush();
    expect(snap(first).status.role).toBe('lost');

    await flush();
    expect(snap(second).status.role).toBe('leader');
    const genB = (snap(second).status as { generation: number }).generation;
    expect(genB).toBe(genA + 1);

    // 接管时沿用上一代画面，观众不闪黑。
    expect(snap(second).frame?.content.translation).toBe('啊');
    expect(snap(second).frame?.generation).toBe(genB);
    expect(snap(second).frame?.sequence).toBe(0);

    first.dispose();
    second.dispose();
  });

  it('失锁旧页立即禁用：publish 被本地状态拦截', async () => {
    const first = new ControllerSession({ id: 'a', label: '甲' });
    void first.enterContention();
    await flush();

    const second = new ControllerSession({ id: 'b', label: '乙' });
    void second.enterContention();
    await flush();

    await first.standDown();
    await flush();
    await flush();
    expect(snap(second).status.role).toBe('leader');
    expect(snap(first).status.role).toBe('lost');

    await expect(first.publish(sub('c2', 'late', '迟到'))).rejects.toThrow(
      /失去控制权/,
    );

    const stored = await loadFrame();
    expect(stored?.content.source).not.toBe('late');

    first.dispose();
    second.dispose();
  });
});

describe('观众投影的代次栅栏', () => {
  it('迟到的旧代次消息不能覆盖新代次确认画面', async () => {
    const viewer = new ViewerSession();
    await viewer.hydrateFromStorage();

    const first = new ControllerSession({ id: 'a', label: '甲' });
    void first.enterContention();
    await flush();
    // 发布内容与冻结条目逐字一致（c1=Ah/啊）；栅栏测试用下面构造的幽灵帧。
    await first.publish(sub('c1', 'Ah', '啊'));
    await flush();
    expect(snap(viewer).frame?.generation).toBe(1);

    // 第二代接管并发新画面。
    const second = new ControllerSession({ id: 'b', label: '乙' });
    void second.enterContention();
    await first.standDown();
    await flush();
    await flush();
    await second.publish(sub('c2', 'Oh', '哦'));
    await flush();
    expect(snap(viewer).frame?.generation).toBe(2);
    expect(snap(viewer).frame?.content.translation).toBe('哦');

    // 旧页在失锁前构造好的迟到帧（gen 1, seq 很大）抵达总线。
    const lateFrame: FrameState = {
      generation: 1,
      sequence: 9999,
      controllerId: 'a',
      controllerLabel: '甲',
      content: sub('c1', 'G1-LATE', '旧页迟到'),
      publishedAt: Date.now(),
    };
    // 通过真实通道发送，确保走 onmessage。
    const { CHANNEL_NAME } = await import('../../src/lib/sessions');
    new BroadcastChannel(CHANNEL_NAME).postMessage({
      type: 'frame',
      frame: lateFrame,
    });
    await flush();

    expect(snap(viewer).frame?.generation).toBe(2);
    expect(snap(viewer).frame?.content.source).toBe('Oh');

    // 同代次旧序号也被拒。
    new BroadcastChannel(CHANNEL_NAME).postMessage({
      type: 'frame',
      frame: { ...lateFrame, generation: 2, sequence: 0 },
    });
    await flush();
    expect(snap(viewer).frame?.sequence).toBe(1);

    first.dispose();
    second.dispose();
    viewer.dispose();
  });

  it('投影重开读取持久状态，看到的是最后确认画面', async () => {
    const first = new ControllerSession({ id: 'a', label: '甲' });
    void first.enterContention();
    await flush();
    await first.publish(sub('c1', 'Ah', '啊'));
    await flush();
    first.dispose();
    await flush();

    const reopened = new ViewerSession();
    await reopened.hydrateFromStorage();
    expect(snap(reopened).frame?.content.source).toBe('Ah');
    reopened.dispose();
  });
});

describe('写入失败：保持上一幅确认画面', () => {
  it('事务写入抛错时 publish reject，持久层与本地仍是旧画面', async () => {
    const leader = new ControllerSession({ id: 'a', label: '甲' });
    void leader.enterContention();
    await flush();
    // 内容须与冻结条目逐字一致，避免先被“最新冻结节目”栅栏拦截。
    await leader.publish(sub('c1', 'Ah', '啊'));
    await flush();
    expect(snap(leader).frame?.content.translation).toBe('啊');

    // 让下一次 put 失败（模拟磁盘 / Quota 错误）。
    const originalPut = IDBObjectStore.prototype.put;
    let armed = true;
    IDBObjectStore.prototype.put = function patchedPut(
      this: IDBObjectStore,
      ...args: unknown[]
    ) {
      if (armed) {
        armed = false;
        throw new DOMException('QuotaExceededError', 'QuotaExceededError');
      }
      return originalPut.apply(this, args as [unknown, IDBValidKey?]);
    };

    await expect(
      leader.publish(sub('c2', 'Oh', '哦')),
    ).rejects.toThrow();
    IDBObjectStore.prototype.put = originalPut;

    // 本地快照与持久状态都停留在上一幅确认画面。
    expect(snap(leader).frame?.content.source).toBe('Ah');
    const stored = await loadFrame();
    expect(stored?.content.source).toBe('Ah');

    // 错误恢复后下一次发布正常，序号从事务确认的真实值继续。
    const ok = await leader.publish(sub('c2', 'Oh', '哦'));
    expect(ok.sequence).toBe(2);
    expect((await loadFrame())?.content.source).toBe('Oh');

    leader.dispose();
  });
});
