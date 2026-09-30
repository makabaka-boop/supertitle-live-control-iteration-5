import { beforeEach, describe, expect, it } from 'vitest';
import type { Cue, FrameState, UndoFrameEligibility } from '../../src/types';
import {
  _resetDatabaseForTests,
  BlackoutLockedError,
  ControllerMismatchError,
  CueNotInFrozenProgramError,
  engageBlackoutLock,
  loadFrame,
  loadUndoFrame,
  openDb,
  publishFrame,
  saveHandoff,
  startPerformance,
  StaleGenerationError,
  consumeHandoff,
  UndoNotAvailableError,
  UndoTargetMismatchError,
  undoPreviousFrame,
} from '../../src/lib/db';
import { adoptCues } from './program';

function cue(id: string, source = 'la', translation = '啦'): Cue {
  return { id, kind: 'subtitle', source, translation, note: '' };
}

const BLACK = { kind: 'blackout' as const, cueId: null, source: '', translation: '' };
const C1 = { kind: 'subtitle' as const, cueId: 'c1', source: 'Ah', translation: '啊' };
const C2 = { kind: 'subtitle' as const, cueId: 'c2', source: 'Oh', translation: '哦' };

async function putUndo(undo: UndoFrameEligibility): Promise<void> {
  const db = await openDb();
  const tx = db.transaction('kv', 'readwrite');
  tx.objectStore('kv').put({ key: 'undo-frame', value: undo });
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function undoFor(current: FrameState, previous: FrameState): UndoFrameEligibility {
  return {
    generation: current.generation,
    controllerId: current.controllerId,
    publishedFrame: current,
    previousFrame: previous,
  };
}

beforeEach(async () => {
  await _resetDatabaseForTests();
  await adoptCues([cue('c1', 'Ah', '啊'), cue('c2', 'Oh', '哦')]);
});

describe('普通发布建立一次撤销资格', () => {
  it('旧库存只有当前帧、没有撤销键：按不可撤销读取', async () => {
    const g = await startPerformance({ id: 'a', label: '甲台' });
    expect(await loadUndoFrame()).toBeNull();

    await expect(
      undoPreviousFrame({ controllerId: 'a', generation: g.generation }),
    ).rejects.toBeInstanceOf(UndoNotAvailableError);
  });

  it('当前帧和可撤销前一帧在同一事务保存；撤销后消费资格', async () => {
    const g = await startPerformance({ id: 'a', label: '甲台' });
    expect(await loadUndoFrame()).toBeNull();

    const result = await publishFrame({
      controllerId: 'a',
      generation: g.generation,
      content: C1,
    });

    expect(result.frame.sequence).toBe(1);
    expect(result.undo).toEqual({
      generation: 1,
      controllerId: 'a',
      publishedFrame: result.frame,
      previousFrame: expect.objectContaining({ sequence: 0, content: BLACK }),
    });
    expect(await loadUndoFrame()).toEqual(result.undo);

    const undone = await undoPreviousFrame({ controllerId: 'a', generation: 1 });
    expect(undone.frame.sequence).toBe(2);
    expect(undone.frame.generation).toBe(1);
    expect(undone.frame.content).toEqual(BLACK);
    expect(await loadUndoFrame()).toBeNull();
  });

  it('连续切句后撤销的是最近一次；撤销后不能重复撤销到更早帧', async () => {
    const g = await startPerformance({ id: 'a', label: '甲台' });
    await publishFrame({ controllerId: 'a', generation: g.generation, content: C1 });
    await publishFrame({ controllerId: 'a', generation: g.generation, content: C2 });

    const first = await undoPreviousFrame({
      controllerId: 'a',
      generation: g.generation,
    });
    expect(first.frame.sequence).toBe(3);
    expect(first.frame.content).toEqual(C1);
    expect((await loadFrame())?.sequence).toBe(3);

    await expect(
      undoPreviousFrame({ controllerId: 'a', generation: g.generation }),
    ).rejects.toBeInstanceOf(UndoNotAvailableError);
    expect((await loadFrame())?.content).toEqual(C1);
  });

  it('普通黑场也建立资格；撤销以更高序号恢复前一帧字幕', async () => {
    const g = await startPerformance({ id: 'a', label: '甲台' });
    await publishFrame({ controllerId: 'a', generation: g.generation, content: C1 });
    await publishFrame({ controllerId: 'a', generation: g.generation, content: BLACK });
    expect((await loadFrame())?.sequence).toBe(2);

    const undone = await undoPreviousFrame({
      controllerId: 'a',
      generation: g.generation,
    });
    expect(undone.frame.sequence).toBe(3);
    expect(undone.frame.content).toEqual(C1);
  });

  it('每次新的普通发布替换旧资格，不能一次撤销多帧', async () => {
    const g = await startPerformance({ id: 'a', label: '甲台' });
    await publishFrame({ controllerId: 'a', generation: g.generation, content: C1 });
    await publishFrame({ controllerId: 'a', generation: g.generation, content: C2 });

    const undo = await loadUndoFrame();
    expect(undo?.previousFrame.content).toEqual(C1);
    expect(undo?.publishedFrame.content).toEqual(C2);
  });
});

describe('撤销资格栅栏', () => {
  it('旧代次或其他控制者不能撤销；当前帧已变化时旧重试不能撤销新操作', async () => {
    const g1 = await startPerformance({ id: 'old', label: '旧台' });
    await publishFrame({ controllerId: 'old', generation: g1.generation, content: C1 });
    const g2 = await startPerformance({ id: 'new', label: '新台' });

    await expect(
      undoPreviousFrame({ controllerId: 'old', generation: g1.generation }),
    ).rejects.toBeInstanceOf(StaleGenerationError);
    expect(await loadUndoFrame()).toBeNull();

    // 手工构造一条同代次冒充者也不能使用的旧资格（正常接管已清空）。
    const current = await loadFrame();
    await putUndo({
      ...undoFor(current!, current!),
      controllerId: 'impostor',
    });
    await expect(
      undoPreviousFrame({ controllerId: 'impostor', generation: g2.generation }),
    ).rejects.toBeInstanceOf(ControllerMismatchError);

    // 资格属于 new，但其 publishedFrame 序号已落后：重复 / 迟到重试拒绝。
    // 直接把当前帧推进，不能再走 publishFrame（那会建立新资格）。
    const staleUndo = undoFor(
      { ...current!, sequence: 0 },
      { ...current!, sequence: -1, content: C1 },
    );
    const advanced: FrameState = { ...current!, sequence: 1, content: C2 };
    const db = await openDb();
    const tx = db.transaction('kv', 'readwrite');
    const store = tx.objectStore('kv');
    store.put({ key: 'frame', value: advanced });
    store.put({ key: 'undo-frame', value: staleUndo });
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });

    await expect(
      undoPreviousFrame({ controllerId: 'new', generation: g2.generation }),
    ).rejects.toBeInstanceOf(UndoTargetMismatchError);
  });

  it('撤销目标 cue 已不属于当前冻结节目时拒绝，画面和资格均保留', async () => {
    const g = await startPerformance({ id: 'a', label: '甲台' });
    const black: FrameState = {
      generation: 1,
      sequence: 0,
      controllerId: 'a',
      controllerLabel: '甲台',
      content: BLACK,
      publishedAt: 1,
    };
    const current: FrameState = {
      ...black,
      sequence: 1,
      content: C2,
      publishedAt: 2,
    };
    const previous: FrameState = {
      ...black,
      sequence: 0,
      content: { kind: 'subtitle', cueId: 'gone', source: 'Vecchio', translation: '旧' },
      publishedAt: 1,
    };
    // 直接构造持久状态，模拟重新采用清资格之外的防御路径：目标已不在新节目。
    const db = await openDb();
    const tx = db.transaction('kv', 'readwrite');
    const store = tx.objectStore('kv');
    store.put({ key: 'frame', value: current });
    store.put({
      key: 'undo-frame',
      value: undoFor(current, previous),
    });
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });

    await expect(
      undoPreviousFrame({ controllerId: 'a', generation: g.generation }),
    ).rejects.toBeInstanceOf(CueNotInFrozenProgramError);
    expect((await loadFrame())?.sequence).toBe(1);
    expect(await loadUndoFrame()).not.toBeNull();
  });

  it('紧急锁定中撤销不得恢复字幕；锁定中普通黑场的撤销仍只能是黑场', async () => {
    const g = await startPerformance({ id: 'a', label: '甲台' });
    await publishFrame({ controllerId: 'a', generation: g.generation, content: C1 });
    await engageBlackoutLock({
      controllerId: 'a',
      controllerLabel: '甲台',
      generation: g.generation,
    });
    // 紧急锁定事务清掉了“字幕 -> 黑场”的撤销资格。
    expect(await loadUndoFrame()).toBeNull();

    // 锁定中普通黑场可发布，其前一帧也是显式黑场；撤销不会放出字幕。
    await publishFrame({ controllerId: 'a', generation: g.generation, content: BLACK });
    const undone = await undoPreviousFrame({
      controllerId: 'a',
      generation: g.generation,
    });
    expect(undone.frame.content).toEqual(BLACK);

    // 防御：手工放入指向字幕的旧资格时，锁定栅栏拒绝。
    const lockedFrame = await loadFrame();
    await putUndo(
      undoFor(lockedFrame!, {
        ...lockedFrame!,
        sequence: lockedFrame!.sequence - 1,
        content: C1,
      }),
    );
    await expect(
      undoPreviousFrame({ controllerId: 'a', generation: g.generation }),
    ).rejects.toBeInstanceOf(BlackoutLockedError);
  });
});

