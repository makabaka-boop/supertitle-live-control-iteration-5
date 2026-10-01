// IndexedDB 封装。所有演出状态写入均以单事务完成，失败即整体回滚，
// 调用方据此保留“上一幅已确认画面”，绝不出现先成功后回退。
//
// 紧急黑场锁定：锁定记录与已确认黑场帧在同一笔读写事务内原子写入，
// 失败则二者都不变；锁定独立持久、跨代次存活，仅“当前持锁且代次匹配”
// 的控制页可在事务内核验后写入 / 解除（旧库存无此键即按未锁定处理）。

import type {
  BlackoutLock,
  FrameContent,
  FrameState,
  FrozenProgram,
  HandoffRecord,
  ProgramDraft,
  UndoRecord,
} from '../types';
import {
  isContentInFrozenProgram,
  isExplicitBlackout,
  seedContentForProgram,
} from './protocol';

const DB_NAME = 'opera-prompter';
const DB_VERSION = 1;
const STORE = 'kv';

const KEY_DRAFT = 'draft';
const KEY_FROZEN = 'frozen';
const KEY_FRAME = 'frame';
const KEY_META = 'meta';
const KEY_HANDOFF = 'handoff';
const KEY_BLACKOUT_LOCK = 'blackout-lock';
const KEY_UNDO = 'undo';

interface KvRecord<T> {
  key: string;
  value: T;
}

interface Meta {
  /** 已使用的最大代次；每次开演/接管在事务内 +1。 */
  generation: number;
}

/** 调用方代次过期（已有新控制者开演）。 */
export class StaleGenerationError extends Error {
  constructor(
    public readonly expected: number,
    public readonly actual: number,
  ) {
    super(`代次已过期：本页持有第 ${expected} 代，当前为第 ${actual} 代`);
    this.name = 'StaleGenerationError';
  }
}

/** 调用方已不是本代次的唯一控制者。 */
export class ControllerMismatchError extends Error {
  constructor() {
    super('控制者校验失败：本页已不再是当前有效操控者');
    this.name = 'ControllerMismatchError';
  }
}

/** 交接授权目标与本页身份不符：本页必须不改代次地让锁继续排队。 */
export class HandoffTargetMismatchError extends Error {
  constructor() {
    super('交接授权指定的是其他控制页，本页不改代次地让锁并继续排队');
    this.name = 'HandoffTargetMismatchError';
  }
}

/** 交接授权版本与本页持有的不一致（旧 / 错误的交接消息）。 */
export class HandoffVersionMismatchError extends Error {
  constructor() {
    super('交接授权版本不匹配：不是本次交接的有效授权');
    this.name = 'HandoffVersionMismatchError';
  }
}

/** 交接授权已过有效期：排队页重新参与普通接管。 */
export class HandoffExpiredError extends Error {
  constructor() {
    super('交接授权已过期：重新参与普通接管');
    this.name = 'HandoffExpiredError';
  }
}

/** 交接授权已被消费（重复消费）：不允许再开代次。 */
export class HandoffConsumedError extends Error {
  constructor() {
    super('交接授权已被消费，不能重复开代次');
    this.name = 'HandoffConsumedError';
  }
}

/** 尚无冻结节目单，不能开演。 */
export class NoFrozenProgramError extends Error {
  constructor() {
    super('尚未采用节目单，不能开演');
    this.name = 'NoFrozenProgramError';
  }
}

/** 节目单为空，不能采用。 */
export class EmptyProgramError extends Error {
  constructor() {
    super('节目单为空，不能采用');
    this.name = 'EmptyProgramError';
  }
}

/**
 * 草稿版本冲突：库内草稿的 draftRev 已不是调用方所基于的版本
 * （另一页面保存过更新的草稿）。本次写入被拒绝，未产生任何修改：
 * 调用方不得显示“保存成功”，已确认内容保留在库内等待显式解决。
 * persisted 携带对方已保存的草稿，供 UI 提示与载入。
 */
export class DraftConflictError extends Error {
  constructor(public readonly persisted: ProgramDraft) {
    super(
      `草稿版本冲突：另一页面已保存版本 ${persisted.draftRev}，本页修改基于旧版本`,
    );
    this.name = 'DraftConflictError';
  }
}

