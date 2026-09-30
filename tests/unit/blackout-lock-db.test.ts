import { beforeEach, describe, expect, it } from 'vitest';
import type { Cue } from '../../src/types';
import {
  _resetDatabaseForTests,
  BlackoutLockedError,
  consumeHandoff,
  ControllerMismatchError,
  engageBlackoutLock,
  loadBlackoutLock,
  loadFrame,
  loadPersisted,
  publishFrame,
  releaseBlackoutLock,
  saveHandoff,
  startPerformance,
  StaleGenerationError,
} from '../../src/lib/db';
import { adoptCues } from './program';
import type { HandoffRecord } from '../../src/types';

function cue(id: string, source = 'la', translation = '啦'): Cue {
  return { id, kind: 'subtitle', source, translation, note: '' };
}

const BLACK = { kind: 'blackout' as const, cueId: null, source: '', translation: '' };

beforeEach(async () => {
  await _resetDatabaseForTests();
  await adoptCues([
    cue('c1', 'Ah', '啊'),
    cue('c2', 'Oh', '哦'),
  ]);
});

describe('旧库存与未锁定状态', () => {
  it('没有锁定键时 loadBlackoutLock / loadPersisted 按未锁定读取', async () => {
    const g = await startPerformance({ id: 'a', label: '甲台' });
    expect(g.blackoutLock).toBeNull();
    expect(await loadBlackoutLock()).toBeNull();
    const persisted = await loadPersisted();
    expect(persisted.blackoutLock).toBeNull();
  });
});

describe('设置紧急黑场锁定（单事务：锁定 + 已确认黑场帧）', () => {
  it('当前持锁且代次匹配：原子写入锁定记录与黑场帧，序号 +1', async () => {
    const g = await startPerformance({ id: 'a', label: '甲台' });
    await publishFrame({
      controllerId: 'a',
      generation: g.generation,
      content: { kind: 'subtitle', cueId: 'c1', source: 'Ah', translation: '啊' },
    });

    const result = await engageBlackoutLock({
      controllerId: 'a',
      controllerLabel: '甲台',
      generation: g.generation,
      now: 5000,
    });

    // 同一笔事务的两个产物：锁定记录 + 黑场帧。
    expect(result.lock).toEqual({
      generation: 1,
      controllerId: 'a',
      controllerLabel: '甲台',
      lockedAt: 5000,
    });
    expect(result.frame.content).toEqual(BLACK);
    expect(result.frame.sequence).toBe(2);
    expect(result.frame.generation).toBe(1);

    const storedLock = await loadBlackoutLock();
    expect(storedLock?.controllerId).toBe('a');
    const storedFrame = await loadFrame();
    expect(storedFrame?.content.kind).toBe('blackout');
    expect(storedFrame?.content.cueId).toBeNull();
    expect(storedFrame?.sequence).toBe(2);
  });

  it('旧代次页面不能设置 / 覆盖锁定：StaleGenerationError，锁与帧都不变', async () => {
    const g1 = await startPerformance({ id: 'old', label: '旧台' });
    await publishFrame({
      controllerId: 'old',
      generation: g1.generation,
      content: { kind: 'subtitle', cueId: 'c1', source: 'Ah', translation: '啊' },
    });
    // 新控制者第二代接管，且没有锁定。
    const g2 = await startPerformance({ id: 'new', label: '新台' });

    await expect(
      engageBlackoutLock({
        controllerId: 'old',
        controllerLabel: '旧台',
        generation: g1.generation,
      }),
    ).rejects.toBeInstanceOf(StaleGenerationError);

    expect(await loadBlackoutLock()).toBeNull();
    const frame = await loadFrame();
    expect(frame?.generation).toBe(g2.generation);
  });

  it('冒充同代次但 controllerId 不符：拒绝且不写入', async () => {
    const g = await startPerformance({ id: 'a', label: '甲台' });
    await expect(
      engageBlackoutLock({
        controllerId: 'impostor',
        controllerLabel: '冒充',
        generation: g.generation,
      }),
    ).rejects.toBeInstanceOf(ControllerMismatchError);
    expect(await loadBlackoutLock()).toBeNull();
  });

  it('锁定中切句一律被 BlackoutLockedError 拒绝，画面保持黑场', async () => {
    const g = await startPerformance({ id: 'a', label: '甲台' });
    await engageBlackoutLock({
      controllerId: 'a',
      controllerLabel: '甲台',
      generation: g.generation,
    });

    await expect(
      publishFrame({
        controllerId: 'a',
        generation: g.generation,
        content: { kind: 'subtitle', cueId: 'c1', source: 'Ah', translation: '啊' },
      }),
    ).rejects.toBeInstanceOf(BlackoutLockedError);

    // 指向具体黑场条目的画面也算切句，锁定中拒绝。
    await expect(
      publishFrame({
        controllerId: 'a',
        generation: g.generation,
        content: { kind: 'blackout', cueId: 'bk', source: '', translation: '' },
      }),
    ).rejects.toBeInstanceOf(BlackoutLockedError);

    const frame = await loadFrame();
    expect(frame?.content.kind).toBe('blackout');
    expect(frame?.content.cueId).toBeNull();
  });

  it('锁定中普通黑场按钮仍可产生单帧黑场，但不改变锁定记录', async () => {
    const g = await startPerformance({ id: 'a', label: '甲台' });
    const locked = await engageBlackoutLock({
      controllerId: 'a',
      controllerLabel: '甲台',
      generation: g.generation,
      now: 1000,
    });

    const f = await publishFrame({
      controllerId: 'a',
      generation: g.generation,
      content: BLACK,
    });
    expect(f.frame.content).toEqual(BLACK);
    expect(f.frame.sequence).toBe(locked.frame.sequence + 1);
    // 锁定原样保留（不重设、不解除）。
    const lockAfter = await loadBlackoutLock();
    expect(lockAfter?.lockedAt).toBe(1000);
    expect(lockAfter?.generation).toBe(1);
  });
});

