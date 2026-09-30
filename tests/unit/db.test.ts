import { beforeEach, describe, expect, it } from 'vitest';
import type { Cue } from '../../src/types';
import {
  _resetDatabaseForTests,
  adoptProgram,
  ControllerMismatchError,
  CueNotInFrozenProgramError,
  EmptyProgramError,
  loadFrame,
  loadPersisted,
  NoFrozenProgramError,
  publishFrame,
  saveDraft,
  startPerformance,
  StaleGenerationError,
} from '../../src/lib/db';
import { adoptCues } from './program';

function cue(id: string, source = 'la', translation = '啦'): Cue {
  return { id, kind: 'subtitle', source, translation, note: '' };
}

beforeEach(async () => {
  await _resetDatabaseForTests();
});

describe('节目单冻结', () => {
  it('空节目单不能采用', async () => {
    await expect(
      adoptProgram({ cues: [], draftRev: 1, updatedAt: 1 }, 0),
    ).rejects.toBeInstanceOf(EmptyProgramError);
  });

  it('采用后再编辑草稿不影响冻结的在演版本', async () => {
    await saveDraft(
      {
        cues: [cue('a', 'A', '甲')],
        draftRev: 1,
        updatedAt: 1,
      },
      0,
    );
    // 采用事务同时归档草稿（rev 2）并冻结快照（引用同一 rev）。
    const frozen = await adoptProgram(
      { cues: [cue('a', 'A', '甲')], draftRev: 2, updatedAt: 2 },
      1,
    );
    expect(frozen.cues).toHaveLength(1);
    expect(frozen.draftRev).toBe(2);

    // 模拟“后续编辑”：清空并彻底改写草稿（基线为刚归档的 rev 2）。
    await saveDraft(
      {
        cues: [cue('b', 'B', '乙'), cue('c', 'C', '丙')],
        draftRev: 3,
        updatedAt: 3,
      },
      2,
    );

    const persisted = await loadPersisted();
    expect(persisted.draft.cues.map((c) => c.id)).toEqual(['b', 'c']);
    expect(persisted.frozen?.cues.map((c) => c.id)).toEqual(['a']);
    // 冻结快照不受草稿对象事后突变影响（采用时是拷贝）。
    frozen.cues[0].source = 'MUTATED';
    const again = await loadPersisted();
    expect(again.frozen?.cues[0].source).toBe('A');
  });
});

describe('开演代次与初始画面', () => {
  it('没有冻结节目单不能开演', async () => {
    await expect(
      startPerformance({ id: 'x', label: '台' }),
    ).rejects.toBeInstanceOf(NoFrozenProgramError);
  });

  it('开演在同一事务内取得递增代次并写入 seq=0 画面', async () => {
    await adoptCues([cue('a')]);
    const r1 = await startPerformance({ id: 'ctl-1', label: '甲台' });
    expect(r1.generation).toBe(1);
    expect(r1.frame.sequence).toBe(0);
    expect(r1.frame.controllerId).toBe('ctl-1');

    const r2 = await startPerformance({ id: 'ctl-2', label: '乙台' });
    expect(r2.generation).toBe(2);
    expect(r2.frame.sequence).toBe(0);

    const frame = await loadFrame();
    expect(frame?.generation).toBe(2);
  });

  it('开演初始画面可携带上一代内容（接管不闪黑）', async () => {
    await adoptCues([cue('a', 'Solo', '独唱')]);
    const first = await startPerformance({ id: 'ctl-1', label: '甲' });
    await publishFrame({
      controllerId: 'ctl-1',
      generation: first.generation,
      content: { kind: 'subtitle', cueId: 'a', source: 'Solo', translation: '独唱' },
    });

    const second = await startPerformance(
      { id: 'ctl-2', label: '乙' },
      {
        initialContent: {
          kind: 'subtitle',
          cueId: 'a',
          source: 'Solo',
          translation: '独唱',
        },
      },
    );
    expect(second.frame.generation).toBe(2);
    expect(second.frame.sequence).toBe(0);
    expect(second.frame.content.translation).toBe('独唱');
  });
});