/**
 * 待发布画面不属于最新冻结节目：条目已被删除、重排后失效或文案已被修改。
 * 重新采用后仍打开着旧条目的控制页据此被拦截，旧 cue 无法继续发布。
 */
export class CueNotInFrozenProgramError extends Error {
  constructor() {
    super('画面条目不在最新冻结节目中（已删除或已修改），不能发布');
    this.name = 'CueNotInFrozenProgramError';
  }
}

/** 紧急黑场锁定中：切句请求一律拒绝（显式单帧黑场除外，由别处另行判断）。 */
export class BlackoutLockedError extends Error {
  constructor() {
    super('紧急黑场锁定中：切句已被拒绝，需当前控制者显式解除锁定');
    this.name = 'BlackoutLockedError';
  }
}

/**
 * 没有可用的“撤销上一帧”资格：本代次本控制者尚未做过可撤销发布、
 * 已撤销过一次（资格一次性）、资格属于旧代次 / 旧帧（重复撤销、重试、
 * 其间又确认了新画面）。调用方保持当前画面不变。
 */
export class NothingToUndoError extends Error {
  constructor() {
    super('没有可撤销的上一帧：未发布过、已撤销或资格属于旧代次 / 旧画面');
    this.name = 'NothingToUndoError';
  }
}

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    const cached: Promise<IDBDatabase> = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'key' });
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        const invalidate = () => {
          if (dbPromise === cached) dbPromise = null;
        };
        // 其他页面请求删除 / 升级数据库时主动让路，避免 deleteDatabase 永久 blocked。
        db.onversionchange = () => {
          db.close();
          invalidate();
        };
        db.onclose = invalidate;
        resolve(db);
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () =>
        reject(new Error('数据库被其他标签页阻塞，请关闭旧页面后重试'));
    });
    dbPromise = cached;
  }
  return dbPromise;
}

function txPromise<T>(
  tx: IDBTransaction,
  work: () => T | Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let result: T;
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(tx.error ?? new Error('事务已中止'));
    tx.onerror = () => reject(tx.error ?? new Error('事务出错'));
    try {
      const maybe = work();
      if (maybe instanceof Promise) {
        maybe.then(
          (v) => {
            result = v;
          },
          (err) => {
            try {
              tx.abort();
            } catch {
              /* 已中止则忽略 */
            }
            reject(err);
          },
        );
      } else {
        result = maybe;
      }
    } catch (err) {
      try {
        tx.abort();
      } catch {
        /* 同上 */
      }
      reject(err);
    }
  });
}

function reqAsPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function getValue<T>(store: IDBObjectStore, key: string): Promise<T | undefined> {
  return reqAsPromise(store.get(key) as IDBRequest<KvRecord<T> | undefined>).then(
    (rec) => rec?.value,
  );
}

function putValue<T>(store: IDBObjectStore, key: string, value: T): void {
  store.put({ key, value } satisfies KvRecord<T>);
}

function deleteValue(store: IDBObjectStore, key: string): void {
  store.delete(key);
}

export function newEmptyDraft(now: number = Date.now()): ProgramDraft {
  return { cues: [], draftRev: 0, updatedAt: now };
}

async function readDraft(store: IDBObjectStore): Promise<ProgramDraft> {
  return (await getValue<ProgramDraft>(store, KEY_DRAFT)) ?? newEmptyDraft();
}

/** 读取全部持久状态（单一只读事务）。 */
export async function loadPersisted(): Promise<{
  draft: ProgramDraft;
  frozen: FrozenProgram | null;
  frame: FrameState | null;
  blackoutLock: BlackoutLock | null;
  undo: UndoRecord | null;
}> {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readonly');
  const store = tx.objectStore(STORE);
  return txPromise(tx, async () => ({
    draft: await readDraft(store),
    frozen: (await getValue<FrozenProgram>(store, KEY_FROZEN)) ?? null,
    frame: (await getValue<FrameState>(store, KEY_FRAME)) ?? null,
    // 旧库存没有此键：天然按“未锁定”读取。
    blackoutLock:
      (await getValue<BlackoutLock>(store, KEY_BLACKOUT_LOCK)) ?? null,
    // 旧库存没有此键：天然按“不可撤销”读取。
    undo: (await getValue<UndoRecord>(store, KEY_UNDO)) ?? null,
  }));
}

