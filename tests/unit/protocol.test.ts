import { describe, expect, it } from 'vitest';
import {
  blackoutContent,
  isContentInFrozenProgram,
  isControllerAtLeast,
  isExplicitBlackout,
  isNewerFrame,
  seedContentForProgram,
  shouldClearController,
} from '../../src/lib/protocol';
import type { Cue, FrameContent, FrozenProgram, FrameState } from '../../src/types';

function frame(generation: number, sequence: number): FrameState {
  return {
    generation,
    sequence,
    controllerId: `ctl-${generation}`,
    controllerLabel: '台',
    content: { kind: 'blackout', cueId: null, source: '', translation: '' },
    publishedAt: 0,
  };
}

describe('画面与最新冻结节目的一致性裁决', () => {
  const sub = (id: string, s: string, t: string): FrameContent => ({
    kind: 'subtitle',
    cueId: id,
    source: s,
    translation: t,
  });
  const cues: Cue[] = [
    { id: 'a', kind: 'subtitle', source: 'A', translation: '甲', note: '' },
    { id: 'b', kind: 'subtitle', source: 'B', translation: '乙', note: '' },
    { id: 'bk', kind: 'blackout', source: '', translation: '', note: '幕间' },
  ];
  const frozen: FrozenProgram = { cues, frozenAt: 1 };

  it('字幕条目仍在且文案逐字一致才算有效', () => {
    expect(isContentInFrozenProgram(sub('a', 'A', '甲'), frozen)).toBe(true);
    expect(isContentInFrozenProgram(sub('gone', 'X', '叉'), frozen)).toBe(false);
    expect(isContentInFrozenProgram(sub('a', 'A2', '甲'), frozen)).toBe(false);
    expect(isContentInFrozenProgram(sub('a', 'A', '甲2'), frozen)).toBe(false);
    // 指向黑场条目的字幕画面无效。
    expect(isContentInFrozenProgram(sub('bk', 'A', '甲'), frozen)).toBe(false);
  });

  it('显式黑场永远有效；带 cueId 的黑场要求条目仍存在', () => {
    expect(isContentInFrozenProgram(blackoutContent(), frozen)).toBe(true);
    expect(
      isContentInFrozenProgram(
        { kind: 'blackout', cueId: 'bk', source: '', translation: '' },
        frozen,
      ),
    ).toBe(true);
    expect(
      isContentInFrozenProgram(
        { kind: 'blackout', cueId: 'gone', source: '', translation: '' },
        frozen,
      ),
    ).toBe(false);
  });

  it('冻结版本为 null 时只有显式黑场有效', () => {
    expect(isContentInFrozenProgram(sub('a', 'A', '甲'), null)).toBe(false);
    expect(isContentInFrozenProgram(blackoutContent(), null)).toBe(true);
  });

  it('seed：仍存在且未改写的画面沿用（不闪黑）', () => {
    const seed = sub('b', 'B', '乙');
    expect(seedContentForProgram(seed, frozen)).toBe(seed);
  });

  it('seed：删除 / 改写 / 无上一代画面都归一为显式黑场', () => {
    expect(seedContentForProgram(sub('gone', 'X', '叉'), frozen)).toEqual(
      blackoutContent(),
    );
    expect(seedContentForProgram(sub('a', 'OLD', '旧'), frozen)).toEqual(
      blackoutContent(),
    );
    expect(
      seedContentForProgram(
        { kind: 'blackout', cueId: 'gone', source: '', translation: '' },
        frozen,
      ),
    ).toEqual(blackoutContent());
    expect(seedContentForProgram(null, frozen)).toEqual(blackoutContent());
  });

  it('seed 返回的黑场对象不被调用方共享突变', () => {
    const out = seedContentForProgram(sub('gone', 'X', '叉'), frozen);
    out.cueId = 'a';
    expect(seedContentForProgram(null, frozen).cueId).toBeNull();
  });
});

describe('isNewerFrame 代次栅栏', () => {
  it('无当前画面时接受任何帧', () => {
    expect(isNewerFrame(null, frame(1, 0))).toBe(true);
  });

  it('同代次只接受更大序号', () => {
    const cur = frame(3, 5);
    expect(isNewerFrame(cur, frame(3, 6))).toBe(true);
    expect(isNewerFrame(cur, frame(3, 5))).toBe(false);
    expect(isNewerFrame(cur, frame(3, 4))).toBe(false);
  });

  it('更高代次即使序号很小也接受（接管瞬间 seq 从 0 起）', () => {
    expect(isNewerFrame(frame(2, 99), frame(3, 0))).toBe(true);
  });

  it('旧代次的迟到消息一律丢弃，哪怕序号很大', () => {
    expect(isNewerFrame(frame(3, 0), frame(2, 9999))).toBe(false);
    expect(isNewerFrame(frame(3, 10), frame(1, 10))).toBe(false);
  });
});

describe('控制者广播判定', () => {
  it('同代次心跳可刷新', () => {
    expect(isControllerAtLeast(2, 2)).toBe(true);
    expect(isControllerAtLeast(2, 3)).toBe(true);
  });

  it('旧代次心跳不能覆盖新代次', () => {
    expect(isControllerAtLeast(3, 2)).toBe(false);
  });

  it('旧代次的退场消息不能清掉新代次控制者', () => {
    expect(shouldClearController(3, 2)).toBe(false);
    expect(shouldClearController(3, 3)).toBe(true);
    expect(shouldClearController(null, 1)).toBe(false);
  });
});

describe('isExplicitBlackout 紧急锁定期间的唯一放行画面', () => {
  it('cueId=null 的黑场才算显式单帧黑场', () => {
    expect(isExplicitBlackout(blackoutContent())).toBe(true);
  });

  it('字幕与带 cueId 的黑场条目都不是显式黑场（锁定中必须拒绝）', () => {
    expect(
      isExplicitBlackout({
        kind: 'blackout',
        cueId: 'bk',
        source: '',
        translation: '',
      }),
    ).toBe(false);
    expect(
      isExplicitBlackout({
        kind: 'subtitle',
        cueId: null,
        source: 'x',
        translation: 'y',
      }),
    ).toBe(false);
  });
});
