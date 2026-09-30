// 单元测试便捷工具：以“编辑页”的方式采用节目单——读取库内当前草稿版本
// 作为基线，在同一事务归档并冻结给定条目（与 useProgram.adopt 一致）。
import type { Cue } from '../../src/types';
import { adoptProgram, loadPersisted } from '../../src/lib/db';

export async function adoptCues(cues: Cue[]): Promise<
  ReturnType<typeof adoptProgram> extends Promise<infer F> ? F : never
> {
  const { draft } = await loadPersisted();
  return adoptProgram(
    { cues, draftRev: draft.draftRev + 1, updatedAt: Date.now() },
    draft.draftRev,
  );
}
