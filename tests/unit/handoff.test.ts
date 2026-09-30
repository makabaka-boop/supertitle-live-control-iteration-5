import { describe, expect, it } from 'vitest';
import {
  adjudicateHandoff,
  isMessageForCurrentGeneration,
} from '../../src/lib/protocol';
import type { HandoffRecord } from '../../src/types';

function handoff(over: Partial<HandoffRecord> = {}): HandoffRecord {
  return {
    generation: 3,
    version: 'v-unique',
    sourceId: 'leader-a',
    targetId: 'page-c',
    expiresAt: 10_000,
    ...over,
  };
}

describe('adjudicateHandoff 取得底层锁后的资格裁决', () => {
  it('无交接记录（含旧 IndexedDB）→ 普通接管', () => {
    expect(adjudicateHandoff(null, { id: 'any' }, 1000)).toEqual({
      kind: 'none',
    });
  });

  it('有效期内目标与版本都匹配 → consume', () => {
    const h = handoff();
    expect(
      adjudicateHandoff(h, { id: 'page-c', version: 'v-unique' }, 9_999),
    ).toEqual({ kind: 'consume', handoff: h });
  });

  it('有效期内目标匹配但版本不符（旧/错误授权）→ yield，不开代', () => {
    const h = handoff();
    expect(
      adjudicateHandoff(h, { id: 'page-c', version: 'stale-version' }, 5_000),
    ).toEqual({ kind: 'yield', handoff: h });
  });

  it('有效期内先排队的是非目标 → yield（不改代次地让锁）', () => {
    const h = handoff();
    expect(
      adjudicateHandoff(h, { id: 'page-b' }, 5_000),
    ).toEqual({ kind: 'yield', handoff: h });
  });

  it('授权过期 → expired：目标与非目标都重新参与普通接管', () => {
    const h = handoff();
    expect(adjudicateHandoff(h, { id: 'page-c' }, 10_000)).toEqual({
      kind: 'expired',
    });
    expect(adjudicateHandoff(h, { id: 'page-b' }, 10_001)).toEqual({
      kind: 'expired',
    });
  });

  it('目标关闭不影响裁决结果：授权仍在时其他页继续让路', () => {
    // 目标是否在线不参与资格判定；目标关闭由“授权过期”兜住，系统不停摆。
    const h = handoff({ targetId: 'closed-page' });
    expect(adjudicateHandoff(h, { id: 'page-b' }, 1_000)).toEqual({
      kind: 'yield',
      handoff: h,
    });
    expect(adjudicateHandoff(h, { id: 'page-b' }, 11_000)).toEqual({
      kind: 'expired',
    });
  });
});

describe('迟到的旧在线 / 旧交接消息不能影响后续代次', () => {
  it('只接受不早于已知代次的消息', () => {
    expect(isMessageForCurrentGeneration(0, 1)).toBe(true); // 刚开页接受任何消息
    expect(isMessageForCurrentGeneration(3, 3)).toBe(true);
    expect(isMessageForCurrentGeneration(3, 4)).toBe(true);
    expect(isMessageForCurrentGeneration(3, 2)).toBe(false);
  });
});