describe('接管、交权、重新采用、紧急锁定清空旧资格', () => {
  it('普通接管首帧事务删除旧撤销资格', async () => {
    const g1 = await startPerformance({ id: 'old', label: '旧台' });
    await publishFrame({ controllerId: 'old', generation: g1.generation, content: C1 });
    expect(await loadUndoFrame()).not.toBeNull();

    await startPerformance({ id: 'new', label: '新台' }, { initialContent: C1 });
    expect(await loadUndoFrame()).toBeNull();
  });

  it('指定交权首帧事务删除旧撤销资格', async () => {
    const g1 = await startPerformance({ id: 'a', label: '甲台' });
    await publishFrame({ controllerId: 'a', generation: g1.generation, content: C1 });
    await saveHandoff({
      generation: g1.generation,
      version: 'v',
      sourceId: 'a',
      targetId: 'c',
      expiresAt: Date.now() + 5000,
    });

    const result = await consumeHandoff({
      controller: { id: 'c', label: '丙台' },
      version: 'v',
      initialContent: C1,
    });
    expect(result.generation).toBe(2);
    expect(await loadUndoFrame()).toBeNull();
  });

  it('重新采用节目单的事务清空旧资格', async () => {
    const g = await startPerformance({ id: 'a', label: '甲台' });
    await publishFrame({ controllerId: 'a', generation: g.generation, content: C1 });
    expect(await loadUndoFrame()).not.toBeNull();

    await adoptCues([cue('c2', 'Oh', '哦')]);
    expect(await loadUndoFrame()).toBeNull();
  });

  it('紧急锁定事务清空旧资格', async () => {
    const g = await startPerformance({ id: 'a', label: '甲台' });
    await publishFrame({ controllerId: 'a', generation: g.generation, content: C1 });
    await engageBlackoutLock({
      controllerId: 'a',
      controllerLabel: '甲台',
      generation: g.generation,
    });
    expect(await loadUndoFrame()).toBeNull();
  });
});

