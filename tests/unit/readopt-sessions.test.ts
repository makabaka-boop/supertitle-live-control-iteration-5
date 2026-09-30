import { beforeEach, describe, expect, it } from 'vitest';
import type { FrameContent } from '../../src/types';
import {
  _resetDatabaseForTests,
  EmptyProgramError,
  loadFrame,
} from '../../src/lib/db';
import { adoptCues } from './program';
import {
  announceProgramAdoption,
  ControllerSession,
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

function snap(s: { current: SessionSnapshot }): SessionSnapshot {
  return s.current;
}

const flush = (ms = 20) => new Promise((r) => setTimeout(r, ms));

beforeEach(async () => {
  await _resetDatabaseForTests();
  await adoptCues([
    cue('c1', 'Ah', '啊'),
    cue('c2', 'Oh', '哦'),
    cue('c3', 'Eh', '欸'),
  ]);
});

describe('重新采用：持锁页与排队页都更新到最新冻结版本', () => {
  it('program-adopted 通知更新持锁页与排队页的 programVersion；投影页忽略', async () => {
    const leader = new ControllerSession({ id: 'a', label: '甲' });
    void leader.enterContention();
    await flush();
    const waiter = new ControllerSession({ id: 'b', label: '乙' });
    void waiter.enterContention();
    await flush();

    announceProgramAdoption(12345);
    await flush();
    expect(snap(leader).programVersion).toBe(12345);
    expect(snap(waiter).programVersion).toBe(12345);

    // 迟到的旧通知不能回退版本。
    announceProgramAdoption(1);
    await flush();
    expect(snap(leader).programVersion).toBe(12345);

    leader.dispose();
    waiter.dispose();
  });
});

describe('重新采用（删/改/排）后的接管与发布', () => {
  it('上一代最后确认画面已被删除：普通接管以黑场进入新代次', async () => {
    const leader = new ControllerSession({ id: 'a', label: '甲' });
    void leader.enterContention();
    await flush();
    // 发布即将被删除的 c1。
    await leader.publish(sub('c1', 'Ah', '啊'));
    await flush();

    const waiter = new ControllerSession({ id: 'b', label: '乙' });
    void waiter.enterContention();
    await flush();

    // 校对员重新采用：删 c1、改 c2 文案、保留 c3（重排）。
    await adoptCues([
      cue('c3', 'Eh', '欸'),
      cue('c2', 'Oh-Nuovo', '哦-改'),
    ]);
    announceProgramAdoption(Date.now());
    await flush();

    // 主控退场，备用普通接管：新代次黑场，绝不把已删除的 c1 投给观众。
    await leader.standDown();
    await flush();
    await flush();
    expect(snap(waiter).status).toMatchObject({ role: 'leader' });
    const gen = (snap(waiter).status as { generation: number }).generation;
    expect(gen).toBe(2);
    expect(snap(waiter).frame?.generation).toBe(2);
    expect(snap(waiter).frame?.content.kind).toBe('blackout');
    expect(snap(waiter).frame?.content.cueId).toBeNull();
    const stored = await loadFrame();
    expect(stored?.generation).toBe(2);
    expect(stored?.content.kind).toBe('blackout');

    leader.dispose();
    waiter.dispose();
  });

  it('上一代最后确认画面仍在且未改：接管沿用，不闪黑', async () => {
    const leader = new ControllerSession({ id: 'a', label: '甲' });
    void leader.enterContention();
    await flush();
    await leader.publish(sub('c3', 'Eh', '欸'));
    await flush();

    const waiter = new ControllerSession({ id: 'b', label: '乙' });
    void waiter.enterContention();
    await flush();

    // 删 c1、改 c2，但 c3 原封不动（仅位置变化）。
    await adoptCues([
      cue('c3', 'Eh', '欸'),
      cue('c2', 'Oh-Nuovo', '哦-改'),
    ]);
    announceProgramAdoption(Date.now());
    await flush();

    await leader.standDown();
    await flush();
    await flush();
    expect(snap(waiter).frame?.content.cueId).toBe('c3');
    expect(snap(waiter).frame?.content.translation).toBe('欸');
    expect(snap(waiter).frame?.generation).toBe(2);

    leader.dispose();
    waiter.dispose();
  });

  it('重新采用后持锁页不能再发布旧 cue；改用新文案可以', async () => {
    const leader = new ControllerSession({ id: 'a', label: '甲' });
    void leader.enterContention();
    await flush();
    await leader.publish(sub('c1', 'Ah', '啊'));
    await flush();

    await adoptCues([
      cue('c2', 'Oh-Nuovo', '哦-改'),
      cue('c3', 'Eh', '欸'),
    ]);
    announceProgramAdoption(Date.now());
    await flush();

    // 已删除 c1：会话发布被事务拒绝，画面不变。
    await expect(leader.publish(sub('c1', 'Ah', '啊'))).rejects.toThrow(
      /最新冻结节目/,
    );
    expect((await loadFrame())?.content.cueId).toBe('c1');

    // 旧文案 c2 同样被拒。
    await expect(leader.publish(sub('c2', 'Oh', '哦'))).rejects.toThrow(
      /最新冻结节目/,
    );

    // 新文案 c2 可发布。
    await leader.publish(sub('c2', 'Oh-Nuovo', '哦-改'));
    expect((await loadFrame())?.content.translation).toBe('哦-改');

    // 显式黑场随时可发。
    await leader.publish({
      kind: 'blackout',
      cueId: null,
      source: '',
      translation: '',
    });
    expect((await loadFrame())?.content.kind).toBe('blackout');

    leader.dispose();
  });

  it('重新采用失败（空单）后：原节目保留，旧代次最后有效画面仍可继续', async () => {
    const leader = new ControllerSession({ id: 'a', label: '甲' });
    void leader.enterContention();
    await flush();
    await leader.publish(sub('c2', 'Oh', '哦'));
    await flush();

    // 模拟“重新采用失败”：空节目单在 API 层即被拒（编辑页按钮也禁用）。
    const { adoptProgram } = await import('../../src/lib/db');
    await expect(
      adoptProgram({ cues: [], draftRev: 99, updatedAt: 1 }, 0),
    ).rejects.toBeInstanceOf(EmptyProgramError);

    // 没有 program-adopted 通知：programVersion 保持 null。
    expect(snap(leader).programVersion).toBeNull();
    // 在演版本与画面都没变，演出继续。
    const stored = await loadFrame();
    expect(stored?.content.cueId).toBe('c2');
    const f = await leader.publish(sub('c3', 'Eh', '欸'));
    expect(f.content.translation).toBe('欸');

    leader.dispose();
  });
});
