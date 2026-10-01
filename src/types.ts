// 核心领域模型与线协议类型。
// 所有跨页面 / 跨会话传递的数据都必须可结构化克隆（IndexedDB、BroadcastChannel）。

/** 单条节目单条目：双语字幕或黑场提示。 */
export interface Cue {
  id: string;
  /** 条目种类：subtitle=双语字幕，blackout=黑场提示。 */
  kind: 'subtitle' | 'blackout';
  /** 原文行（例如意大利语）。blackout 时可为空串。 */
  source: string;
  /** 译文行（例如中文）。blackout 时可为空串。 */
  translation: string;
  /** 舞台备注，仅控制端可见。 */
  note: string;
}

/** 编辑器中的节目单草稿。 */
export interface ProgramDraft {
  cues: Cue[];
  /**
   * 单调递增的草稿版本号：每次确认落盘都严格增大，既是跨页面乐观并发
   * （后保存者必须基于当前版本）的核对依据，也随放行快照一起保存以便追溯。
   */
  draftRev: number;
  updatedAt: number;
}

/**
 * 冻结的在演节目单。一旦“采用节目单”，后续编辑只改草稿，不动本对象。
 * frozenAt 记录冻结时刻。
 *
 * draftRev 是本次冻结来源草稿的版本号：草稿存档（draft 键）与放行快照
 * （frozen 键）在同一事务写入、引用同一版本，编辑页 / 存档 / 放行页
 * 据此追溯。升级前冻结的旧版本没有此字段，读取时为 undefined（读取兼容）。
 */
export interface FrozenProgram {
  cues: Cue[];
  frozenAt: number;
  /** 冻结来源草稿的 draftRev；旧库存的冻结版本可能缺失。 */
  draftRev?: number;
}

/**
 * 代次（generation）：每次控制者成功“开演/接管”时递增。
 * 控制者标识 controllerId 在同一代次内不变；换页接管必然产生新代次。
 */
export interface ControllerInfo {
  controllerId: string;
  /** 人类可读标签，便于舞台监督辨认。 */
  label: string;
}

/** 当前投影画面内容。null 条目表示尚未显示任何句子（开场等待）。 */
export interface FrameContent {
  kind: 'subtitle' | 'blackout';
  cueId: string | null;
  source: string;
  translation: string;
}

/**
 * 持久化的“已确认画面”。
 * generation/sequence 为代次栅栏：投影只接受 (gen 更高) 或 (gen 相同且 seq 更大)。
 */
export interface FrameState {
  generation: number;
  sequence: number;
  controllerId: string;
  controllerLabel: string;
  content: FrameContent;
  /** 本次画面确认写入的时间戳。 */
  publishedAt: number;
}

/**
 * “一次撤销上一帧”资格记录。
 * 发布普通 cue 或普通黑场时，在发布事务内把“当前帧（即可撤销恢复的前一帧）”
 * 连同资格一起写入；撤销不是回退序号，而是把前一帧内容以更高序号重新发布。
 *
 * 资格严格绑定当前控制者与当前代次：
 *  - generation/controllerId 不匹配（接管、指定交权后的旧页重试）一律拒绝；
 *  - publishSequence 必须仍等于当前帧序号（重复撤销、其间又有新帧即失效）；
 *  - 撤销确认的同一事务内删除本记录，资格一次性；
 *  - 接管、指定交权、紧急黑场锁定的事务主动删除本记录；
 *  - 紧急黑场锁定期间发布的单帧黑场不产生本记录。
 * 旧库存没有本键：天然按“不可撤销”读取，无需迁移。
 */
export interface UndoRecord {
  /** 资格所属代次：仅该代次的控制者可使用。 */
  generation: number;
  /** 资格所属控制者身份：仅本人可撤销。 */
  controllerId: string;
  /**
   * 产生本资格的那次发布所确认的帧序号。撤销时当前帧序号必须仍等于它：
   * 已撤销（记录被删）、重复撤销、旧控制页重试、其间又确认了新帧都据此拒绝。
   */
  publishSequence: number;
  /** 可撤销恢复的前一帧（完整快照；撤销时以其 content 重新发布）。 */
  previousFrame: FrameState;
  /** 资格写入时间戳。 */
  createdAt: number;
}