describe('解除紧急黑场锁定', () => {
  it('当前持锁且代次匹配可解除；解除后可继续发布最新冻结节目中的 cue', async () => {
    const g = await startPerformance({ id: 'a', label: '甲台' });
    await engageBlackoutLock({
      controllerId: 'a',
      controllerLabel: '甲台',
      generation: g.generation,
    });

    const { lock } = await releaseBlackoutLock({
      controllerId: 'a',
      generation: g.generation,
    });
    expect(lock).not.toBeNull();
    expect(await loadBlackoutLock()).toBeNull();

    // 解除不改变画面：仍是黑场，直到主控主动切句。
    expect((await loadFrame())?.content.kind).toBe('blackout');

    const next = await publishFrame({
      controllerId: 'a',
      generation: g.generation,
      content: { kind: 'subtitle', cueId: 'c2', source: 'Oh', translation: '哦' },
    });
    expect(next.frame.content.translation).toBe('哦');
  });

  it('未锁定时解除幂等：不抛错、不写帧', async () => {
    const g = await startPerformance({ id: 'a', label: '甲台' });
    const before = await loadFrame();
    const result = await releaseBlackoutLock({
      controllerId: 'a',
      generation: g.generation,
    });
    expect(result.lock).toBeNull();
    expect(await loadFrame()).toEqual(before);
  });

  it('旧代次页面不能解除：StaleGenerationError，锁定保留', async () => {
    const g1 = await startPerformance({ id: 'old', label: '旧台' });
    await engageBlackoutLock({
      controllerId: 'old',
      controllerLabel: '旧台',
      generation: g1.generation,
    });
    // 新控制者接管：锁定跨代次存活，新代次首帧强制黑场。
    const g2 = await startPerformance({ id: 'new', label: '新台' });
    expect(g2.blackoutLock?.generation).toBe(1);
    expect(g2.frame.content).toEqual(BLACK);

    // 旧主控（第 1 代）试图解除：代次栅栏拒绝。
    await expect(
      releaseBlackoutLock({ controllerId: 'old', generation: g1.generation }),
    ).rejects.toBeInstanceOf(StaleGenerationError);
    expect((await loadBlackoutLock())?.generation).toBe(1);

    // 新控制者显式解除后才恢复发布。
    await releaseBlackoutLock({
      controllerId: 'new',
      generation: g2.generation,
    });
    const ok = await publishFrame({
      controllerId: 'new',
      generation: g2.generation,
      content: { kind: 'subtitle', cueId: 'c1', source: 'Ah', translation: '啊' },
    });
    expect(ok.frame.content.translation).toBe('啊');
  });

  it('同代次冒充者不能解除：ControllerMismatchError，锁定保留', async () => {
    const g = await startPerformance({ id: 'a', label: '甲台' });
    await engageBlackoutLock({
      controllerId: 'a',
      controllerLabel: '甲台',
      generation: g.generation,
    });
    await expect(
      releaseBlackoutLock({ controllerId: 'fake', generation: g.generation }),
    ).rejects.toBeInstanceOf(ControllerMismatchError);
    expect(await loadBlackoutLock()).not.toBeNull();
  });
});

