import { beforeEach, describe, expect, it } from 'vitest';
import type { Cue, FrameState, UndoRecord } from '../../src/types';
import {
  _putUndoForTests,
  _resetDatabaseForTests,
  BlackoutLockedError,
  ControllerMismatchError,
  CueNotInFrozenProgramError,
  engageBlackoutLock,
  loadBlackoutLock,
  loadFrame,
  loadPersisted,
  loadUndo,
  NothingToUndoError,
  publishFrame,
  releaseBlackoutLock,
  saveHandoff,
  startPerformance,
  StaleGenerationError,
  undoLastFrame,
  consumeHandoff,
} from '../../src/lib/db';
import { adoptCues } from './program';

function cue(id: string, source = 'la', translation = '啦'): Cue {
  return { id, kind: 'subtitle', source, translation, note: '' };
}

const BLACK = {
  kind: 'blackout' as const,
  cueId: null,
  source: '',
  translation: '',
};

async function frameAt(seq: number): Promise<FrameState> {
  const f = await loadFrame();
  expect(f?.sequence).toBe(seq);
  return f as FrameState;
}

beforeEach(async () => {
  await _resetDatabaseForTests();
  await adoptCues([
    cue('c1', 'Ah', '啊'),
    cue('c2', 'Oh', '哦'),
  ]);
});

describe('旧库存兼容', () => {
  it('没有 undo 键时 loadUndo / loadPersisted 按“不可撤销”读取', async () => {
    await startPerformance({ id: 'a', label: '甲台' });
    expect(await loadUndo()).toBeNull();
    const persisted = await loadPersisted();
    expect(persisted.undo).toBeNull();
  });
});

describe('普通发布：同事务保存当前帧与可撤销前一帧', () => {
  it('发布 cue 后 undo 记录资格：绑定代次 / 控制者 / 新帧序号，前一帧完整快照', async () => {
    const g = await startPerformance({ id: 'a', label: '甲台' });
    const seed = await frameAt(0);

    const f1 = await publishFrame({
      controllerId: 'a',
      generation: g.generation,
      content: { kind: 'subtitle', cueId: 'c1', source: 'Ah', translation: '啊' },
    });
    expect(f1.sequence).toBe(1);

    const undo = await loadUndo();
    expect(undo).not.toBeNull();
    expect(undo?.generation).toBe(g.generation);
    expect(undo?.controllerId).toBe('a');
    expect(undo?.publishSequence).toBe(1);
    expect(undo?.previousFrame).toEqual(seed);
  });

  it('连续发布整体覆盖资格：资格永远只针对最近一次普通发布', async () => {
    const g = await startPerformance({ id: 'a', label: '甲台' });
    await publishFrame({
      controllerId: 'a',
      generation: g.generation,
      content: { kind: 'subtitle', cueId: 'c1', source: 'Ah', translation: '啊' },
    });
    const f1 = await frameAt(1);
    await publishFrame({
      controllerId: 'a',
      generation: g.generation,
      content: { kind: 'subtitle', cueId: 'c2', source: 'Oh', translation: '哦' },
    });

    const undo = await loadUndo();
    expect(undo?.publishSequence).toBe(2);
    expect(undo?.previousFrame).toEqual(f1);
  });

  it('发布事务失败：新帧与撤销资格都不落盘（仍可撤销到更早的前一帧）', async () => {
    const g = await startPerformance({ id: 'a', label: '甲台' });
    await publishFrame({
      controllerId: 'a',
      generation: g.generation,
      content: { kind: 'subtitle', cueId: 'c1', source: 'Ah', translation: '啊' },
    });
    const before = await loadUndo();

    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function patchedPut(
      this: IDBObjectStore,
    ) {
      IDBObjectStore.prototype.put = originalPut;
      throw new DOMException('QuotaExceededError', 'QuotaExceededError');
    };
    await expect(
      publishFrame({
        controllerId: 'a',
        generation: g.generation,
        content: { kind: 'subtitle', cueId: 'c2', source: 'Oh', translation: '哦' },
      }),
    ).rejects.toThrow();

    // 帧停留在 c1，资格仍是发布 c2 之前那条（前一帧为黑场）。
    const frame = await loadFrame();
    expect(frame?.sequence).toBe(1);
    expect(frame?.content.cueId).toBe('c1');
    expect(await loadUndo()).toEqual(before);
  });
});