/**
 * 保存草稿（乐观并发控制）。同一读写事务内：
 *   1) 读取库内草稿，其 draftRev 必须仍等于 expectedRev（本页内容所基于的
 *      版本）；不一致说明另一页面已保存更新草稿，抛 DraftConflictError 且
 *      本次不写入——后保存的旧内容不能静默覆盖已确认的新内容；
 *   2) 写入草稿。绝不触碰冻结版本与画面。
 * 调用方必须保证有内容变更时 draft.draftRev > expectedRev（版本号单调）。
 */
export async function saveDraft(
  draft: ProgramDraft,
  expectedRev: number,
): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  await txPromise(tx, async () => {
    const persisted = await readDraft(store);
    if (persisted.draftRev !== expectedRev) {
      throw new DraftConflictError(persisted);
    }
    putValue(store, KEY_DRAFT, draft);
  });
}

/**
 * 采用节目单：在**同一个读写事务**内
 *   1) 空节目单拒绝；
 *   2) 核对库内草稿 draftRev == expectedRev：另一页面已保存更新版本时抛
 *      DraftConflictError，不归档、不冻结（未确认分叉绝不误作正式演出单）；
 *   3) 把本页草稿原样归档（此前保存失败 / 尚未落盘的内容在此一并落盘——
 *      能冻结的内容必然已归档，未持久化的草稿不可能被冻结）；
 *   4) 写入冻结快照：条目逐字拷贝，并记录同一 draftRev。
 * 编辑、草稿存档与放行快照引用同一可追溯版本；事务失败则两者都保持原样，
 * 不存在“放行成功、重开后草稿仍是旧内容”的半更新状态。
 */
export async function adoptProgram(
  draft: ProgramDraft,
  expectedRev: number,
): Promise<FrozenProgram> {
  if (draft.cues.length === 0) {
    throw new EmptyProgramError();
  }
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  return txPromise(tx, async () => {
    const persisted = await readDraft(store);
    if (persisted.draftRev !== expectedRev) {
      throw new DraftConflictError(persisted);
    }
    // 先归档：与冻结快照同事务，内容与版本必然一致。
    putValue(store, KEY_DRAFT, draft);
    const snapshot: FrozenProgram = {
      cues: draft.cues.map((c) => ({ ...c })),
      frozenAt: Date.now(),
      draftRev: draft.draftRev,
    };
    putValue(store, KEY_FROZEN, snapshot);
    return snapshot;
  });
}

export interface StartResult {
  generation: number;
  frame: FrameState;
  /**
   * 接管后仍生效的紧急黑场锁定（锁定跨代次存活，记录原样保留）；
   * null 表示未锁定。新控制者必须显式解除后才可发布 cue。
   */
  blackoutLock: BlackoutLock | null;
}

/**
 * 开演 / 接管：单事务内
 *   1) 校验已采用节目单；
 *   2) 读取并递增代次；
 *   3) 写入本代次第 0 号画面。
 *      首次开演为黑场等待；接管时以调用方传入的上一代画面为候选，
 *      与事务内读到的最新冻结节目比对：仍存在且未被改写的画面沿用，
 *      保证接管瞬间不闪黑；已删除 / 已修改的画面以黑场进入新代次。
 *      紧急黑场锁定跨接管存活：只要锁定记录仍在，首帧一律强制黑场，
 *      防止备用控制页接管后自动恢复字幕。
 * 事务失败则全部不生效，调用方不能自认为控制者。
 */
