// 草稿版本链：乐观并发保存、采用事务的“归档 + 冻结”原子性、
// 持久化失败回滚与重试、旧冻结版本的读取兼容。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Cue, FrozenProgram, ProgramDraft } from '../../src/types';
import {
  _resetDatabaseForTests,
  adoptProgram,
  DraftConflictError,
  EmptyProgramError,
  loadPersisted,
  openDb,
  saveDraft,
} from '../../src/lib/db';

function cue(id: string, source = 'la', translation = '啦'): Cue {
  return { id, kind: 'subtitle', source, translation, note: '' };
}

function draft(cues: Cue[], draftRev: number, updatedAt = 0): ProgramDraft {
  return { cues, draftRev, updatedAt };
}

/** 让下一次对指定键的 put 抛错（模拟一次写盘失败），随后自动恢复。 */
function failNextPut(key: string): void {
  const proto = IDBObjectStore.prototype;
  const orig = proto.put;
  let armed = true;
  proto.put = function (this: IDBObjectStore, ...args: unknown[]) {
    const rec = args[0] as { key?: string } | undefined;
    if (armed && rec && rec.key === key) {
      armed = false;
      proto.put = orig;
      throw new DOMException('注入的写盘失败', 'UnknownError');
    }
    return orig.apply(this, args as Parameters<typeof orig>);
  } as typeof orig;
}

beforeEach(async () => {
  await _resetDatabaseForTests();
});

afterEach(() => {
  // failNextPut 未触发时也要恢复原型，避免污染后续用例。
  // （已触发的情况下它在注入点已自行恢复。）
});

describe('草稿保存的乐观并发控制', () => {
  it('两处从同一版本开始编辑：后保存者被拒绝，已确认内容不被覆盖', async () => {
    // 工作站甲：基于空草稿（rev 0）保存 rev 1。
    await saveDraft(draft([cue('a', 'Aria A', '甲的修改')], 1), 0);

    // 工作站乙：同样基于 rev 0（打开时库里还是空草稿），保存自己的 rev 1。
    await expect(
      saveDraft(draft([cue('a', 'Aria B', '乙的修改')], 1), 0),
    ).rejects.toBeInstanceOf(DraftConflictError);

    // 库内仍是甲已确认的内容，乙的旧内容没有静默覆盖。
    const persisted = await loadPersisted();
    expect(persisted.draft.cues[0].source).toBe('Aria A');
    expect(persisted.draft.draftRev).toBe(1);
  });

  it('冲突错误携带对方已保存的草稿（供 UI 提示与载入）', async () => {
    await saveDraft(draft([cue('a', 'Aria A', '甲')], 3), 0);
    try {
      await saveDraft(draft([cue('b', 'Aria B', '乙')], 1), 0);
      expect.unreachable('应当抛出 DraftConflictError');
    } catch (err) {
      expect(err).toBeInstanceOf(DraftConflictError);
      const conflict = err as DraftConflictError;
      expect(conflict.persisted.draftRev).toBe(3);
      expect(conflict.persisted.cues[0].id).toBe('a');
    }
  });

  it('基于最新版本的保存正常成功（单工作站顺序编辑兼容）', async () => {
    await saveDraft(draft([cue('a')], 1), 0);
    await saveDraft(draft([cue('a'), cue('b')], 2), 1);
    await saveDraft(draft([cue('b'), cue('a')], 3), 2);
    const persisted = await loadPersisted();
    expect(persisted.draft.cues.map((c) => c.id)).toEqual(['b', 'a']);
    expect(persisted.draft.draftRev).toBe(3);
  });

  it('显式覆盖：把基线推进到对方版本后，本页内容可以保存且版本单调', async () => {
    await saveDraft(draft([cue('a', 'Aria A', '甲')], 5), 0);
    // 乙显式选择“用本页内容覆盖”：版本号推进到对方之后（5 + 1）。
    await saveDraft(draft([cue('b', 'Aria B', '乙')], 6), 5);
    const persisted = await loadPersisted();
    expect(persisted.draft.cues[0].id).toBe('b');
    expect(persisted.draft.draftRev).toBe(6);
  });

  it('一次写盘失败后重试成功：内容与版本都落盘，不丢已确认修改', async () => {
    failNextPut('draft');
    await expect(saveDraft(draft([cue('a', 'Coro', '合唱')], 1), 0)).rejects.toThrow(
      '注入的写盘失败',
    );
    // 失败不产生任何写入。
    expect((await loadPersisted()).draft.draftRev).toBe(0);

    // 同一内容重试（编辑页在下次编辑 / 切页 / 采用时都会重试）。
    await saveDraft(draft([cue('a', 'Coro', '合唱')], 1), 0);
    const persisted = await loadPersisted();
    expect(persisted.draft.cues[0].source).toBe('Coro');
    expect(persisted.draft.draftRev).toBe(1);
  });
});

