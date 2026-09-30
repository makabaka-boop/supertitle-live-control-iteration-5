// 纯函数：投影页的代次栅栏、消息判定，以及画面与最新冻结节目的一致性
// 裁决，便于单元测试。

import type { FrameContent, FrameState, FrozenProgram, HandoffRecord } from '../types';

/**
 * 只接受更高代次，或同代次更大序号。
 * 同帧重放（相等）幂等忽略；旧代次 / 同代次旧序号一律丢弃，
 * 这样失锁旧页的迟到消息永远无法覆盖新代次确认的画面。
 */
export function isNewerFrame(
  current: FrameState | null,
  incoming: FrameState,
): boolean {
  if (!current) return true;
  if (incoming.generation !== current.generation) {
    return incoming.generation > current.generation;
  }
  return incoming.sequence > current.sequence;
}

/** 控制者广播的比较规则：新代次覆盖；同代次刷新心跳；旧代次忽略。 */
export function isControllerAtLeast(
  currentGen: number | null,
  incomingGen: number,
): boolean {
  if (currentGen === null) return true;
  return incomingGen >= currentGen;
}

/** 旧代次的“控制者退场(null)”消息不能清除新代次控制者。 */
export function shouldClearController(
  currentGen: number | null,
  nullGen: number,
): boolean {
  if (currentGen === null) return false;
  return nullGen >= currentGen;
}

export type HandoffDecision =
  | { kind: 'none' }
  | { kind: 'expired' }
  | { kind: 'consume'; handoff: HandoffRecord }
  | { kind: 'yield'; handoff: HandoffRecord };

/**
 * 取得底层锁后按持久交接记录裁决资格：
 *  - none：没有交接记录（含旧库无记录）→ 普通竞争接管，开新一代；
 *  - expired：授权已过有效期 → 重新参与普通接管（记录由接管事务清掉）；
 *  - consume：有效期内且目标与版本都匹配本页 → 消费授权、开下一代；
 *  - yield：有效期内但目标是别的页 → 不改代次地让锁并继续排队。
 * 调用方应直接把持久记录与自身状态传入，避免 TOCTOU；事务内仍会再核对一次。
 */
export function adjudicateHandoff(
  handoff: HandoffRecord | null,
  self: { id: string; version?: string },
  now: number,
): HandoffDecision {
  if (!handoff) return { kind: 'none' };
  if (handoff.expiresAt <= now) return { kind: 'expired' };
  if (
    handoff.targetId === self.id &&
    (self.version === undefined || handoff.version === self.version)
  ) {
    return { kind: 'consume', handoff };
  }
  return { kind: 'yield', handoff };
}

/**
 * 排队页是否接受一条“在线声明 / 交权通知”。
 * 迟到的旧在线 / 旧交接消息不能影响后续代次：
 * 只接受不早于已知代次的消息（knownGen 为 0 表示刚开页，接受任何消息）。
 */
export function isMessageForCurrentGeneration(
  knownGen: number,
  messageGen: number,
): boolean {
  return knownGen === 0 || messageGen >= knownGen;
}

const BLACKOUT_CONTENT: FrameContent = {
  kind: 'blackout',
  cueId: null,
  source: '',
  translation: '',
};

/** 构造显式黑场画面（全黑、不携带任何 cue）。 */
export function blackoutContent(): FrameContent {
  return { ...BLACKOUT_CONTENT };
}

/**
 * 是否为“不带任何 cue 的显式黑场”（普通黑场按钮产生的单帧黑场）。
 * 紧急黑场锁定期间只允许再发布这种画面：它不改变当前 cue、也不设置锁定；
 * 切句（字幕、指向具体黑场条目的画面）一律拒绝。
 */
export function isExplicitBlackout(content: FrameContent): boolean {
  return content.kind === 'blackout' && content.cueId === null;
}

/**
 * 判定一幅画面是否与最新冻结节目单中的某个条目逐字段一致。
 *  - 显式黑场（cueId=null）永远有效，不依赖任何条目；
 *  - 字幕画面要求条目仍存在、文案与冻结快照逐字一致（仅 cueId 相同不算，
 *    条目被改写后旧文案不得再发布）；
 *  - 黑场条目要求条目仍存在（被删除的黑场 cue 不得再被点出）。
 */
export function isContentInFrozenProgram(
  content: FrameContent,
  frozen: FrozenProgram | null,
): boolean {
  if (content.kind === 'blackout') {
    if (content.cueId === null) return true;
    return !!frozen?.cues.some((c) => c.id === content.cueId);
  }
  const cue = frozen?.cues.find((c) => c.id === content.cueId);
  return (
    !!cue &&
    cue.kind === 'subtitle' &&
    cue.source === content.source &&
    cue.translation === content.translation
  );
}

/**
 * 普通接管 / 指定接权时为新代次选择初始画面：
 * 仍存在于最新冻结节目、且未被改写的最后确认画面继续沿用（不闪黑）；
 * 已被删除或文案已修改的画面以黑场进入新代次，绝不把旧内容投给观众。
 * 被删除的黑场条目同样归一为不带 cueId 的显式黑场。
 */
export function seedContentForProgram(
  previous: FrameContent | null,
  frozen: FrozenProgram | null,
): FrameContent {
  if (previous && isContentInFrozenProgram(previous, frozen)) {
    return previous;
  }
  return blackoutContent();
}