describe('发布画面的事务栅栏', () => {
  async function setupTwoGenerations() {
    await adoptCues([cue('a'), cue('b')]);
    const g1 = await startPerformance({ id: 'old', label: '旧台' });
    // 内容必须与冻结条目逐字一致；这里用 cue() 的默认文案（la/啦）。
    await publishFrame({
      controllerId: 'old',
      generation: g1.generation,
      content: { kind: 'subtitle', cueId: 'a', source: 'la', translation: '啦' },
    });
    // 新控制者开第二代。
    const g2 = await startPerformance({ id: 'new', label: '新台' });
    return { g1, g2 };
  }

  it('正常发布：同事务核对控制者与代次、序号递增并持久化', async () => {
    const { g2 } = await setupTwoGenerations();
    const f1 = await publishFrame({
      controllerId: 'new',
      generation: g2.generation,
      content: { kind: 'subtitle', cueId: 'b', source: 'la', translation: '啦' },
    });
    expect(f1.frame.generation).toBe(2);
    expect(f1.frame.sequence).toBe(1);
    const stored = await loadFrame();
    expect(stored).toEqual(f1.frame);
  });

  it('失锁旧页用旧代次发布：抛 StaleGenerationError 且画面保持新代次', async () => {
    const { g1, g2 } = await setupTwoGenerations();
    await expect(
      publishFrame({
        controllerId: 'old',
        generation: g1.generation,
        content: { kind: 'subtitle', cueId: 'a', source: 'la', translation: '啦' },
      }),
    ).rejects.toBeInstanceOf(StaleGenerationError);

    const stored = await loadFrame();
    expect(stored?.generation).toBe(g2.generation);
    expect(stored?.content.source).not.toBe('STALE');
  });

  it('冒充同代次但 controllerId 不符：拒绝并保持画面', async () => {
    const { g2 } = await setupTwoGenerations();
    await expect(
      publishFrame({
        controllerId: 'impostor',
        generation: g2.generation,
        content: { kind: 'blackout', cueId: null, source: '', translation: '' },
      }),
    ).rejects.toBeInstanceOf(ControllerMismatchError);
  });

  it('显式黑场（cueId=null）任何时候都可发布，不依赖冻结条目', async () => {
    const { g2 } = await setupTwoGenerations();
    const f = await publishFrame({
      controllerId: 'new',
      generation: g2.generation,
      content: { kind: 'blackout', cueId: null, source: '', translation: '' },
    });
    expect(f.frame.content.kind).toBe('blackout');
    expect(f.frame.content.cueId).toBeNull();
  });
});