export async function startPerformance(
  controller: { id: string; label: string },
  opts: { initialContent?: FrameContent; now?: number } = {},
): Promise<StartResult> {
  const now = opts.now ?? Date.now();
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);

  return txPromise(tx, async () => {
    const frozen = await getValue<FrozenProgram>(store, KEY_FROZEN);
    if (!frozen || frozen.cues.length === 0) {
      throw new NoFrozenProgramError();
    }
    const meta = (await getValue<Meta>(store, KEY_META)) ?? { generation: 0 };
    const generation = meta.generation + 1;
    putValue(store, KEY_META, { generation } satisfies Meta);

    // 普通接管路径：任何已过期的交接授权都作废，系统回到普通竞争。
    const handoff = await getValue<HandoffRecord>(store, KEY_HANDOFF);
    if (handoff && handoff.expiresAt <= now) {
      deleteValue(store, KEY_HANDOFF);
    }

    // 撤销资格严格绑定旧控制者 / 旧代次：新一代不得沿用，事务内直接清除。
    deleteValue(store, KEY_UNDO);

    // 紧急黑场锁定跨普通接管持续存在：记录原样保留（不解、不改）。
    const blackoutLock =
      (await getValue<BlackoutLock>(store, KEY_BLACKOUT_LOCK)) ?? null;

    // 以事务内读到的最新冻结版本裁决沿用画面：仍在节目中且未被改写的
    // 最后确认画面继续显示（不闪黑）；已删除 / 已修改的画面黑场进入新代次。
    // 锁定中则一律黑场进入新代次，绝不沿用旧字幕。
    const content = blackoutLock
      ? seedContentForProgram(null, frozen)
      : opts.initialContent
        ? seedContentForProgram(opts.initialContent, frozen)
        : seedContentForProgram(null, frozen);

    const frame: FrameState = {
      generation,
      sequence: 0,
      controllerId: controller.id,
      controllerLabel: controller.label,
      content,
      publishedAt: now,
    };
    putValue(store, KEY_FRAME, frame);
    return { generation, frame, blackoutLock };
  });
}

/**
 * 发布下一幅画面（切句 / 黑场）。同一读写事务内：
 *   - 核对持久代次 == 调用方代次（防旧页覆盖新代次）；
 *   - 核对当前画面控制者 == 调用方（唯一操控者）；
 *   - 紧急黑场锁定中只允许显式单帧黑场（cueId=null，普通黑场按钮），
 *     切句（字幕 / 指向具体黑场条目）一律拒绝且不解除锁定；
 *   - 核对待发布内容属于最新冻结节目（条目仍在且文案逐字一致；显式黑场除外）；
 *   - 序号 +1 并整帧写入；
 *   - 同时写入“一次撤销上一帧”资格：记录当前帧（可恢复的前一帧）与新帧序号，
 *     与新帧原子确认。未锁定时才产生资格——紧急锁定期间发布的单帧黑场
 *     不得留下“撤销后回到锁定前字幕”的通道。
 * 任一步失败事务回滚，库内仍为上一幅确认画面，错误向上抛出由 UI 报错。
 */
export async function publishFrame(args: {
  controllerId: string;
  generation: number;
  content: FrameContent;
  now?: number;
}): Promise<FrameState> {
  const { controllerId, generation, content } = args;
  const now = args.now ?? Date.now();
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);

  return txPromise(tx, async () => {
    const meta = (await getValue<Meta>(store, KEY_META)) ?? { generation: 0 };
    if (meta.generation !== generation) {
      throw new StaleGenerationError(generation, meta.generation);
    }
    const current = await getValue<FrameState>(store, KEY_FRAME);
    if (
      !current ||
      current.controllerId !== controllerId ||
      current.generation !== generation
    ) {
      throw new ControllerMismatchError();
    }
    // 紧急黑场锁定栅栏：锁定记录存在即拒绝切句。显式单帧黑场仍允许，
    // 但它绝不修改 / 解除锁定（普通黑场按钮不产生锁定语义）。
    const lock = await getValue<BlackoutLock>(store, KEY_BLACKOUT_LOCK);
    if (lock && !isExplicitBlackout(content)) {
      throw new BlackoutLockedError();
    }
    // 节目一致性栅栏：重新采用后，仍打开旧条目的控制页不得再发布已删除
    // 或旧文案的 cue；显式黑场（cueId=null）始终允许，舞台随时可拉黑。
    const frozen = await getValue<FrozenProgram>(store, KEY_FROZEN);
    if (!isContentInFrozenProgram(content, frozen ?? null)) {
      throw new CueNotInFrozenProgramError();
    }
    const next: FrameState = {
      generation,
      sequence: current.sequence + 1,
      controllerId,
      controllerLabel: current.controllerLabel,
      content,
      publishedAt: now,
    };
    putValue(store, KEY_FRAME, next);
    // 撤销资格与新帧同事务原子写入：提交后“当前帧 + 可撤销前一帧”必然同时存在。
    // 紧急锁定中的单帧黑场不产生资格，且任何旧资格都被本次普通发布整体覆盖
    // （资格一次性、只针对最近一次普通发布）。
    if (!lock) {
      const undo: UndoRecord = {
        generation,
        controllerId,
        publishSequence: next.sequence,
        previousFrame: current,
        createdAt: now,
      };
      putValue(store, KEY_UNDO, undo);
    }
    return next;
  });
}

