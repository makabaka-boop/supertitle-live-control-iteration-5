import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FrameContent, FrameState } from '../../src/types';
import {
  _resetDatabaseForTests,
  _putUndoForTests,
  loadFrame,
  NothingToUndoError,
} from '../../src/lib/db';
import { adoptCues } from './program';
import {
  CHANNEL_NAME,
  ControllerSession,
  ViewerSession,
  announceProgramAdoption,
} from '../../src/lib/sessions';
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

function snap(session: { current: SessionSnapshot }): SessionSnapshot {
  return session.current;
}

const flush = () => new Promise((r) => setTimeout(r, 20));

async function waitForRole(
  s: ControllerSession,
  role: string,
  tries = 20,
): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (snap(s).status.role === role) return;
    await flush();
  }
  expect(snap(s).status.role).toBe(role);
}

async function becomeLeader(id: string, label = '甲'): Promise<ControllerSession> {
  const s = new ControllerSession({ id, label });
  void s.enterContention();
  await flush();
  expect(snap(s).status.role).toBe('leader');
  return s;
}

beforeEach(async () => {
  await _resetDatabaseForTests();
  await adoptCues([cue('c1', 'Ah', '啊'), cue('c2', 'Oh', '哦')]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('撤销上一帧：控制台与投影联动', () => {
  it('连续切句后撤销：控制台与投影都显示前一句，帧序号继续增大', async () => {
    const viewer = new ViewerSession();
    void viewer.hydrateFromStorage();
    const leader = await becomeLeader('a');

    await leader.publish(sub('c1', 'Ah', '啊'));
    await flush();
    await leader.publish(sub('c2', 'Oh', '哦'));
    await flush();
    expect(snap(viewer).frame?.content.translation).toBe('哦');
    expect(snap(leader).canUndo).toBe(true);

    const restored = await leader.undoLastFrame();
    await flush();

    // 撤销不是回退序号：seq 3 > 被撤销的 seq 2。
    expect(restored.sequence).toBe(3);
    expect(restored.content.translation).toBe('啊');
    expect(snap(leader).frame?.content.translation).toBe('啊');
    expect(snap(leader).canUndo).toBe(false);
    expect(snap(viewer).frame?.sequence).toBe(3);
    expect(snap(viewer).frame?.content.translation).toBe('啊');

    leader.dispose();
    viewer.dispose();
  });

  it('误切普通黑场后撤销：投影从黑场回到黑场之前的字幕', async () => {
    const viewer = new ViewerSession();
    void viewer.hydrateFromStorage();
    const leader = await becomeLeader('a');

    await leader.publish(sub('c1', 'Ah', '啊'));
    await flush();
    await leader.publish(BLACK);
    await flush();
    expect(snap(viewer).frame?.content.kind).toBe('blackout');

    await leader.undoLastFrame();
    await flush();
    expect(snap(viewer).frame?.content.kind).toBe('subtitle');
    expect(snap(viewer).frame?.content.translation).toBe('啊');
    expect(snap(leader).canUndo).toBe(false);

    leader.dispose();
    viewer.dispose();
  });

  it('重复撤销：第二次拒绝且控制台 / 投影 / 持久帧都不变', async () => {
    const viewer = new ViewerSession();
    void viewer.hydrateFromStorage();
    const leader = await becomeLeader('a');

    await leader.publish(sub('c1', 'Ah', '啊'));
    await flush();
    await leader.undoLastFrame();
    await flush();
    const seqOnce = snap(viewer).frame?.sequence;
    expect(seqOnce).toBe(2);

    await expect(leader.undoLastFrame()).rejects.toBeInstanceOf(NothingToUndoError);
    await flush();

    expect(snap(leader).canUndo).toBe(false);
    expect(snap(viewer).frame?.sequence).toBe(seqOnce);
    expect((await loadFrame())?.sequence).toBe(seqOnce);

    leader.dispose();
    viewer.dispose();
  });

  it('数据库先提交才广播：撤销事务失败时不发帧，控制台 / 投影 / 持久帧停留当前帧', async () => {
    const viewer = new ViewerSession();
    void viewer.hydrateFromStorage();
    const leader = await becomeLeader('a');

    await leader.publish(sub('c1', 'Ah', '啊'));
    await flush();
    await leader.publish(sub('c2', 'Oh', '哦'));
    await flush();

    // 让撤销事务的第一次写入失败。
    const originalDelete = IDBObjectStore.prototype.delete;
    IDBObjectStore.prototype.delete = function patchedDelete(
      this: IDBObjectStore,
    ) {
      IDBObjectStore.prototype.delete = originalDelete;
      throw new DOMException('QuotaExceededError', 'QuotaExceededError');
    };
    await expect(leader.undoLastFrame()).rejects.toThrow();
    IDBObjectStore.prototype.delete = originalDelete;
    await flush();

    // 控制台、投影、持久帧全部停留在 c2 / seq2。
    expect(snap(leader).frame?.content.translation).toBe('哦');
    expect(snap(viewer).frame?.content.translation).toBe('哦');
    expect(snap(viewer).frame?.sequence).toBe(2);
    const stored = await loadFrame();
    expect(stored?.content.translation).toBe('哦');
    expect(stored?.sequence).toBe(2);

    // 资格仍在：恢复后重试撤销成功（证明失败没有消费资格）。
    expect(snap(leader).canUndo).toBe(true);
    const restored = await leader.undoLastFrame();
    expect(restored.content.translation).toBe('啊');
    expect(restored.sequence).toBe(3);

    leader.dispose();
    viewer.dispose();
  });
});

describe('撤销资格随交权 / 接管 / 重新采用失效', () => {
  it('普通接管：新代次控制者 canUndo=false，撤销被拒，旧页失锁不能撤销', async () => {
    const a = await becomeLeader('a');
    await a.publish(sub('c1', 'Ah', '啊'));
    await flush();

    const b = new ControllerSession({ id: 'b', label: '乙' });
    void b.enterContention();
    await flush();
    expect(snap(b).status.role).toBe('waiting');

    await a.standDown();
    await waitForRole(b, 'leader');
    await waitForRole(a, 'lost');
    expect(snap(b).canUndo).toBe(false);

    await expect(b.undoLastFrame()).rejects.toBeInstanceOf(NothingToUndoError);
    await expect(a.undoLastFrame()).rejects.toThrow(/失去控制权/);

    a.dispose();
    b.dispose();
  });

  it('重新采用：持锁主控收到通知后 canUndo 立即为假；再撤销时目标 cue 已删除也被事务拒绝', async () => {
    const leader = await becomeLeader('a');
    await leader.publish(sub('c1', 'Ah', '啊'));
    await flush();
    await leader.publish(BLACK);
    await flush();
    expect(snap(leader).canUndo).toBe(true);

    // 重新采用：删掉 c1（编辑页同事务归档 + 冻结），随后发总线通知。
    await adoptCues([cue('c2', 'Oh', '哦')]);
    announceProgramAdoption(Date.now());
    await flush();
    expect(snap(leader).canUndo).toBe(false);
    expect(snap(leader).programVersion).not.toBeNull();

    // UI 被禁用，但即便强行调用，持久事务也以冻结栅栏拒绝，画面保持黑场。
    await expect(leader.undoLastFrame()).rejects.toThrow();
    expect((await loadFrame())?.content.kind).toBe('blackout');

    leader.dispose();
  });

  it('紧急黑场锁定后 canUndo=false，锁定期间单帧黑场不产生新资格', async () => {
    const leader = await becomeLeader('a');
    await leader.publish(sub('c1', 'Ah', '啊'));
    await flush();
    expect(snap(leader).canUndo).toBe(true);

    await leader.engageEmergencyBlackout();
    await flush();
    expect(snap(leader).canUndo).toBe(false);

    await leader.publish(BLACK);
    await flush();
    expect(snap(leader).canUndo).toBe(false);

    await expect(leader.undoLastFrame()).rejects.toBeInstanceOf(NothingToUndoError);

    leader.dispose();
  });
});

describe('撤销与投影端栅栏：迟到旧帧不能覆盖撤销后的新确认画面', () => {
  it('撤销帧序号更高；随后旧控制页注入的旧序号 / 同序号幽灵帧一律被投影丢弃', async () => {
    const viewer = new ViewerSession();
    void viewer.hydrateFromStorage();
    const leader = await becomeLeader('a');

    await leader.publish(sub('c1', 'Ah', '啊'));
    await flush();
    await leader.publish(sub('c2', 'Oh', '哦'));
    await flush();
    await leader.undoLastFrame();
    await flush();
    expect(snap(viewer).frame?.content.translation).toBe('啊');
    expect(snap(viewer).frame?.sequence).toBe(3);

    // 迟到广播：被撤销的 c2 帧（seq2）重放到总线——序号栅栏直接丢弃。
    const ghost: FrameState = {
      generation: 1,
      sequence: 2,
      controllerId: 'a',
      controllerLabel: '甲',
      content: sub('c2', 'Oh', '哦'),
      publishedAt: Date.now(),
    };
    new BroadcastChannel(CHANNEL_NAME).postMessage({ type: 'frame', frame: ghost });
    await flush();
    expect(snap(viewer).frame?.sequence).toBe(3);
    expect(snap(viewer).frame?.content.translation).toBe('啊');

    // 同序号重放同样丢弃。
    new BroadcastChannel(CHANNEL_NAME).postMessage({
      type: 'frame',
      frame: { ...ghost, sequence: 3 },
    });
    await flush();
    expect(snap(viewer).frame?.content.translation).toBe('啊');

    leader.dispose();
    viewer.dispose();
  });

  it('接管后旧代次页面持有的旧撤销资格重试：代次栅栏拒绝，画面保持新代次', async () => {
    const a = await becomeLeader('a');
    await a.publish(sub('c1', 'Ah', '啊'));
    await flush();

    const b = new ControllerSession({ id: 'b', label: '乙' });
    void b.enterContention();
    await flush();
    await a.standDown();
    await waitForRole(b, 'leader');
    const genB = (snap(b).status as { generation: number }).generation;
    expect(genB).toBe(2);

    // 异常时序：手工塞一条旧代次资格，旧页若绕过本地失锁检查直调持久层也被拦。
    const current = (await loadFrame()) as FrameState;
    await _putUndoForTests({
      generation: 1,
      controllerId: 'a',
      publishSequence: current.sequence,
      previousFrame: current,
      createdAt: 1,
    });
    // 新控制者身份 / 代次均不匹配该资格：NothingToUndo（资格代次不符）。
    await expect(b.undoLastFrame()).rejects.toBeInstanceOf(NothingToUndoError);
    expect((await loadFrame())?.generation).toBe(2);

    a.dispose();
    b.dispose();
  });
});