/** IndexedDB 中持久化的整体演出状态。 */
export interface PersistedState {
  draft: ProgramDraft;
  frozen: FrozenProgram | null;
  frame: FrameState | null;
  /**
   * 紧急黑场锁定。独立键持久化：存在即锁定中，不存在（含旧库存无此键）
   * 即未锁定。锁定跨代次（普通接管 / 指定交权 / 重新采用）持续存在，
   * 只有当前持锁且代次匹配的控制页可在单事务中写入 / 解除。
   */
  blackoutLock: BlackoutLock | null;
  /**
   * “一次撤销上一帧”资格。独立键持久化：仅当前控制者、当前代次可使用一次；
   * 接管 / 指定交权 / 紧急锁定时在事务内删除，旧库存无此键即不可撤销。
   */
  undo: UndoRecord | null;
}

/**
 * 紧急黑场锁定记录。
 * 与“已确认黑场帧”在同一 IndexedDB 事务内一起写入，事务提交后才广播。
 * generation 记录“当前持锁控制页”的代次：只有代次 == 该代次、身份一致的
 * 页面可解除；旧代次页面与迟到消息均不能解除或覆盖。锁定本身跨代次存活，
 * 新控制者接管后记录原样保留（仅帧的控制者 / 代次随接管更新）。
 */
export interface BlackoutLock {
  /** 写入本次锁定（最近一次确认）的控制者代次，作为解除资格栅栏。 */
  generation: number;
  /** 写入本次锁定的控制者身份。 */
  controllerId: string;
  /** 控制者人类可读标签（UI 辨认用）。 */
  controllerLabel: string;
  /** 锁定确认写入的时间戳。 */
  lockedAt: number;
}

/**
 * 待交接记录（“指定并交权”）。
 * 当前操控者把它确认写入 IndexedDB 后才释放 Web Lock：
 * 之后任何拿到底层锁的页面都先按此持久记录裁决资格。
 */
export interface HandoffRecord {
  /** 发起交接时在任控制者的代次（来源代次）。 */
  generation: number;
  /** 本次交接的唯一版本（随机 token）；消费时必须严格相等，防重复 / 重放。 */
  version: string;
  /** 发起交接的控制者身份。 */
  sourceId: string;
  /** 被指定接权的控制页身份。 */
  targetId: string;
  /** 授权有效期截止时间戳；过期后记录作废，排队页重新参与普通接管。 */
  expiresAt: number;
}

/** BroadcastChannel 消息种类。 */
export type WireMessage =
  | {
      type: 'frame';
      /** 与 FrameState 同构，避免接收端再查库；库内记录是最终依据。 */
      frame: FrameState;
    }
  | {
      type: 'controller';
      /** 当前持锁控制者信息，随心跳广播；null 表示控制者已退场。 */
      controller: (ControllerInfo & { generation: number }) | null;
      /** 退场消息携带本页代次，旧代次的退场不得清掉新代次控制者。 */
      generation?: number;
    }
  | {
      /** 排队控制页声明在线（附带页面稳定身份），供在任控制者选择交权目标。 */
      type: 'presence';
      controller: ControllerInfo;
      /** 发送方已知的最新控制者代次；迟到的旧在线消息不得影响后续代次。 */
      knownGen: number;
    }
  | {
      /** 在任控制者请求排队页立即重新声明在线。 */
      type: 'presence-request';
      generation: number;
    }
  | {
      /** “指定并交权”通知：纯 UI 提示，资格裁决以持久交接记录为准。 */
      type: 'handoff-designate';
      handoff: HandoffRecord;
    }
  | {
      /**
       * 编辑页重新采用节目单：通知已打开的控制页丢弃打开时缓存的旧条目，
       * 改以 IndexedDB 中最新冻结版本为准。冻结时间戳即新版本标识。
       */
      type: 'program-adopted';
      frozenAt: number;
    }
  | {
      /**
       * 紧急黑场锁定状态变更：纯 UI 同步，资格裁决以持久锁定记录为准。
       * lock=null 表示已显式解除；携带发起方代次，旧代次的迟到消息
       * （哪怕声称解除）一律丢弃，不能覆盖更新代次仍有效的锁定。
       */
      type: 'blackout-lock';
      lock: BlackoutLock | null;
      generation: number;
    };

/** 能力探测结果：任一必需能力缺失时允许编辑但禁止开演。 */
export interface CapabilityReport {
  indexedDB: boolean;
  webLocks: boolean;
  broadcastChannel: boolean;
  structuredClone: boolean;
  missing: string[];
}