/** 单独读取最近一次已确认画面（投影页重开时调用）。 */
export async function loadFrame(): Promise<FrameState | null> {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readonly');
  const store = tx.objectStore(STORE);
  return txPromise(
    tx,
    async () => (await getValue<FrameState>(store, KEY_FRAME)) ?? null,
  );
}

/**
 * 读取“撤销上一帧”资格（无记录时为 null；旧库存自然没有此键，按不可撤销处理）。
 */
export async function loadUndo(): Promise<UndoRecord | null> {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readonly');
  const store = tx.objectStore(STORE);
  return txPromise(
    tx,
    async () => (await getValue<UndoRecord>(store, KEY_UNDO)) ?? null,
  );
}

/**
 * “一次撤销上一帧”。撤销**不是回退序号**：把资格记录中的前一帧内容，以
 * 比当前帧**更高的序号**重新发布——投影端的 (代次, 序号) 栅栏因此把它当作
 * 正常的新确认画面接受，绝不会误判为迟到的旧画面。
 *
 * 同一读写事务内：
 *   1) 核对持久代次 == 调用方代次（接管后的旧页重试：StaleGenerationError）；
 *   2) 核对当前画面控制者 == 调用方（冒充者：ControllerMismatchError）；
 *   3) 读取撤销资格：不存在 / 代次或身份不符 / publishSequence 已不是当前帧
 *      序号（未发布过、已撤销、重复撤销、其间又确认了新画面）一律
 *      NothingToUndoError，且当前帧不做任何改动；
 *   4) 紧急黑场锁定栅栏：锁定中不能借撤销恢复字幕（正常流程下锁定时也不会
 *      留下资格，此处为纵深防御）；
 *   5) 目标 cue 栅栏：恢复内容必须仍属于当前冻结节目——重新采用后目标 cue
 *      已删除 / 被改写时拒绝撤销（CueNotInFrozenProgramError）；显式黑场除外；
 *   6) 删除资格（一次性）并以当前序号 +1 写入恢复帧。
 * 事务提交成功后调用方才可广播；失败则库内、控制台与投影都停留在当前帧。
 */
export async function undoLastFrame(args: {
  controllerId: string;
  generation: number;
  now?: number;
}): Promise<FrameState> {
  const { controllerId, generation } = args;
  const now = args.now ?? Date.now();
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);

  return txPromise(tx, async () => {
    const meta = (await getValue<Meta>(store, KEY_META)) ?? { generation: 0 };
    if (meta.generation !== generation) {
      throw new StaleGenerationError(generation, meta.generation);
    }
    const current = await getValue<FrameState>(store, KEY_FRAME);
    if (
      !current ||
      current.controllerId !== controllerId ||
      current.generation !== generation
    ) {
      throw new ControllerMismatchError();
    }

    const undo = await getValue<UndoRecord>(store, KEY_UNDO);
    if (
      !undo ||
      undo.generation !== generation ||
      undo.controllerId !== controllerId ||
      undo.publishSequence !== current.sequence
    ) {
      // 旧库存无键、已撤销、重复撤销、旧页重试、资格已被更新的发布覆盖：
      // 一律拒绝且不触碰当前帧。
      throw new NothingToUndoError();
    }

    // 纵深防御：锁定中绝不通过撤销恢复字幕（正常流程锁定不产生资格）。
    const lock = await getValue<BlackoutLock>(store, KEY_BLACKOUT_LOCK);
    if (lock && !isExplicitBlackout(undo.previousFrame.content)) {
      throw new BlackoutLockedError();
    }

    // 目标 cue 必须仍属于当前冻结节目：重新采用删除 / 改写后拒绝恢复旧内容。
    const frozen = await getValue<FrozenProgram>(store, KEY_FROZEN);
    if (!isContentInFrozenProgram(undo.previousFrame.content, frozen ?? null)) {
      throw new CueNotInFrozenProgramError();
    }

    // 资格一次性：先删除，再以更高序号重新发布前一帧内容。
    deleteValue(store, KEY_UNDO);
    const restored: FrameState = {
      generation,
      sequence: current.sequence + 1,
      controllerId,
      controllerLabel: current.controllerLabel,
      content: undo.previousFrame.content,
      publishedAt: now,
    };
    putValue(store, KEY_FRAME, restored);
    return restored;
  });
}