describe('撤销：前一帧以更高序号重新发布（不是回退序号）', () => {
  it('连续切句后撤销：恢复前一句且序号继续增大，投影端序号栅栏当新画面接受', async () => {
    const g = await startPerformance({ id: 'a', label: '甲台' });
    await publishFrame({
      controllerId: 'a',
      generation: g.generation,
      content: { kind: 'subtitle', cueId: 'c1', source: 'Ah', translation: '啊' },
    });
    await publishFrame({
      controllerId: 'a',
      generation: g.generation,
      content: { kind: 'subtitle', cueId: 'c2', source: 'Oh', translation: '哦' },
    });

    const restored = await undoLastFrame({
      controllerId: 'a',
      generation: g.generation,
    });
    // 序号严格大于被撤销的帧（2），绝不回退。
    expect(restored.sequence).toBe(3);
    expect(restored.content.cueId).toBe('c1');
    expect(restored.content.translation).toBe('啊');
    expect(restored.controllerId).toBe('a');

    const stored = await loadFrame();
    expect(stored).toEqual(restored);
    // 资格一次性：事务内已清除。
    expect(await loadUndo()).toBeNull();
  });

  it('误切到黑场后撤销：回到黑场之前的字幕（黑场也是普通发布，产生资格）', async () => {
    const g = await startPerformance({ id: 'a', label: '甲台' });
    await publishFrame({
      controllerId: 'a',
      generation: g.generation,
      content: { kind: 'subtitle', cueId: 'c1', source: 'Ah', translation: '啊' },
    });
    await publishFrame({
      controllerId: 'a',
      generation: g.generation,
      content: BLACK,
    });
    expect((await loadFrame())?.content.kind).toBe('blackout');

    const restored = await undoLastFrame({
      controllerId: 'a',
      generation: g.generation,
    });
    expect(restored.content.cueId).toBe('c1');
    expect(restored.sequence).toBe(3);
  });

  it('字幕误切后撤销可恢复到黑场（前一帧本身就是黑场）', async () => {
    const g = await startPerformance({ id: 'a', label: '甲台' });
    await publishFrame({
      controllerId: 'a',
      generation: g.generation,
      content: { kind: 'subtitle', cueId: 'c1', source: 'Ah', translation: '啊' },
    });
    // 撤销恢复开场黑场（seq2=黑场，内容=seq0 的前一帧）。
    const restored = await undoLastFrame({
      controllerId: 'a',
      generation: g.generation,
    });
    expect(restored.sequence).toBe(2);
    expect(restored.content).toEqual(BLACK);
    expect(await loadUndo()).toBeNull();
  });

  it('重复撤销：第二次抛 NothingToUndoError，画面与持久帧不变', async () => {
    const g = await startPerformance({ id: 'a', label: '甲台' });
    await publishFrame({
      controllerId: 'a',
      generation: g.generation,
      content: { kind: 'subtitle', cueId: 'c1', source: 'Ah', translation: '啊' },
    });
    const first = await undoLastFrame({
      controllerId: 'a',
      generation: g.generation,
    });
    expect(first.sequence).toBe(2);

    await expect(
      undoLastFrame({ controllerId: 'a', generation: g.generation }),
    ).rejects.toBeInstanceOf(NothingToUndoError);

    const stored = await loadFrame();
    expect(stored?.sequence).toBe(2);
    expect(stored?.content.cueId).toBeNull();
  });

  it('从未做过普通发布（开场即撤销）：NothingToUndoError，开场帧不变', async () => {
    const g = await startPerformance({ id: 'a', label: '甲台' });
    await expect(
      undoLastFrame({ controllerId: 'a', generation: g.generation }),
    ).rejects.toBeInstanceOf(NothingToUndoError);
    const f = await loadFrame();
    expect(f?.sequence).toBe(0);
  });
});