describe('重新采用后：发布与接管都以最新冻结节目为准', () => {
  it('已删除条目的画面不能再发布：抛 CueNotInFrozenProgramError 且画面不变', async () => {
    await adoptCues([cue('a'), cue('b')]);
    const g = await startPerformance({ id: 'ctl', label: '台' });
    await publishFrame({
      controllerId: 'ctl',
      generation: g.generation,
      content: { kind: 'subtitle', cueId: 'a', source: 'la', translation: '啦' },
    });

    // 重新采用：删掉 a，只保留 b。
    await adoptCues([cue('b')]);

    await expect(
      publishFrame({
        controllerId: 'ctl',
        generation: g.generation,
        content: { kind: 'subtitle', cueId: 'a', source: 'la', translation: '啦' },
      }),
    ).rejects.toBeInstanceOf(CueNotInFrozenProgramError);
    const stored = await loadFrame();
    expect(stored?.content.cueId).toBe('a'); // 仍是上一幅确认画面
  });

  it('条目仍在但文案被改写：旧文案不能发布，新文案可以', async () => {
    await adoptCues([cue('a', '旧原文', '旧译文')]);
    const g = await startPerformance({ id: 'ctl', label: '台' });
    await publishFrame({
      controllerId: 'ctl',
      generation: g.generation,
      content: { kind: 'subtitle', cueId: 'a', source: '旧原文', translation: '旧译文' },
    });

    // 重新采用：同 id 改文案。
    await adoptCues([cue('a', '新原文', '新译文')]);

    await expect(
      publishFrame({
        controllerId: 'ctl',
        generation: g.generation,
        content: { kind: 'subtitle', cueId: 'a', source: '旧原文', translation: '旧译文' },
      }),
    ).rejects.toBeInstanceOf(CueNotInFrozenProgramError);

    const ok = await publishFrame({
      controllerId: 'ctl',
      generation: g.generation,
      content: { kind: 'subtitle', cueId: 'a', source: '新原文', translation: '新译文' },
    });
    expect(ok.frame.content.translation).toBe('新译文');
  });

  it('被删除的黑场条目不能再点出；显式黑场仍可', async () => {
    const blackCue: Cue = {
      id: 'bk',
      kind: 'blackout',
      source: '',
      translation: '',
      note: '幕间',
    };
    await adoptCues([cue('a'), blackCue]);
    const g = await startPerformance({ id: 'ctl', label: '台' });
    await publishFrame({
      controllerId: 'ctl',
      generation: g.generation,
      content: { kind: 'blackout', cueId: 'bk', source: '', translation: '' },
    });

    await adoptCues([cue('a')]);
    await expect(
      publishFrame({
        controllerId: 'ctl',
        generation: g.generation,
        content: { kind: 'blackout', cueId: 'bk', source: '', translation: '' },
      }),
    ).rejects.toBeInstanceOf(CueNotInFrozenProgramError);
  });

  it('普通接管：上一代最后画面已删除 → 新代次以黑场（cueId=null）进入', async () => {
    await adoptCues([cue('a'), cue('b')]);
    const g1 = await startPerformance({ id: 'old', label: '旧台' });
    await publishFrame({
      controllerId: 'old',
      generation: g1.generation,
      content: { kind: 'subtitle', cueId: 'a', source: 'la', translation: '啦' },
    });

    // 重新采用：a 被删除，b 保留并改了文案。
    await adoptCues([cue('b', 'Nuovo', '新')]);

    const takeover = await startPerformance(
      { id: 'new', label: '新台' },
      { initialContent: { kind: 'subtitle', cueId: 'a', source: 'la', translation: '啦' } },
    );
    expect(takeover.generation).toBe(g1.generation + 1);
    expect(takeover.frame.content.kind).toBe('blackout');
    expect(takeover.frame.content.cueId).toBeNull();
    expect((await loadFrame())?.content.kind).toBe('blackout');
  });

  it('普通接管：上一代最后画面仍在且未改 → 沿用，不闪黑', async () => {
    await adoptCues([cue('a', 'Solo', '独唱'), cue('b')]);
    const g1 = await startPerformance({ id: 'old', label: '旧台' });
    await publishFrame({
      controllerId: 'old',
      generation: g1.generation,
      content: { kind: 'subtitle', cueId: 'a', source: 'Solo', translation: '独唱' },
    });

    // 重新采用：只删 b、重排也不影响 a 的逐字一致性。
    await adoptCues([cue('a', 'Solo', '独唱')]);

    const takeover = await startPerformance(
      { id: 'new', label: '新台' },
      {
        initialContent: {
          kind: 'subtitle',
          cueId: 'a',
          source: 'Solo',
          translation: '独唱',
        },
      },
    );
    expect(takeover.frame.content.cueId).toBe('a');
    expect(takeover.frame.content.translation).toBe('独唱');
  });

  it('首次开演（无上一代画面）始终黑场等待', async () => {
    await adoptCues([cue('a')]);
    const r = await startPerformance({ id: 'x', label: '台' });
    expect(r.frame.content.kind).toBe('blackout');
    expect(r.frame.content.cueId).toBeNull();
  });
});