describe('撤销 / 发布写入失败', () => {
  it('撤销事务失败时当前帧和资格都不变，恢复后可重试', async () => {
    const g = await startPerformance({ id: 'a', label: '甲台' });
    await publishFrame({ controllerId: 'a', generation: g.generation, content: C1 });
    await publishFrame({ controllerId: 'a', generation: g.generation, content: C2 });
    const beforeFrame = await loadFrame();
    const beforeUndo = await loadUndoFrame();

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

    await expect(
      undoPreviousFrame({ controllerId: 'a', generation: g.generation }),
    ).rejects.toThrow();
    IDBObjectStore.prototype.put = originalPut;

    expect(await loadFrame()).toEqual(beforeFrame);
    expect(await loadUndoFrame()).toEqual(beforeUndo);

    const retry = await undoPreviousFrame({
      controllerId: 'a',
      generation: g.generation,
    });
    expect(retry.frame.content).toEqual(C1);
    expect(await loadUndoFrame()).toBeNull();
  });

  it('发布写撤销资格失败时当前帧与旧资格均回滚，下一次重试成功', async () => {
    const g = await startPerformance({ id: 'a', label: '甲台' });
    await publishFrame({ controllerId: 'a', generation: g.generation, content: C1 });
    const oldUndo = await loadUndoFrame();
    const oldFrame = await loadFrame();

    const originalPut = IDBObjectStore.prototype.put;
    let armed = true;
    IDBObjectStore.prototype.put = function patchedPut(
      this: IDBObjectStore,
      ...args: unknown[]
    ) {
      const value = args[0] as { key?: string };
      if (armed && value?.key === 'undo-frame') {
        armed = false;
        throw new DOMException('QuotaExceededError', 'QuotaExceededError');
      }
      return originalPut.apply(this, args as [unknown, IDBValidKey?]);
    };

    await expect(
      publishFrame({ controllerId: 'a', generation: g.generation, content: C2 }),
    ).rejects.toThrow();
    IDBObjectStore.prototype.put = originalPut;

    expect(await loadFrame()).toEqual(oldFrame);
    expect(await loadUndoFrame()).toEqual(oldUndo);

    const retry = await publishFrame({
      controllerId: 'a',
      generation: g.generation,
      content: C2,
    });
    expect(retry.frame.content).toEqual(C2);
    expect(retry.undo.previousFrame.content).toEqual(C1);
  });
});