describe('锁定跨普通接管 / 指定交权 / 重新采用持续存在', () => {
  it('普通接管：锁定保留，上一代字幕被强制黑场进入新代次', async () => {
    const g1 = await startPerformance({ id: 'old', label: '旧台' });
    await publishFrame({
      controllerId: 'old',
      generation: g1.generation,
      content: { kind: 'subtitle', cueId: 'c1', source: 'Ah', translation: '啊' },
    });
    await engageBlackoutLock({
      controllerId: 'old',
      controllerLabel: '旧台',
      generation: g1.generation,
    });

    // 即便接管者声称沿用上一幅字幕，锁定中也必须黑场。
    const takeover = await startPerformance(
      { id: 'new', label: '新台' },
      {
        initialContent: {
          kind: 'subtitle',
          cueId: 'c1',
          source: 'Ah',
          translation: '啊',
        },
      },
    );
    expect(takeover.generation).toBe(2);
    expect(takeover.frame.content).toEqual(BLACK);
    expect(takeover.blackoutLock?.generation).toBe(1);
    expect((await loadBlackoutLock())?.generation).toBe(1);

    // 新控制者未显式解除前不能发 cue。
    await expect(
      publishFrame({
        controllerId: 'new',
        generation: 2,
        content: { kind: 'subtitle', cueId: 'c1', source: 'Ah', translation: '啊' },
      }),
    ).rejects.toBeInstanceOf(BlackoutLockedError);
  });

  it('指定交权：锁定保留，被指定页接权首帧强制黑场且不能直接发 cue', async () => {
    const g1 = await startPerformance({ id: 'a', label: '甲台' });
    await publishFrame({
      controllerId: 'a',
      generation: g1.generation,
      content: { kind: 'subtitle', cueId: 'c1', source: 'Ah', translation: '啊' },
    });
    await engageBlackoutLock({
      controllerId: 'a',
      controllerLabel: '甲台',
      generation: g1.generation,
    });
    const record: HandoffRecord = {
      generation: g1.generation,
      version: 'v-1',
      sourceId: 'a',
      targetId: 'c',
      expiresAt: Date.now() + 5000,
    };
    await saveHandoff(record);

    const result = await consumeHandoff({
      controller: { id: 'c', label: '丙台' },
      version: 'v-1',
      initialContent: {
        kind: 'subtitle',
        cueId: 'c1',
        source: 'Ah',
        translation: '啊',
      },
    });
    expect(result.generation).toBe(2);
    expect(result.frame.content).toEqual(BLACK);
    expect(result.blackoutLock?.generation).toBe(1);

    await expect(
      publishFrame({
        controllerId: 'c',
        generation: 2,
        content: { kind: 'subtitle', cueId: 'c2', source: 'Oh', translation: '哦' },
      }),
    ).rejects.toBeInstanceOf(BlackoutLockedError);

    // 被指定页显式解除后恢复。
    await releaseBlackoutLock({ controllerId: 'c', generation: 2 });
    const ok = await publishFrame({
      controllerId: 'c',
      generation: 2,
      content: { kind: 'subtitle', cueId: 'c2', source: 'Oh', translation: '哦' },
    });
    expect(ok.frame.content.translation).toBe('哦');
  });

  it('重新采用不影响锁定：锁定仍在，新节目的 cue 同样被拦', async () => {
    const g = await startPerformance({ id: 'a', label: '甲台' });
    await engageBlackoutLock({
      controllerId: 'a',
      controllerLabel: '甲台',
      generation: g.generation,
    });

    // 重新采用：改文案（旧 c1 失效、新 c1 文案不同）。
    await adoptCues([
      cue('c1', 'Ah-Nuovo', '啊-改'),
      cue('c3', 'Eh', '欸'),
    ]);

    // 锁定栅栏先于节目栅栏生效：新旧 cue 都不能发。
    await expect(
      publishFrame({
        controllerId: 'a',
        generation: g.generation,
        content: {
          kind: 'subtitle',
          cueId: 'c3',
          source: 'Eh',
          translation: '欸',
        },
      }),
    ).rejects.toBeInstanceOf(BlackoutLockedError);
    expect(await loadBlackoutLock()).not.toBeNull();
    expect((await loadFrame())?.content.kind).toBe('blackout');
  });
});