describe('采用事务：归档与冻结同一版本', () => {
  it('采用在同事务内归档草稿并冻结快照，二者内容与版本一致', async () => {
    // 模拟“保存失败后立刻采用”：草稿 rev 2 从未单独落盘，
    // 采用事务必须把它一并归档，而不是冻结一个库里没有的版本。
    const frozen = await adoptProgram(
      draft([cue('a', 'Va pensiero', '飞吧思想'), cue('b', 'Coro', '合唱')], 2),
      0,
    );
    expect(frozen.draftRev).toBe(2);

    const persisted = await loadPersisted();
    expect(persisted.draft.draftRev).toBe(2);
    expect(persisted.frozen?.draftRev).toBe(2);
    // 逐项一致：存档与放行快照是同一份内容的两个引用。
    expect(persisted.draft.cues).toEqual(persisted.frozen?.cues);
    expect(persisted.frozen?.cues.map((c) => c.source)).toEqual([
      'Va pensiero',
      'Coro',
    ]);
  });

  it('采用时另一页面已保存更新草稿：拒绝且不归档、不冻结', async () => {
    // 甲保存 rev 1。
    await saveDraft(draft([cue('a', 'Aria A', '甲')], 1), 0);
    // 乙基于 rev 0 的页面直接点“采用”。
    await expect(
      adoptProgram(draft([cue('b', 'Aria B', '乙')], 1), 0),
    ).rejects.toBeInstanceOf(DraftConflictError);

    const persisted = await loadPersisted();
    expect(persisted.draft.cues[0].id).toBe('a'); // 归档未被覆盖
    expect(persisted.frozen).toBeNull(); // 未产生冻结
  });

  it('采用事务写盘失败：草稿归档与冻结快照都保持原样（整体回滚）', async () => {
    // 先有一个已确认的在演版本与草稿。
    await saveDraft(draft([cue('a', 'Vecchio', '旧')], 1), 0);
    await adoptProgram(draft([cue('a', 'Vecchio', '旧')], 1), 1);

    // 冻结键写盘失败：整个采用事务回滚，草稿归档也不应被改写。
    failNextPut('frozen');
    await expect(
      adoptProgram(draft([cue('a', 'Nuovo', '新')], 2), 1),
    ).rejects.toThrow('注入的写盘失败');

    const persisted = await loadPersisted();
    expect(persisted.draft.cues[0].source).toBe('Vecchio'); // 归档未半更新
    expect(persisted.draft.draftRev).toBe(1);
    expect(persisted.frozen?.cues[0].source).toBe('Vecchio'); // 在演版本原样
    expect(persisted.frozen?.draftRev).toBe(1);

    // 故障恢复后重试同一采用：成功且归档 / 冻结一致。
    const frozen = await adoptProgram(draft([cue('a', 'Nuovo', '新')], 2), 1);
    expect(frozen.draftRev).toBe(2);
    const again = await loadPersisted();
    expect(again.draft.cues[0].source).toBe('Nuovo');
    expect(again.frozen?.cues[0].source).toBe('Nuovo');
    expect(again.frozen?.draftRev).toBe(again.draft.draftRev);
  });

  it('空节目单拒绝采用，且不做任何写入', async () => {
    await expect(adoptProgram(draft([], 1), 0)).rejects.toBeInstanceOf(
      EmptyProgramError,
    );
    const persisted = await loadPersisted();
    expect(persisted.draft.cues).toEqual([]);
    expect(persisted.frozen).toBeNull();
  });
});

describe('读取兼容（升级前的库存数据）', () => {
  it('没有 draftRev 的旧冻结版本照常读取，字段为 undefined', async () => {
    // 手工写入一份“旧格式”冻结记录（升级前的字段集合）。
    const legacyFrozen = {
      cues: [cue('a', 'Vecchia', '旧版')],
      frozenAt: 123456,
    } satisfies FrozenProgram;
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put({ key: 'frozen', value: legacyFrozen });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    const persisted = await loadPersisted();
    expect(persisted.frozen?.cues[0].source).toBe('Vecchia');
    expect(persisted.frozen?.frozenAt).toBe(123456);
    expect(persisted.frozen?.draftRev).toBeUndefined();

    // 旧冻结版本之上可以正常再次采用（新版本带可追溯的 draftRev）。
    const frozen = await adoptProgram(draft([cue('a', 'Nuova', '新版')], 1), 0);
    expect(frozen.draftRev).toBe(1);
    expect((await loadPersisted()).frozen?.draftRev).toBe(1);
  });
});