describe('撤销资格的栅栏：仅限当前控制者、当前代次、当前帧', () => {
  it('接管后的旧代次页面重试撤销：StaleGenerationError，画面保持新代次', async () => {
    const g1 = await startPerformance({ id: 'old', label: '旧台' });
    await publishFrame({
      controllerId: 'old',
      generation: g1.generation,
      content: { kind: 'subtitle', cueId: 'c1', source: 'Ah', translation: '啊' },
    });
    // 新控制者接管（接管事务已清除撤销资格并开第二代）。
    const g2 = await startPerformance({ id: 'new', label: '新台' });

    await expect(
      undoLastFrame({ controllerId: 'old', generation: g1.generation }),
    ).rejects.toBeInstanceOf(StaleGenerationError);

    const frame = await loadFrame();
    expect(frame?.generation).toBe(g2.generation);
    expect(frame?.sequence).toBe(0);
  });

  it('新代次控制者没有撤销资格：NothingToUndoError', async () => {
    const g1 = await startPerformance({ id: 'old', label: '旧台' });
    await publishFrame({
      controllerId: 'old',
      generation: g1.generation,
      content: { kind: 'subtitle', cueId: 'c1', source: 'Ah', translation: '啊' },
    });
    const g2 = await startPerformance({ id: 'new', label: '新台' });
    expect(await loadUndo()).toBeNull();
    await expect(
      undoLastFrame({ controllerId: 'new', generation: g2.generation }),
    ).rejects.toBeInstanceOf(NothingToUndoError);
  });

  it('指定交权：接权事务清除旧资格，被指定页与旧页都不能撤销', async () => {
    const g1 = await startPerformance({ id: 'a', label: '甲台' });
    await publishFrame({
      controllerId: 'a',
      generation: g1.generation,
      content: { kind: 'subtitle', cueId: 'c1', source: 'Ah', translation: '啊' },
    });
    const record = {
      generation: g1.generation,
      version: 'v-undo',
      sourceId: 'a',
      targetId: 'c',
      expiresAt: Date.now() + 5000,
    };
    await saveHandoff(record);

    const taken = await consumeHandoff({
      controller: { id: 'c', label: '丙台' },
      version: 'v-undo',
      initialContent: {
        kind: 'subtitle',
        cueId: 'c1',
        source: 'Ah',
        translation: '啊',
      },
    });
    expect(taken.generation).toBe(2);
    expect(await loadUndo()).toBeNull();

    await expect(
      undoLastFrame({ controllerId: 'c', generation: 2 }),
    ).rejects.toBeInstanceOf(NothingToUndoError);
    // 旧页同时代次过期。
    await expect(
      undoLastFrame({ controllerId: 'a', generation: 1 }),
    ).rejects.toBeInstanceOf(StaleGenerationError);
  });

  it('同代次冒充者撤销：ControllerMismatchError，画面不变', async () => {
    const g = await startPerformance({ id: 'a', label: '甲台' });
    await publishFrame({
      controllerId: 'a',
      generation: g.generation,
      content: { kind: 'subtitle', cueId: 'c1', source: 'Ah', translation: '啊' },
    });
    await expect(
      undoLastFrame({ controllerId: 'impostor', generation: g.generation }),
    ).rejects.toBeInstanceOf(ControllerMismatchError);
    expect((await loadFrame())?.content.cueId).toBe('c1');
  });

  it('资格指向旧帧（其间又确认了新画面 / 旧页重试）：NothingToUndoError，当前帧不变', async () => {
    const g = await startPerformance({ id: 'a', label: '甲台' });
    await publishFrame({
      controllerId: 'a',
      generation: g.generation,
      content: { kind: 'subtitle', cueId: 'c1', source: 'Ah', translation: '啊' },
    });
    await publishFrame({
      controllerId: 'a',
      generation: g.generation,
      content: { kind: 'subtitle', cueId: 'c2', source: 'Oh', translation: '哦' },
    });
    // 构造异常时序：资格指向 seq1（当前帧已是 seq2）。
    const stale: UndoRecord = {
      generation: g.generation,
      controllerId: 'a',
      publishSequence: 1,
      previousFrame: (await loadFrame()) as FrameState,
      createdAt: 1,
    };
    await _putUndoForTests(stale);

    await expect(
      undoLastFrame({ controllerId: 'a', generation: g.generation }),
    ).rejects.toBeInstanceOf(NothingToUndoError);
    expect((await loadFrame())?.sequence).toBe(2);
    expect((await loadFrame())?.content.cueId).toBe('c2');
  });
});

