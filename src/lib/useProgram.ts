import { useCallback, useEffect, useRef, useState } from 'react';
import type { Cue, FrozenProgram, ProgramDraft } from '../types';
import {
  adoptProgram,
  DraftConflictError,
  EmptyProgramError,
  loadPersisted,
  newEmptyDraft,
  saveDraft,
} from './db';
import { announceProgramAdoption } from './sessions';

const AUTOSAVE_DELAY_MS = 400;

export interface ProgramConflict {
  /** 另一页面已确认保存的草稿版本号。 */
  persistedRev: number;
  persistedAt: number;
}

export interface ProgramState {
  draft: ProgramDraft;
  frozen: FrozenProgram | null;
  saving: boolean;
  /** 存在尚未确认落盘的本地修改（等待防抖 / 上次保存失败）。 */
  dirty: boolean;
  savedAt: number | null;
  error: string | null;
  /**
   * 另一页面保存了更新版本：自动保存已暂停，本页修改保留在屏幕上，
   * 必须显式“载入最新”或“覆盖对方”后才会再次写入。
   */
  conflict: ProgramConflict | null;
}

function newCueId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `cue-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function makeCue(kind: Cue['kind']): Cue {
  return {
    id: newCueId(),
    kind,
    source: '',
    translation: '',
    note: '',
  };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 页面级（同源标签内）串行队列：所有草稿读取 / 保存 / 采用都按入队顺序执行。
 * 切页时旧编辑页卸载前入队的 flush 一定先于新页面挂载时入队的读取完成，
 * 尚未防抖落盘的修改不会因切页消失。跨标签页（另一工作站）的并发由
 * IndexedDB 事务内的 draftRev 乐观并发核对兜底。
 */
let opChain: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = opChain.then(task, task);
  // 前一个任务失败不阻断后续任务；返回给调用方的 promise 才携带任务自身结果。
  opChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * 节目单草稿的编辑 / 排序 / 持久化。
 * - 修改经防抖自动保存，保存是 draftRev 乐观并发核对：基于旧版本的保存
 *   报冲突而不是静默覆盖对方已确认内容；
 * - 卸载（切页）/ pagehide 立即把未落盘内容排队写入；
 * - “采用”在单一事务内归档草稿并冻结同一版本，保存失败过的草稿只有
 *   在该事务里归档成功才可能被冻结。
 */
export function useProgram() {
  const [state, setState] = useState<ProgramState>({
    draft: newEmptyDraft(),
    frozen: null,
    saving: false,
    dirty: false,
    savedAt: null,
    error: null,
    conflict: null,
  });
  // 串行任务执行时读的是这些 ref 的当下值，不依赖渲染闭包。
  const draftRef = useRef<ProgramDraft>(state.draft);
  /** 本页内容所基于的库内草稿版本（读取完成或上次保存成功后更新）。 */
  const baseRevRef = useRef(0);
  const dirtyRef = useRef(false);
  const conflictRef = useRef(false);
  const loaded = useRef(false);
  const unmounted = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const patchState = useCallback((patch: Partial<ProgramState>) => {
    if (unmounted.current) return;
    setState((s) => ({ ...s, ...patch }));
  }, []);

  /**
   * 把当前草稿落盘（仅当脏且无冲突）。任务执行时才取最新草稿与基线版本，
   * 因此可安全地在卸载后的串行队列里运行。
   */
  const persistNow = useCallback(async (): Promise<void> => {
    if (!loaded.current || !dirtyRef.current || conflictRef.current) return;
    const draft = draftRef.current;
    try {
      await saveDraft(draft, baseRevRef.current);
      baseRevRef.current = draft.draftRev;
      dirtyRef.current = false;
      patchState({
        saving: dirtyRef.current,
        dirty: dirtyRef.current,
        savedAt: Date.now(),
        error: null,
      });
    } catch (err) {
      if (err instanceof DraftConflictError) {
        // 对方已确认内容保留在库内；本页暂停自动保存，等待显式解决。
        conflictRef.current = true;
        patchState({
          saving: false,
          dirty: true,
          conflict: {
            persistedRev: err.persisted.draftRev,
            persistedAt: err.persisted.updatedAt,
          },
        });
      } else {
        // 写盘失败：不回滚、不清脏，下次编辑 / 切页 / 采用时重试。
        patchState({
          saving: false,
          error: `草稿保存失败：${describe(err)}`,
        });
      }
    }
  }, [patchState]);

  const scheduleSave = useCallback(() => {
    // 冲突未解决前暂停自动保存，避免每次输入都报同一个冲突。
    if (conflictRef.current) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      void enqueue(persistNow);
    }, AUTOSAVE_DELAY_MS);
  }, [persistNow]);

  useEffect(() => {
    let cancelled = false;
    // 读取也排入同一队列：切页时上一实例卸载入队的 flush 先执行，本读取
    // 必然读到切页前的最后修改。
    void enqueue(() =>
      loadPersisted()
        .then(({ draft, frozen }) => {
          if (cancelled) return;
          loaded.current = true;
          baseRevRef.current = draft.draftRev;
          if (dirtyRef.current) {
            // 读取完成前本页已有输入：绝不用库内内容覆盖屏幕上的未保存修改。
            if (draft.cues.length > 0) {
              // 库内已有确认内容（例如另一工作站保存过）：按冲突处理，
              // 本页输入保留在屏幕上，等用户显式选择载入或覆盖。
              conflictRef.current = true;
              draftRef.current = {
                ...draftRef.current,
                // 版本号推进到库内版本之后，保持 draftRev 全局单调。
                draftRev: Math.max(
                  draftRef.current.draftRev,
                  draft.draftRev + 1,
                ),
              };
              setState((s) => ({
                ...s,
                draft: draftRef.current,
                frozen,
                saving: false,
                dirty: true,
                conflict: {
                  persistedRev: draft.draftRev,
                  persistedAt: draft.updatedAt,
                },
              }));
            } else {
              // 库内仍是空草稿：保留本页输入，基线为 0，照常自动保存。
              setState((s) => ({ ...s, frozen }));
            }
            return;
          }
          draftRef.current = draft;
          dirtyRef.current = false;
          setState((s) => ({ ...s, draft, frozen }));
        })
        .catch((err: unknown) => {
          if (!cancelled) {
            setState((s) => ({
              ...s,
              error: `读取节目单失败：${describe(err)}`,
            }));
          }
        }),
    );

    // 真正关闭标签页 / 刷新（而非站内哈希切页）时的尽力落盘。
    const onPageHide = () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      void enqueue(persistNow);
    };
    window.addEventListener('pagehide', onPageHide);

    return () => {
      cancelled = true;
      unmounted.current = true;
      window.removeEventListener('pagehide', onPageHide);
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      // 切页：立即把未落盘修改排队写入。组件虽已卸载，任务仍会在队列里执行完。
      void enqueue(persistNow);
    };
  }, [persistNow]);

  /** 本地修改 + 防抖落盘；始终只改草稿，不碰冻结版本。 */
  const mutate = useCallback(
    (fn: (cues: Cue[]) => Cue[]) => {
      const base = draftRef.current;
      const draft: ProgramDraft = {
        cues: fn(base.cues),
        draftRev: base.draftRev + 1,
        updatedAt: Date.now(),
      };
      draftRef.current = draft;
      dirtyRef.current = true;
      scheduleSave();
      patchState({
        draft,
        saving: !conflictRef.current,
        dirty: true,
        error: null,
      });
    },
    [patchState, scheduleSave],
  );

  const addCue = useCallback(
    (kind: Cue['kind']) => mutate((cues) => [...cues, makeCue(kind)]),
    [mutate],
  );

  const updateCue = useCallback(
    (id: string, patch: Partial<Omit<Cue, 'id'>>) =>
      mutate((cues) =>
        cues.map((c) => (c.id === id ? { ...c, ...patch } : c)),
      ),
    [mutate],
  );

  const removeCue = useCallback(
    (id: string) => mutate((cues) => cues.filter((c) => c.id !== id)),
    [mutate],
  );

  const moveCue = useCallback(
    (id: string, dir: -1 | 1) =>
      mutate((cues) => {
        const idx = cues.findIndex((c) => c.id === id);
        const target = idx + dir;
        if (idx < 0 || target < 0 || target >= cues.length) return cues;
        const copy = cues.slice();
        const [item] = copy.splice(idx, 1);
        copy.splice(target, 0, item);
        return copy;
      }),
    [mutate],
  );

  /** 立即落盘（取消待触发防抖）；供需要确认保存的入口使用。 */
  const flushSave = useCallback(async () => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    await enqueue(persistNow);
  }, [persistNow]);

  /**
   * 采用节目单：空单拒绝；冲突未解决拒绝。采用事务本身归档草稿并冻结快照
   * （同一 draftRev、同一内容）——排在前面的保存尝试先执行，因此一次保存
   * 失败后立刻采用也只会在归档成功时冻结，事务失败则一切保持原样。
   */
  const adopt = useCallback(async (): Promise<boolean> => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    return enqueue(async () => {
      if (!loaded.current) {
        patchState({ error: '节目单尚未读取完成，请稍后再采用。' });
        return false;
      }
      if (conflictRef.current) {
        // 分叉内容必须先显式解决冲突，不能冻结为在演版本。
        return false;
      }
      const draft = draftRef.current;
      try {
        const frozen = await adoptProgram(draft, baseRevRef.current);
        // 归档已随事务确认：本页基线推进到已采用版本。
        baseRevRef.current = draft.draftRev;
        dirtyRef.current = false;
        // 冻结确认落盘后再通知已打开的控制页：主控与排队页都丢弃打开时
        // 缓存的旧条目，改从 IndexedDB 加载本快照。通知失败不影响采用结果。
        try {
          announceProgramAdoption(frozen.frozenAt);
        } catch {
          /* 总线不可用时控制页仍会在下次接管时以库内冻结版本裁决 */
        }
        patchState({
          frozen,
          saving: false,
          dirty: false,
          savedAt: Date.now(),
          error: null,
        });
        return true;
      } catch (err) {
        if (err instanceof EmptyProgramError) {
          patchState({
            error: '空节目单不能采用，请先添加字幕或黑场提示。',
          });
        } else if (err instanceof DraftConflictError) {
          conflictRef.current = true;
          patchState({
            saving: false,
            conflict: {
              persistedRev: err.persisted.draftRev,
              persistedAt: err.persisted.updatedAt,
            },
          });
        } else {
          patchState({
            saving: false,
            error: `采用失败：${describe(err)}`,
          });
        }
        return false;
      }
    });
  }, [patchState]);

  /** 冲突解决：载入另一页面已确认的最新草稿，放弃本页未保存修改（显式选择）。 */
  const reloadLatest = useCallback(async (): Promise<void> => {
    await enqueue(async () => {
      try {
        const { draft, frozen } = await loadPersisted();
        loaded.current = true;
        draftRef.current = draft;
        baseRevRef.current = draft.draftRev;
        dirtyRef.current = false;
        conflictRef.current = false;
        patchState({
          draft,
          frozen,
          saving: false,
          dirty: false,
          error: null,
          conflict: null,
        });
      } catch (err) {
        patchState({ error: `载入最新草稿失败：${describe(err)}` });
      }
    });
  }, [patchState]);

  /**
   * 冲突解决：以本页内容显式覆盖对方版本（舞台监督明确选择，非静默覆盖）。
   * 本页版本号推进到对方版本之后，保持 draftRev 全局单调，使后续并发核对
   * 仍然可靠。
   */
  const overwriteWithMine = useCallback(async (): Promise<void> => {
    await enqueue(async () => {
      try {
        const { draft: persisted } = await loadPersisted();
        const draft: ProgramDraft = {
          ...draftRef.current,
          draftRev: persisted.draftRev + 1,
          updatedAt: Date.now(),
        };
        draftRef.current = draft;
        baseRevRef.current = persisted.draftRev;
        dirtyRef.current = true;
        conflictRef.current = false;
        patchState({ draft, conflict: null, saving: true, dirty: true });
        // 同队列内直接执行落盘：期间又有他处保存时会再次报冲突。
        await persistNow();
      } catch (err) {
        patchState({ error: `覆盖保存失败：${describe(err)}` });
      }
    });
  }, [patchState, persistNow]);

  return {
    state,
    loaded,
    addCue,
    updateCue,
    removeCue,
    moveCue,
    adopt,
    flushSave,
    reloadLatest,
    overwriteWithMine,
  };
}