/** 仅测试使用：直接写入撤销资格（模拟异常时序 / 旧页重试等场景）。 */
export async function _putUndoForTests(record: UndoRecord): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  putValue(store, KEY_UNDO, record);
  await txPromise(tx, () => undefined);
}

/** 读取紧急黑场锁定（无记录时为 null；旧库存自然没有此键，按未锁定处理）。 */
export async function loadBlackoutLock(): Promise<BlackoutLock | null> {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readonly');
  const store = tx.objectStore(STORE);
  return txPromise(
    tx,
    async () => (await getValue<BlackoutLock>(store, KEY_BLACKOUT_LOCK)) ?? null,
  );
}

export interface BlackoutLockResult {
  lock: BlackoutLock;
  frame: FrameState;
}

/**
 * 紧急黑场锁定：在**同一个读写事务**里
 *   1) 核对持久代次 == 调用方代次（旧代次页面不能设置 / 覆盖）；
 *   2) 核对当前画面控制者 == 调用方（冒充者拒绝）；
 *   3) 写入锁定记录（本代次、本身份）与“已确认黑场帧”（序号 +1、
 *      cueId=null 的显式黑场）；
 * 两者一次确认。事务失败则锁定与画面都停留在上一个确认状态，
 * 绝不出现“画面黑了但锁定丢失”。提交成功后调用方才可广播。
 */
export async function engageBlackoutLock(args: {
  controllerId: string;
  controllerLabel: string;
  generation: number;
  now?: number;
}): Promise<BlackoutLockResult> {
  const now = args.now ?? Date.now();
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);

  return txPromise(tx, async () => {
    const meta = (await getValue<Meta>(store, KEY_META)) ?? { generation: 0 };
    if (meta.generation !== args.generation) {
      throw new StaleGenerationError(args.generation, meta.generation);
    }
    const current = await getValue<FrameState>(store, KEY_FRAME);
    if (
      !current ||
      current.controllerId !== args.controllerId ||
      current.generation !== args.generation
    ) {
      throw new ControllerMismatchError();
    }

    const lock: BlackoutLock = {
      generation: args.generation,
      controllerId: args.controllerId,
      controllerLabel: args.controllerLabel,
      lockedAt: now,
    };
    const frame: FrameState = {
      generation: args.generation,
      sequence: current.sequence + 1,
      controllerId: args.controllerId,
      controllerLabel: current.controllerLabel,
      content: { kind: 'blackout', cueId: null, source: '', translation: '' },
      publishedAt: now,
    };
    // 同一事务：锁定状态 + 已确认黑场帧原子写入。
    // 撤销资格随之作废：锁定后不得借撤销恢复锁定前字幕。
    deleteValue(store, KEY_UNDO);
    putValue(store, KEY_BLACKOUT_LOCK, lock);
    putValue(store, KEY_FRAME, frame);
    return { lock, frame };
  });
}

/**
 * 显式解除紧急黑场锁定。同一读写事务内：
 *   1) 核对持久代次 == 调用方代次；
 *   2) 核对当前画面控制者 == 调用方；
 *   3) 必须确有锁定记录（重复解除幂等返回 null，不产生任何写入）；
 *   4) 删除锁定记录。
 * 旧代次页面（含接管后仍打开的旧控制页）与冒充者都不能解除；
 * 画面本身不改动——解除只放行后续 cue 发布，舞台保持黑场直到主控主动切句。
 */
export async function releaseBlackoutLock(args: {
  controllerId: string;
  generation: number;
}): Promise<{ lock: BlackoutLock | null }> {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);

  return txPromise(tx, async () => {
    const meta = (await getValue<Meta>(store, KEY_META)) ?? { generation: 0 };
    if (meta.generation !== args.generation) {
      throw new StaleGenerationError(args.generation, meta.generation);
    }
    const current = await getValue<FrameState>(store, KEY_FRAME);
    if (
      !current ||
      current.controllerId !== args.controllerId ||
      current.generation !== args.generation
    ) {
      throw new ControllerMismatchError();
    }
    const lock =
      (await getValue<BlackoutLock>(store, KEY_BLACKOUT_LOCK)) ?? null;
    if (!lock) {
      // 本就未锁定：幂等，无写入。
      return { lock: null };
    }
    deleteValue(store, KEY_BLACKOUT_LOCK);
    return { lock };
  });
}