describe('撤销与重新采用：目标 cue 已不属于当前冻结节目单则拒绝', () => {
  it('前一帧字幕在重新采用中被删除：撤销拒绝，当前黑场帧不变', async () => {
    const g = await startPerformance({ id: 'a', label: '甲台' });
    await publishFrame({
      controllerId: 'a',
      generation: g.generation,
      content: { kind: 'subtitle', cueId: 'c1', source: 'Ah', translation: '啊' },
    });
    await publishFrame({
      controllerId: 'a',
      generation: g.generation,
      content: BLACK,
    });
    // 重新采用：c1 被删除，只剩 c2。
    await adoptCues([cue('c2', 'Oh', '哦')]);

    await expect(
      undoLastFrame({ controllerId: 'a', generation: g.generation }),
    ).rejects.toBeInstanceOf(CueNotInFrozenProgramError);

    const f = await loadFrame();
    expect(f?.sequence).toBe(2);
    expect(f?.content.kind).toBe('blackout');
  });

  it('前一帧字幕文案被改写：拒绝恢复旧文案', async () => {
    const g = await startPerformance({ id: 'a', label: '甲台' });
    await publishFrame({
      controllerId: 'a',
      generation: g.generation,
      content: { kind: 'subtitle', cueId: 'c1', source: 'Ah', translation: '啊' },
    });
    await publishFrame({
      controllerId: 'a',
      generation: g.generation,
      content: { kind: 'subtitle', cueId: 'c2', source: 'Oh', translation: '哦' },
    });
    // 此时撤销资格的前一帧是旧文案 c1；重新采用改写 c1。
    await adoptCues([cue('c1', 'Ah-Nuovo', '啊-改'), cue('c2', 'Oh', '哦')]);

    await expect(
      undoLastFrame({ controllerId: 'a', generation: g.generation }),
    ).rejects.toBeInstanceOf(CueNotInFrozenProgramError);
    // 当前帧（c2）原样保留。
    expect((await loadFrame())?.content.cueId).toBe('c2');
    expect((await loadFrame())?.sequence).toBe(2);
  });

  it('目标仍在且未改写：重新采用不影响撤销（前一帧为合法黑场时也可恢复）', async () => {
    const g = await startPerformance({ id: 'a', label: '甲台' });
    await publishFrame({
      controllerId: 'a',
      generation: g.generation,
      content: { kind: 'subtitle', cueId: 'c1', source: 'Ah', translation: '啊' },
    });
    // 重新采用只动 c2，c1 逐字未变；撤销恢复开场黑场（显式黑场始终合法）。
    await adoptCues([
      cue('c1', 'Ah', '啊'),
      cue('c2', 'Oh-Nuovo', '哦-改'),
    ]);
    const restored = await undoLastFrame({
      controllerId: 'a',
      generation: g.generation,
    });
    expect(restored.content).toEqual(BLACK);
    expect(restored.sequence).toBe(2);
  });
});