describe('锁定写入失败：保留上一个确认状态', () => {
  it('engage 事务写入抛错时锁定与画面都不变（不出现黑了但锁丢失）', async () => {
    const g = await startPerformance({ id: 'a', label: '甲台' });
    await publishFrame({
      controllerId: 'a',
      generation: g.generation,
      content: { kind: 'subtitle', cueId: 'c1', source: 'Ah', translation: '啊' },
    });

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
      engageBlackoutLock({
        controllerId: 'a',
        controllerLabel: '甲台',
        generation: g.generation,
      }),
    ).rejects.toThrow();
    IDBObjectStore.prototype.put = originalPut;

    // 库内仍是上一个确认状态：无锁定、画面仍是字幕。
    expect(await loadBlackoutLock()).toBeNull();
    const frame = await loadFrame();
    expect(frame?.content.translation).toBe('啊');
    expect(frame?.sequence).toBe(1);

    // 恢复后重试可正常锁定。
    const retry = await engageBlackoutLock({
      controllerId: 'a',
      controllerLabel: '甲台',
      generation: g.generation,
    });
    expect(retry.frame.content.kind).toBe('blackout');
    expect((await loadBlackoutLock())?.generation).toBe(1);
  });

  it('release 事务失败时锁定保留，cue 继续被拦', async () => {
    const g = await startPerformance({ id: 'a', label: '甲台' });
    await engageBlackoutLock({
      controllerId: 'a',
      controllerLabel: '甲台',
      generation: g.generation,
    });

    const originalDelete = IDBObjectStore.prototype.delete;
    IDBObjectStore.prototype.delete = function patchedDelete(
      this: IDBObjectStore,
    ) {
      IDBObjectStore.prototype.delete = originalDelete;
      throw new DOMException('QuotaExceededError', 'QuotaExceededError');
    };
    await expect(
      releaseBlackoutLock({ controllerId: 'a', generation: g.generation }),
    ).rejects.toThrow();

    expect(await loadBlackoutLock()).not.toBeNull();
    await expect(
      publishFrame({
        controllerId: 'a',
        generation: g.generation,
        content: { kind: 'subtitle', cueId: 'c1', source: 'Ah', translation: '啊' },
      }),
    ).rejects.toBeInstanceOf(BlackoutLockedError);

    // 恢复后可正常解除。
    const { lock } = await releaseBlackoutLock({
      controllerId: 'a',
      generation: g.generation,
    });
    expect(lock).not.toBeNull();
    expect(await loadBlackoutLock()).toBeNull();
  });
});
