import { beforeEach, describe, expect, it } from 'vitest';
import type { FrameContent } from '../../src/types';
import { _resetDatabaseForTests, loadFrame, loadUndoFrame } from '../../src/lib/db';
import { adoptCues } from './program';
import { ControllerSession, ViewerSession } from '../../src/lib/sessions';
import type { SessionSnapshot } from '../../src/lib/sessions';

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

const BLACK: FrameContent = {
  kind: 'blackout',
  cueId: null,
  source: '',
  translation: '',
};

function snap(s: { current: SessionSnapshot }): SessionSnapshot {
  return s.current;
}

const flush = (ms = 20) => new Promise((r) => setTimeout(r, ms));

beforeEach(async () => {
  await _resetDatabaseForTests();
  await adoptCues([cue('c1', 'Ah', '啊'), cue('c2', 'Oh', '哦')]);
});

describe('一次撤销上一帧的会话语义', () => {
  it('连续切句后撤销：只撤销最近一次，并以更高序号更新投影；不可重复撤销', async () => {
    const leader = new ControllerSession({ id: 'a', label: '甲台' });
    const viewer = new ViewerSession();
    void leader.enterContention();
    void viewer.hydrateFromStorage();
    await flush();

    expect(snap(leader).undo).toBeNull();
    await expect(leader.undoPreviousFrame()).rejects.toThrow(/可撤销/);

    await leader.publish(sub('c1', 'Ah', '啊'));
    await leader.publish(sub('c2', 'Oh', '哦'));
    await flush();
    expect(snap(viewer).frame).toMatchObject({
      generation: 1,
      sequence: 2,
      content: sub('c2', 'Oh', '哦'),
    });
    expect(snap(leader).undo?.publishedFrame.sequence).toBe(2);

    const undone = await leader.undoPreviousFrame();
    await flush();
    expect(undone.sequence).toBe(3);
    expect(undone.content).toEqual(sub('c1', 'Ah', '啊'));
    expect(snap(leader).frame?.sequence).toBe(3);
    expect(snap(leader).undo).toBeNull();
    expect(snap(viewer).frame).toMatchObject({
      generation: 1,
      sequence: 3,
      content: sub('c1', 'Ah', '啊'),
    });

    await expect(leader.undoPreviousFrame()).rejects.toThrow(/可撤销/);
    const stored = await loadFrame();
    expect(stored?.sequence).toBe(3);
    expect(stored?.content).toEqual(sub('c1', 'Ah', '啊'));
    expect(await loadUndoFrame()).toBeNull();

    leader.dispose();
    viewer.dispose();
  });

  it('普通黑场也可撤销，投影看到的是新序号黑场后的更高序号字幕', async () => {
    const leader = new ControllerSession({ id: 'a', label: '甲台' });
    const viewer = new ViewerSession();
    void leader.enterContention();
    void viewer.hydrateFromStorage();
    await flush();

    await leader.publish(sub('c1', 'Ah', '啊'));
    await leader.publish(BLACK);
    await flush();
    expect(snap(viewer).frame).toMatchObject({ sequence: 2, content: BLACK });

    const undone = await leader.undoPreviousFrame();
    await flush();
    expect(undone.sequence).toBe(3);
    expect(snap(viewer).frame).toMatchObject({
      sequence: 3,
      content: sub('c1', 'Ah', '啊'),
    });

    leader.dispose();
    viewer.dispose();
  });

  it('撤销事务失败时：控制台、投影与持久帧均不变，资格保留供重试', async () => {
    const leader = new ControllerSession({ id: 'a', label: '甲台' });
    const viewer = new ViewerSession();
    void leader.enterContention();
    void viewer.hydrateFromStorage();
    await flush();
    await leader.publish(sub('c1', 'Ah', '啊'));
    await leader.publish(sub('c2', 'Oh', '哦'));
    await flush();
    const undoBefore = snap(leader).undo;

    const originalPut = IDBObjectStore.prototype.put;
    let armed = true;
    IDBObjectStore.prototype.put = function patchedPut(
      this: IDBObjectStore,
      ...args: unknown[]
    ) {
      const value = args[0] as { key?: string };
      if (armed && value?.key === 'frame') {
        armed = false;
        throw new DOMException('QuotaExceededError', 'QuotaExceededError');
      }
      return originalPut.apply(this, args as [unknown, IDBValidKey?]);
    };

    await expect(leader.undoPreviousFrame()).rejects.toThrow();
    IDBObjectStore.prototype.put = originalPut;
    await flush();

    expect(snap(leader).frame?.sequence).toBe(2);
    expect(snap(leader).frame?.content).toEqual(sub('c2', 'Oh', '哦'));
    expect(snap(leader).undo).toEqual(undoBefore);
    expect(snap(viewer).frame?.sequence).toBe(2);
    expect(snap(viewer).frame?.content).toEqual(sub('c2', 'Oh', '哦'));
    expect((await loadFrame())?.sequence).toBe(2);
    expect(await loadUndoFrame()).toEqual(undoBefore);

    const retry = await leader.undoPreviousFrame();
    expect(retry.sequence).toBe(3);
    await flush();
    expect(snap(viewer).frame?.sequence).toBe(3);
    expect(snap(viewer).frame?.content).toEqual(sub('c1', 'Ah', '啊'));

    leader.dispose();
    viewer.dispose();
  });

  it('普通接管后新控制者没有旧资格；旧控制页不能撤销', async () => {
    const old = new ControllerSession({ id: 'old', label: '旧台' });
    const next = new ControllerSession({ id: 'new', label: '新台' });
    void old.enterContention();
    void next.enterContention();
    await flush();

    await old.publish(sub('c1', 'Ah', '啊'));
    expect(snap(old).undo).not.toBeNull();

    await old.standDown();
    await flush();
    await flush();
    expect(snap(next).status).toMatchObject({ role: 'leader', generation: 2 });
    expect(snap(next).undo).toBeNull();
    expect(snap(old).undo).toBeNull();

    await expect(old.undoPreviousFrame()).rejects.toThrow(/失去控制权/);
    await expect(next.undoPreviousFrame()).rejects.toThrow(/可撤销/);

    old.dispose();
    next.dispose();
  });

  it('指定交权后旧资格不得沿用，新控制者发布才产生新资格', async () => {
    const a = new ControllerSession({ id: 'a', label: '甲台' });
    const b = new ControllerSession({ id: 'b', label: '乙台' });
    const c = new ControllerSession({ id: 'c', label: '丙台' });
    void a.enterContention();
    void b.enterContention();
    void c.enterContention();
    await flush(30);

    await a.publish(sub('c1', 'Ah', '啊'));
    await a.designate('c', 5000);
    await flush(40);
    expect(snap(c).status).toMatchObject({ role: 'leader', generation: 2 });
    expect(snap(c).undo).toBeNull();

    await expect(c.undoPreviousFrame()).rejects.toThrow(/可撤销/);
    await c.publish(sub('c2', 'Oh', '哦'));
    expect(snap(c).undo?.generation).toBe(2);
    // 指定接权沿用上一确认句 c1 作为新代次首帧，因此新资格的前一帧是 c1。
    expect(snap(c).undo?.previousFrame.content).toEqual(sub('c1', 'Ah', '啊'));

    a.dispose();
    b.dispose();
    c.dispose();
  });

  it('收到同代次重新采用通知后内存资格立即失效，旧页面重试不会发布画面', async () => {
    const leader = new ControllerSession({ id: 'a', label: '甲台' });
    void leader.enterContention();
    await flush();
    await leader.publish(sub('c1', 'Ah', '啊'));
    expect(snap(leader).undo).not.toBeNull();

    const { CHANNEL_NAME } = await import('../../src/lib/sessions');
    new BroadcastChannel(CHANNEL_NAME).postMessage({
      type: 'program-adopted',
      frozenAt: Date.now(),
    });
    await flush();
    expect(snap(leader).undo).toBeNull();
    expect(await loadUndoFrame()).not.toBeNull(); // 消息本身不改库
    await expect(leader.undoPreviousFrame()).rejects.toThrow(/可撤销/);

    leader.dispose();
  });

  it('紧急锁定清除撤销资格，且之后不能借撤销恢复字幕', async () => {
    const leader = new ControllerSession({ id: 'a', label: '甲台' });
    void leader.enterContention();
    await flush();
    await leader.publish(sub('c1', 'Ah', '啊'));
    expect(snap(leader).undo).not.toBeNull();

    await leader.engageEmergencyBlackout();
    await flush();
    expect(snap(leader).undo).toBeNull();
    expect(await loadUndoFrame()).toBeNull();
    await expect(leader.undoPreviousFrame()).rejects.toThrow(/可撤销/);

    leader.dispose();
  });
});