describe('撤销与紧急黑场锁定', () => {
  it('紧急锁定事务删除撤销资格：锁定后不能撤销回锁定前字幕', async () => {
    const g = await startPerformance({ id: 'a', label: '甲台' });
    await publishFrame({
      controllerId: 'a',
      generation: g.generation,
      content: { kind: 'subtitle', cueId: 'c1', source: 'Ah', translation: '啊' },
    });
    expect(await loadUndo()).not.toBeNull();

    await engageBlackoutLock({
      controllerId: 'a',
      controllerLabel: '甲台',
      generation: g.generation,
    });
    expect(await loadUndo()).toBeNull();

    await expect(
      undoLastFrame({ controllerId: 'a', generation: g.generation }),
    ).rejects.toBeInstanceOf(NothingToUndoError);
    // 画面保持锁定黑场，锁定记录完好。
    expect((await loadFrame())?.content.kind).toBe('blackout');
    expect(await loadBlackoutLock()).not.toBeNull();
  });

  it('锁定中的单帧黑场不产生撤销资格；解除锁定后仍不可撤销', async () => {
    const g = await startPerformance({ id: 'a', label: '甲台' });
    await engageBlackoutLock({
      controllerId: 'a',
      controllerLabel: '甲台',
      generation: g.generation,
    });
    await publishFrame({
      controllerId: 'a',
      generation: g.generation,
      content: BLACK,
    });
    expect(await loadUndo()).toBeNull();

    await releaseBlackoutLock({ controllerId: 'a', generation: g.generation });
    await expect(
      undoLastFrame({ controllerId: 'a', generation: g.generation }),
    ).rejects.toBeInstanceOf(NothingToUndoError);
  });

  it('纵深防御：锁定中即便残留指向字幕的资格也被 BlackoutLockedError 拦截', async () => {
    const g = await startPerformance({ id: 'a', label: '甲台' });
    await publishFrame({
      controllerId: 'a',
      generation: g.generation,
      content: { kind: 'subtitle', cueId: 'c1', source: 'Ah', translation: '啊' },
    });
    const current = (await loadFrame()) as FrameState;
    // 直接构造“锁定 + 资格指向当前字幕帧”的异常库存。
    await engageBlackoutLock({
      controllerId: 'a',
      controllerLabel: '甲台',
      generation: g.generation,
    });
    const lockFrame = (await loadFrame()) as FrameState;
    await _putUndoForTests({
      generation: g.generation,
      controllerId: 'a',
      publishSequence: lockFrame.sequence,
      previousFrame: current,
      createdAt: 2,
    });

    await expect(
      undoLastFrame({ controllerId: 'a', generation: g.generation }),
    ).rejects.toBeInstanceOf(BlackoutLockedError);
    expect((await loadFrame())?.sequence).toBe(lockFrame.sequence);
  });
});

describe('撤销事务写入失败：整体回滚', () => {
  it('撤销的 put 失败：当前帧与资格都保留，恢复后可重试成功', async () => {
    const g = await startPerformance({ id: 'a', label: '甲台' });
    await publishFrame({
      controllerId: 'a',
      generation: g.generation,
      content: { kind: 'subtitle', cueId: 'c1', source: 'Ah', translation: '啊' },
    });
    await publishFrame({
      controllerId: 'a',
      generation: g.generation,
      content: { kind: 'subtitle', cueId: 'c2', source: 'Oh', translation: '哦' },
    });
    const undoBefore = await loadUndo();

    const originalDelete = IDBObjectStore.prototype.delete;
    IDBObjectStore.prototype.delete = function patchedDelete(
      this: IDBObjectStore,
    ) {
      IDBObjectStore.prototype.delete = originalDelete;
      throw new DOMException('QuotaExceededError', 'QuotaExceededError');
    };
    await expect(
      undoLastFrame({ controllerId: 'a', generation: g.generation }),
    ).rejects.toThrow();

    // 帧仍是 c2、资格仍在（旧控制页 / 重试语义：没有任何已确认变更）。
    const f = await loadFrame();
    expect(f?.sequence).toBe(2);
    expect(f?.content.cueId).toBe('c2');
    expect(await loadUndo()).toEqual(undoBefore);

    const restored = await undoLastFrame({
      controllerId: 'a',
      generation: g.generation,
    });
    expect(restored.content.cueId).toBe('c1');
    expect(restored.sequence).toBe(3);
    expect(await loadUndo()).toBeNull();
  });
});