/** 读取待交接记录（无记录时为 null；旧 IndexedDB 自然没有此键）。 */
export async function loadHandoff(): Promise<HandoffRecord | null> {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readonly');
  const store = tx.objectStore(STORE);
  return txPromise(
    tx,
    async () => (await getValue<HandoffRecord>(store, KEY_HANDOFF)) ?? null,
  );
}

/**
 * 保存“待交接记录”（指定并交权）。必须在该记录确认落盘之后，
 * 调用方才可以释放 Web Lock；失败则本方法抛错，调用方继续持锁。
 */
export async function saveHandoff(record: HandoffRecord): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  putValue(store, KEY_HANDOFF, record);
  await txPromise(tx, () => undefined);
}

export interface ConsumeHandoffArgs {
  controller: { id: string; label: string };
  /** 本页看到的交接记录版本；必须与持久记录严格相等。 */
  version: string;
  /** 沿用上一代最后一幅已确认画面（本方法由调用方传入 content）。 */
  initialContent?: FrameContent;
  now?: number;
}

/**
 * 消费交接授权并开启下一代，单事务内一次完成：
 *   1) 校验已采用节目单；
 *   2) 读取交接记录：必须存在、未过期、目标 == 本页、版本 == 本页版本；
 *   3) 删除交接记录（单次消费，重复消费者再也找不到授权）；
 *   4) 代次 +1、写入沿用的上一幅确认画面。
 *      紧急黑场锁定跨指定交权存活：锁定记录原样保留，接权首帧强制黑场，
 *      被指定页也不能借交权自动恢复字幕。
 * 任一步失败整体回滚：授权、新代次、画面（与锁定）都不变，由调用方提示并让锁重试。
 */
export async function consumeHandoff(
  args: ConsumeHandoffArgs,
): Promise<StartResult> {
  const now = args.now ?? Date.now();
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);

  return txPromise(tx, async () => {
    const frozen = await getValue<FrozenProgram>(store, KEY_FROZEN);
    if (!frozen || frozen.cues.length === 0) {
      throw new NoFrozenProgramError();
    }
    const handoff = await getValue<HandoffRecord>(store, KEY_HANDOFF);
    if (!handoff) throw new HandoffConsumedError();
    if (handoff.expiresAt <= now) throw new HandoffExpiredError();
    if (handoff.targetId !== args.controller.id) {
      throw new HandoffTargetMismatchError();
    }
    if (handoff.version !== args.version) {
      throw new HandoffVersionMismatchError();
    }

    // 资格全部命中：删除授权（单次消费）。
    deleteValue(store, KEY_HANDOFF);
    // 撤销资格属于上一控制者 / 上一代次：接权后不得沿用，一并清除。
    deleteValue(store, KEY_UNDO);

    const meta = (await getValue<Meta>(store, KEY_META)) ?? { generation: 0 };
    const generation = meta.generation + 1;
    putValue(store, KEY_META, { generation } satisfies Meta);

    // 紧急黑场锁定跨指定交权持续存在：记录原样保留。
    const blackoutLock =
      (await getValue<BlackoutLock>(store, KEY_BLACKOUT_LOCK)) ?? null;

    // 与普通接管一致：按最新冻结节目裁决沿用画面，删除 / 修改的画面黑场进入；
    // 锁定中一律黑场进入新代次。
    const content = blackoutLock
      ? seedContentForProgram(null, frozen)
      : seedContentForProgram(args.initialContent ?? null, frozen);

    const frame: FrameState = {
      generation,
      sequence: 0,
      controllerId: args.controller.id,
      controllerLabel: args.controller.label,
      content,
      publishedAt: now,
    };
    putValue(store, KEY_FRAME, frame);
    return { generation, frame, blackoutLock };
  });
}

/** 仅测试使用：重置数据库。 */
export async function _resetDatabaseForTests(): Promise<void> {
  if (dbPromise) {
    const db = await dbPromise;
    db.close();
    dbPromise = null;
  }
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('删除数据库被阻塞'));
  });
}
