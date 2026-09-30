import { beforeEach, describe, expect, it } from 'vitest';
import type { Cue, HandoffRecord } from '../../src/types';
import {
  _resetDatabaseForTests,
  consumeHandoff,
  HandoffConsumedError,
  HandoffExpiredError,
  HandoffTargetMismatchError,
  HandoffVersionMismatchError,
  loadFrame,
  loadHandoff,
  loadPersisted,
  publishFrame,
  saveHandoff,
  startPerformance,
} from '../../src/lib/db';
import { adoptCues } from './program';

function cue(id: string, source = 'la', translation = '啦'): Cue {
  return { id, kind: 'subtitle', source, translation, note: '' };
}

const NOW = 1_000_000;
const TTL = 5_000;

function makeHandoff(over: Partial<HandoffRecord> = {}): HandoffRecord {
  return {
    generation: 1,
    version: 'v-1',
    sourceId: 'a',
    targetId: 'c',
    expiresAt: NOW + TTL,
    ...over,
  };
}

beforeEach(async () => {
  await _resetDatabaseForTests();
  await adoptCues([cue('c1', 'Solo', '独唱'), cue('c2', 'Duetto', '二重唱')]);
});

describe('交接授权消费（单事务：授权 + 新代次 + 沿用画面）', () => {
  it('目标与版本匹配：删除授权、代次 +1、沿用上一代确认画面', async () => {
    const g1 = await startPerformance({ id: 'a', label: '甲台' }, { now: NOW - 100 });
    await publishFrame({
      controllerId: 'a',
      generation: g1.generation,
      content: { kind: 'subtitle', cueId: 'c1', source: 'Solo', translation: '独唱' },
      now: NOW - 90,
    });
    await saveHandoff(makeHandoff({ generation: g1.generation }));

    const result = await consumeHandoff({
      controller: { id: 'c', label: '丙台' },
      version: 'v-1',
      initialContent: {
        kind: 'subtitle',
        cueId: 'c1',
        source: 'Solo',
        translation: '独唱',
      },
      now: NOW,
    });

    // 一次确认：新代次 + 沿用最后确认画面（不闪黑）。
    expect(result.generation).toBe(2);
    expect(result.frame.generation).toBe(2);
    expect(result.frame.sequence).toBe(0);
    expect(result.frame.controllerId).toBe('c');
    expect(result.frame.content.translation).toBe('独唱');

    // 授权已被删除（单次消费）。
    expect(await loadHandoff()).toBeNull();
    // 代次与画面都已落盘。
    const persisted = await loadPersisted();
    expect(persisted.frame?.generation).toBe(2);
    expect(persisted.frame?.content.source).toBe('Solo');
  });

  it('重复消费：第二次找不到授权而失败，代次与画面不再变化', async () => {
    await startPerformance({ id: 'a', label: '甲' });
    await saveHandoff(makeHandoff());
    const first = await consumeHandoff({
      controller: { id: 'c', label: '丙' },
      version: 'v-1',
      now: NOW,
    });
    expect(first.generation).toBe(2);

    await expect(
      consumeHandoff({
        controller: { id: 'c', label: '丙' },
        version: 'v-1',
        now: NOW + 10,
      }),
    ).rejects.toBeInstanceOf(HandoffConsumedError);
    const frame = await loadFrame();
    expect(frame?.generation).toBe(2);
    expect(await loadHandoff()).toBeNull();
  });

  it('目标身份不匹配：拒绝且授权、代次、画面三者不变', async () => {
    const g1 = await startPerformance({ id: 'a', label: '甲' });
    await saveHandoff(makeHandoff({ generation: g1.generation }));

    await expect(
      consumeHandoff({
        controller: { id: 'b', label: '乙（先排队的非目标）' },
        version: 'v-1',
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(HandoffTargetMismatchError);

    // 事务回滚：记录仍在、代次仍是 1、画面仍是 g1 初始帧。
    expect(await loadHandoff()).toEqual(makeHandoff({ generation: 1 }));
    expect((await loadFrame())?.generation).toBe(1);
  });

  it('唯一版本不匹配（迟到/旧交接）：拒绝且不消费授权', async () => {
    await startPerformance({ id: 'a', label: '甲' });
    await saveHandoff(makeHandoff({ version: 'real-v' }));

    await expect(
      consumeHandoff({
        controller: { id: 'c', label: '丙' },
        version: 'late-old-version',
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(HandoffVersionMismatchError);

    // 正确版本仍可随后消费，证明错误版本没有提前消耗授权。
    const result = await consumeHandoff({
      controller: { id: 'c', label: '丙' },
      version: 'real-v',
      now: NOW + 5,
    });
    expect(result.generation).toBe(2);
    expect(await loadHandoff()).toBeNull();
  });

  it('授权过期恢复：消费过期授权被拒，普通接管清理过期记录并开代', async () => {
    await startPerformance({ id: 'a', label: '甲' });
    await saveHandoff(makeHandoff({ expiresAt: NOW }));

    // 过期瞬间及之后不能再消费。
    await expect(
      consumeHandoff({
        controller: { id: 'c', label: '丙' },
        version: 'v-1',
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(HandoffExpiredError);

    // 回滚：过期记录仍在（由普通接管路径负责清理），代次未变。
    expect(await loadHandoff()).not.toBeNull();
    expect((await loadFrame())?.generation).toBe(1);

    // 任意排队页普通接管：事务内清掉过期授权并开新一代，系统不停摆。
    const takeover = await startPerformance(
      { id: 'b', label: '乙（授权过期后接管）' },
      { now: NOW + 10 },
    );
    expect(takeover.generation).toBe(2);
    expect(await loadHandoff()).toBeNull();
  });

  it('写入失败回滚：授权未删除、代次未增、画面未变（三者不变）', async () => {
    const g1 = await startPerformance({ id: 'a', label: '甲' });
    await publishFrame({
      controllerId: 'a',
      generation: g1.generation,
      content: { kind: 'subtitle', cueId: 'c1', source: 'Solo', translation: '独唱' },
    });
    await saveHandoff(makeHandoff({ generation: g1.generation }));

    // 在消费事务读交接记录之后让 put 失败（模拟磁盘 / Quota 错误）。
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
      consumeHandoff({
        controller: { id: 'c', label: '丙' },
        version: 'v-1',
        now: NOW,
      }),
    ).rejects.toThrow();
    IDBObjectStore.prototype.put = originalPut;

    // 三者不变：授权还在、代次仍是 1、画面仍是上一幅确认画面。
    const record = await loadHandoff();
    expect(record?.version).toBe('v-1');
    const frame = await loadFrame();
    expect(frame?.generation).toBe(1);
    expect(frame?.content.source).toBe('Solo');

    // 失败提示后重试：仍可正常消费并开下一代。
    const retry = await consumeHandoff({
      controller: { id: 'c', label: '丙' },
      version: 'v-1',
      initialContent: {
        kind: 'subtitle',
        cueId: 'c1',
        source: 'Solo',
        translation: '独唱',
      },
      now: NOW + 10,
    });
    expect(retry.generation).toBe(2);
    expect(retry.frame.content.source).toBe('Solo');
    expect(await loadHandoff()).toBeNull();
  });
});
