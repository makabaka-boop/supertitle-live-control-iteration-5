// 跨页面会话：BroadcastChannel 实时分发 + IndexedDB 持久真相。
// 所有“画面”一律先在事务中确认入库，提交成功后才广播；
// 接收端按代次栅栏 (isNewerFrame) 判定，迟到旧消息无法覆盖新画面。
//
// “指定并交权”：在任控制者先把带来源代次 / 唯一版本 / 目标身份 / 五秒
// 期限的待交接记录确认落盘，再释放 Web Lock。任何取得底层锁的页面都先
// 按该持久记录裁决资格：只有有效期内、目标与版本都匹配的页面才能消费
// 授权并开启下一代；其他排队页不改代次地让锁继续排队；授权失效后回到
// 普通接管。

import type {
  BlackoutLock,
  FrameContent,
  FrameState,
  HandoffRecord,
  UndoFrameEligibility,
  WireMessage,
} from '../types';
import {
  adjudicateHandoff,
  isControllerAtLeast,
  isMessageForCurrentGeneration,
  isNewerFrame,
  shouldClearController,
} from './protocol';
import { StageLock } from './locks';
import {
  BlackoutLockedError,
  consumeHandoff as dbConsumeHandoff,
  CueNotInFrozenProgramError,
  engageBlackoutLock as dbEngageBlackoutLock,
  HandoffExpiredError,
  HandoffTargetMismatchError,
  HandoffVersionMismatchError,
  loadBlackoutLock,
  loadFrame,
  loadHandoff,
  loadUndoFrame,
  publishFrame as dbPublishFrame,
  releaseBlackoutLock as dbReleaseBlackoutLock,
  saveHandoff,
  startPerformance,
  undoPreviousFrame as dbUndoPreviousFrame,
  UndoNotAvailableError,
  UndoTargetMismatchError,
} from './db';

export const CHANNEL_NAME = 'opera-stage-bus';
const HEARTBEAT_MS = 1000;
/** 候选超过此时长没有重新声明在线即视为离线（交接期限 5 秒内的余量）。 */
const CANDIDATE_TTL_MS = 3500;
/** 非目标让锁后重新排队的回退间隔上限（授权最长五秒，略大于其到期时刻）。 */
const YIELD_MAX_DELAY_MS = 5200;
const CLOCK_SKEW_MS = 100;

export interface ActiveController {
  controllerId: string;
  label: string;
  generation: number;
}

/** 在线的排队控制页（开演页在页面生命周期内身份稳定）。 */
export interface CandidateInfo {
  controllerId: string;
  label: string;
  lastSeen: number;
}

/** 本页被指定接权时的提示（来源代次 + 唯一版本）。 */
export interface DesignationNotice {
  generation: number;
  version: string;
  expiresAt: number;
}

export type ViewerStatus =
  | { role: 'viewer'; controller: ActiveController | null }
  | { role: 'waiting'; controller: ActiveController | null }
  | {
      role: 'leader';
      generation: number;
      controllerId: string;
      label: string;
    }
  | { role: 'lost'; generation: number };

export interface SessionSnapshot {
  status: ViewerStatus;
  frame: FrameState | null;
  /** 当前 leader 在本代次可消费一次的“撤销上一帧”资格；其他状态均为 null。 */
  undo: UndoFrameEligibility | null;
  error: string | null;
  /** 仅 leader 有意义：在线可交权的排队候选。 */
  candidates: CandidateInfo[];
  /** 仅被指定的等待页有意义：UI 提示“已被指定，等待接权”。 */
  designation: DesignationNotice | null;
  /** 等待页知悉一场交接正在进行（来源代次；0=无），用于提示与清理。 */
  handoffGen: number;
  /**
   * 本页已知最新冻结节目的冻结时刻（重新采用通知）。已打开的控制页据此
   * 丢弃打开时缓存的旧条目，重新从 IndexedDB 加载最新冻结版本；null=尚未收到。
   */
  programVersion: number | null;
  /**
   * 当前紧急黑场锁定状态（持久真相为准；存在=锁定中）。锁定跨普通接管、
   * 指定交权与重新采用持续存在，只有当前持锁且代次匹配的控制页可解除。
   * 投影页不使用本字段（只按帧显示）。
   */
  blackoutLock: BlackoutLock | null;
}

type Listener = (snapshot: SessionSnapshot) => void;

export interface ControllerIdentity {
  id: string;
  label: string;
}

function randomId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `c-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 生成新的控制者身份（每次打开控制页）。 */
export function createIdentity(label: string): ControllerIdentity {
  return { id: randomId(), label };
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

type BusFactory = () => BroadcastChannel;
const defaultBusFactory: BusFactory = () =>
  new BroadcastChannel(CHANNEL_NAME);

/**
 * 编辑页“采用节目单”成功后通知所有已打开的控制页：以冻结时刻作为新版本
 * 标识。控制页据此重新加载 IndexedDB 中的最新冻结快照；投影页无需理会
 * （它只按代次 / 序号显示已确认画面）。一次性总线，发完即关。
 */
export function announceProgramAdoption(frozenAt: number): void {
  const bus = defaultBusFactory();
  try {
    bus.postMessage({ type: 'program-adopted', frozenAt } satisfies WireMessage);
  } finally {
    bus.close();
  }
}

export abstract class BaseSession {
  protected snapshot: SessionSnapshot = {
    status: { role: 'viewer', controller: null },
    frame: null,
    undo: null,
    error: null,
    candidates: [],
    designation: null,
    handoffGen: 0,
    programVersion: null,
    blackoutLock: null,
  };
  protected bus: BroadcastChannel | null;
  private listeners = new Set<Listener>();

  constructor(busFactory: BusFactory) {
    this.bus = busFactory();
    this.bus.onmessage = (ev: MessageEvent<WireMessage>) =>
      this.onWire(ev.data);
    this.bus.onmessageerror = () =>
      this.emit({ error: '收到无法反序列化的消息，已忽略' });
  }

  protected emit(patch: Partial<SessionSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const l of this.listeners) l(this.snapshot);
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.snapshot);
    return () => {
      this.listeners.delete(fn);
    };
  }

  get current(): SessionSnapshot {
    return this.snapshot;
  }

  protected send(msg: WireMessage): void {
    // postMessage 失败不影响已确认的持久状态，仅报错。
    try {
      this.bus?.postMessage(msg);
    } catch (err) {
      this.emit({
        error: `画面广播失败（持久状态已保存，投影重开仍会读到）：${describe(err)}`,
      });
    }
  }

  protected abstract onWire(msg: WireMessage): void;

  /**
   * 从 IndexedDB 读取上一幅已确认画面（页面打开 / 重开时）。
   * 控制页同时读取紧急黑场锁定：刷新后锁定与黑场帧必须同时还原，
   * 绝不出现“画面黑了但锁定丢失”。
   */
  async hydrateFrame(): Promise<void> {
    try {
      const [frame, lock, undo] = await Promise.all([
        loadFrame(),
        loadBlackoutLock(),
        loadUndoFrame(),
      ]);
      const patch: Partial<SessionSnapshot> = {};
      if (frame && isNewerFrame(this.snapshot.frame, frame)) {
        patch.frame = frame;
      }
      // 持久真相为准：无论本页此前看到什么，锁定状态以库内记录为准。
      patch.blackoutLock = lock;
      patch.undo = undo;
      this.emit(patch);
    } catch (err) {
      this.emit({ error: `读取已确认画面失败：${describe(err)}` });
    }
  }

  dispose(): void {
    this.bus?.close();
    this.bus = null;
  }
}

/**
 * 投影 / 观众会话：只读。
 * 进入时以持久状态为准；之后只接受代次更高、或同代次序号更大的帧。
 */
export class ViewerSession extends BaseSession {
  constructor(busFactory: BusFactory = defaultBusFactory) {
    super(busFactory);
  }

  /** 重开 / 首次进入：以持久状态为最终真相，无条件采用已确认画面。 */
  async hydrateFromStorage(): Promise<void> {
    await this.hydrateFrame();
  }

  protected onWire(msg: WireMessage): void {
    if (msg.type === 'frame') {
      // 代次栅栏：更高代次 或 同代次更大序号才接受。
      if (isNewerFrame(this.snapshot.frame, msg.frame)) {
        this.emit({ frame: msg.frame });
      }
      return;
    }
    // presence / presence-request / handoff-designate / blackout-lock 与投影无关：
    // 投影只认已确认帧的代次 / 序号栅栏。
    if (msg.type !== 'controller') return;

    const status = this.snapshot.status;
    if (status.role !== 'viewer' && status.role !== 'waiting') return;

    if (msg.controller === null) {
      const currentGen = status.controller?.generation ?? null;
      const nullGen = msg.generation;
      // 旧代次的退场消息不能清掉新代次控制者。
      if (nullGen === undefined || shouldClearController(currentGen, nullGen)) {
        this.emit({ status: { role: status.role, controller: null } });
      }
      return;
    }

    if (
      !status.controller ||
      isControllerAtLeast(status.controller.generation, msg.controller.generation)
    ) {
      this.emit({
        status: { role: status.role, controller: msg.controller },
      });
    }
  }
}

/**
 * 控制会话：竞争唯一锁。
 * 获锁后先按持久交接记录裁决：
 *  - 被指定目标（版本一致、未过期）：同一事务消费授权 + 开下一代 + 沿用画面；
 *  - 有效期内的非目标 / 版本不符：不改代次地让锁，稍后重排队；
 *  - 无记录 / 已过期：普通竞争接管，开新一代。
 * 授权消费、新代次与沿用画面在同一事务一次确认；失败三者都不变并重试。
 */
export class ControllerSession extends BaseSession {
  private lock: StageLock;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private candidateTimer: ReturnType<typeof setInterval> | null = null;
  private identity: ControllerIdentity;
  private generation = 0;
  /** 本页已知的最新控制者代次（用于过滤迟到的旧消息）。 */
  private knownGen = 0;
  private candidateMap = new Map<string, CandidateInfo>();

  constructor(
    identity: ControllerIdentity,
    busFactory: BusFactory = defaultBusFactory,
  ) {
    super(busFactory);
    this.identity = identity;
    this.emit({ status: { role: 'waiting', controller: null } });

    this.lock = new StageLock({
      granted: () => void this.onGranted(),
      lost: () => this.onLost(),
    });
  }

  get controllerId(): string {
    return this.identity.id;
  }

  get controllerLabel(): string {
    return this.identity.label;
  }

  /** 进入竞争队列；已有持锁者时持续排队（期间声明在线）。 */
  async enterContention(): Promise<void> {
    this.startPresence();
    await this.lock.acquire();
  }

  private startPresence(): void {
    this.announcePresence();
    // 若已有控制者，它会回 presence-request；本页随即再声明一次，
    // 保证“开页晚于在任控制者”时也能立刻进入候选表。
    this.send({ type: 'presence-request', generation: this.knownGen });
    this.heartbeat = setInterval(() => {
      if (this.lock.isLeader) {
        this.announceController();
      } else {
        this.announcePresence();
      }
    }, HEARTBEAT_MS);
  }

  /** 排队页向在任控制者声明在线（携带已知代次，旧消息会被丢弃）。 */
  private announcePresence(): void {
    if (this.lock.isLeader) return;
    this.send({
      type: 'presence',
      controller: {
        controllerId: this.identity.id,
        label: this.identity.label,
      },
      knownGen: this.knownGen,
    });
  }

  private async onGranted(): Promise<void> {
    // 接管 / 接权时都把上一代最后一幅已确认画面作为新代次起点，不闪黑。
    let seed: FrameState | null = null;
    try {
      seed = await loadFrame();
    } catch {
      seed = null;
    }

    let handoff: HandoffRecord | null = null;
    try {
      handoff = await loadHandoff();
    } catch (err) {
      // 裁决依据读不到：稍后重试，绝不在无依据时直接开代。
      this.emit({ error: `读取交接记录失败，稍后重试：${describe(err)}` });
      await this.lock.yieldAndRequeue(500);
      return;
    }

    const now = Date.now();
    const decision = adjudicateHandoff(
      handoff,
      { id: this.identity.id, version: this.snapshot.designation?.version },
      now,
    );

    if (decision.kind === 'yield') {
      // 有效期内但不是本页（或版本不符）：不改代次地让锁继续排队。
      // 等到授权到期稍后（或被 wakeYield 提前唤醒）再裁决，目标在此期间可直接获锁。
      const delay = Math.min(
        YIELD_MAX_DELAY_MS,
        Math.max(0, decision.handoff.expiresAt - now) + CLOCK_SKEW_MS,
      );
      await this.lock.yieldAndRequeue(delay);
      return;
    }

    try {
      const result =
        decision.kind === 'consume'
          ? await dbConsumeHandoff({
              controller: { id: this.identity.id, label: this.identity.label },
              version: decision.handoff.version,
              initialContent: seed?.content,
            })
          : await startPerformance(this.identity, {
              initialContent: seed?.content,
            });
      this.activateAsLeader(
        result.generation,
        result.frame,
        result.blackoutLock,
      );
    } catch (err) {
      if (err instanceof HandoffTargetMismatchError || err instanceof HandoffVersionMismatchError) {
        // 持久状态在裁决后被更新（极小竞态）：当作非目标让锁重试。
        await this.lock.yieldAndRequeue(500);
        return;
      }
      if (err instanceof HandoffExpiredError) {
        // 裁决后授权恰好过期：立刻重排，下一轮走普通接管。
        await this.lock.yieldAndRequeue(0);
        return;
      }
      // 其他事务失败（含写盘错误）：授权 / 代次 / 画面都未变，提示并重试。
      this.emit({ error: `接管失败，已保留上一幅画面并重试：${describe(err)}` });
      await this.lock.yieldAndRequeue(500);
    }
  }

  /**
   * 事务提交成功后的统一切换：本地状态、广播、心跳与候选表一次到位。
   * blackoutLock 为接管事务读回的持久锁定：锁定跨代次存活，新控制者
   * 一上任就处于锁定中，必须显式解除后才能发布 cue。
   */
  private activateAsLeader(
    generation: number,
    frame: FrameState,
    blackoutLock: BlackoutLock | null,
  ): void {
    this.generation = generation;
    this.knownGen = generation;
    this.candidateMap.clear();

    // 持久真相先成立，再对外发布。
    this.emit({
      frame,
      undo: null,
      error: null,
      designation: null,
      handoffGen: 0,
      blackoutLock,
      candidates: [],
      status: {
        role: 'leader',
        generation,
        controllerId: this.identity.id,
        label: this.identity.label,
      },
    });
    this.send({ type: 'frame', frame });
    // 同步锁定状态（接管后仍锁定时排队页 / 投影端 UI 据此显示）；
    // 真正的放行闸门在持久层，消息只是 UI 同步。
    this.send({ type: 'blackout-lock', lock: blackoutLock, generation });
    this.announceController();

    // 请所有排队页立刻声明在线，加速候选表成形。
    this.send({ type: 'presence-request', generation });

    // 周期清理离线候选（页面关闭后不再发 presence）。
    if (this.candidateTimer) clearInterval(this.candidateTimer);
    this.candidateTimer = setInterval(() => this.pruneCandidates(), 1000);
  }

  private pruneCandidates(): void {
    if (!this.lock.isLeader) return;
    const cutoff = Date.now() - CANDIDATE_TTL_MS;
    let changed = false;
    for (const [id, cand] of this.candidateMap) {
      if (cand.lastSeen < cutoff) {
        this.candidateMap.delete(id);
        changed = true;
      }
    }
    if (changed) this.emit({ candidates: this.candidateList() });
  }

  private candidateList(): CandidateInfo[] {
    return [...this.candidateMap.values()].sort((a, b) =>
      a.lastSeen === b.lastSeen
        ? a.controllerId.localeCompare(b.controllerId)
        : a.lastSeen - b.lastSeen,
    );
  }

  private onLost(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    if (this.candidateTimer) {
      clearInterval(this.candidateTimer);
      this.candidateTimer = null;
    }
    this.candidateMap.clear();
    // 立即禁用：状态切 lost，UI 所有操控按钮失效。
    const lostGen = this.generation;
    this.generation = 0;
    this.emit({
      status: { role: 'lost', generation: lostGen },
      undo: null,
      candidates: [],
      designation: null,
      handoffGen: 0,
    });
    // 携带本页代次退场：旧代次的退场不会清掉更新代次的新控制者。
    this.send({
      type: 'controller',
      controller: null,
      generation: lostGen,
    });
  }

  /**
   * 切句 / 黑场：同一事务核对控制者与代次、递增序号并保存画面，
   * 提交成功后才经 BroadcastChannel 发布。
   * 失败时库内仍是上一幅确认画面，错误上抛给 UI 显示。
   */
  async publish(content: FrameContent): Promise<FrameState> {
    if (!this.lock.isLeader || this.generation === 0) {
      throw new Error('本页已失去控制权，不能操控画面');
    }
    const result = await dbPublishFrame({
      controllerId: this.identity.id,
      generation: this.generation,
      content,
    });
    // 到此处帧与撤销资格已在同一事务提交；先更新本地，再广播。
    this.emit({ frame: result.frame, undo: result.undo, error: null });
    this.send({ type: 'frame', frame: result.frame });
    return result.frame;
  }

  /**
   * 撤销刚才那次普通发布：数据库把前一帧内容以更大序号重新发布，并在同事务
   * 清除资格。投影端因此只会看到新序号，不会把它当成迟到的旧画面。
   * 写入失败时资格、控制台、持久帧与投影均保持不变，可由当前控制者重试。
   */
  async undoPreviousFrame(): Promise<FrameState> {
    if (!this.lock.isLeader || this.generation === 0) {
      throw new Error('本页已失去控制权，不能撤销画面');
    }
    const eligibility = this.snapshot.undo;
    const current = this.snapshot.frame;
    if (
      !eligibility ||
      eligibility.generation !== this.generation ||
      eligibility.controllerId !== this.identity.id ||
      !current ||
      current.generation !== eligibility.publishedFrame.generation ||
      current.sequence !== eligibility.publishedFrame.sequence
    ) {
      throw new Error('没有可撤销的上一帧（资格不存在、已消费或已失效）');
    }
    let result;
    try {
      result = await dbUndoPreviousFrame({
        controllerId: this.identity.id,
        generation: this.generation,
      });
    } catch (err) {
      // 资格已被持久层确认失效（重新采用 / 接管 / 紧急锁定 / 已消费 / 目标帧
      // 已变化）时同步清掉本页资格；写盘故障则保留资格与当前帧以便重试。
      if (
        err instanceof UndoNotAvailableError ||
        err instanceof UndoTargetMismatchError ||
        err instanceof CueNotInFrozenProgramError ||
        err instanceof BlackoutLockedError
      ) {
        this.emit({ undo: null });
      }
      throw err;
    }
    this.emit({ frame: result.frame, undo: null, error: null });
    this.send({ type: 'frame', frame: result.frame });
    return result.frame;
  }

  /**
   * 紧急黑场锁定：只有当前持锁且代次匹配的本页可调用。锁定记录与
   * 已确认黑场帧在**同一笔 IndexedDB 事务**内写入，提交成功后才广播。
   * 写入失败时数据库、控制台与投影都保留上一个确认状态（不黑、不锁）。
   */
  async engageEmergencyBlackout(
    now: number = Date.now(),
  ): Promise<{ lock: BlackoutLock; frame: FrameState }> {
    if (!this.lock.isLeader || this.generation === 0) {
      throw new Error('本页已失去控制权，不能设置紧急黑场锁定');
    }
    const result = await dbEngageBlackoutLock({
      controllerId: this.identity.id,
      controllerLabel: this.identity.label,
      generation: this.generation,
      now,
    });
    // 事务已提交：先本地确认，再广播帧与锁定状态。
    this.emit({
      frame: result.frame,
      undo: null,
      blackoutLock: result.lock,
      error: null,
    });
    this.send({ type: 'frame', frame: result.frame });
    this.send({
      type: 'blackout-lock',
      lock: result.lock,
      generation: this.generation,
    });
    return result;
  }

  /**
   * 显式解除紧急黑场锁定。必须仍是当前持锁且代次匹配的控制页；
   * 旧代次页面（含被接管的旧主控）在事务内即被拒。解除只删除锁定记录、
   * 不改变画面：舞台保持黑场，直到主控主动发布最新冻结节目中的 cue。
   */
  async releaseEmergencyBlackout(): Promise<BlackoutLock | null> {
    if (!this.lock.isLeader || this.generation === 0) {
      throw new Error('本页已失去控制权，不能解除紧急黑场锁定');
    }
    const { lock } = await dbReleaseBlackoutLock({
      controllerId: this.identity.id,
      generation: this.generation,
    });
    if (lock) {
      // 确有锁定被解除：本地先更新，再广播。
      this.emit({ blackoutLock: null, error: null });
      this.send({
        type: 'blackout-lock',
        lock: null,
        generation: this.generation,
      });
    }
    return lock;
  }

  /**
   * 指定并交权：待交接记录（来源代次、唯一版本、目标身份、五秒期限）
   * 确认保存后才释放 Web Lock；保存失败则本页继续持锁并抛出错误。
   */
  async designate(
    targetId: string,
    ttlMs = 5000,
    now: number = Date.now(),
  ): Promise<HandoffRecord> {
    if (!this.lock.isLeader || this.generation === 0) {
      throw new Error('本页不是当前操控者，不能指定交权');
    }
    if (!this.candidateMap.has(targetId)) {
      throw new Error('目标控制页不在在线候选中，不能交权');
    }
    const record: HandoffRecord = {
      generation: this.generation,
      version: randomId(),
      sourceId: this.identity.id,
      targetId,
      expiresAt: now + ttlMs,
    };
    // 先持久化确认，后释放锁：记录没保存成功就绝不交权。
    await saveHandoff(record);
    // 通知（尽力）：目标页 UI 提示；真正的资格以持久记录为准。
    this.send({ type: 'handoff-designate', handoff: record });
    await this.lock.releaseLock();
    return record;
  }

  /** 主动交权给普通排队者（“退场交权”按钮或页面卸载，不写交接记录）。 */
  async standDown(): Promise<void> {
    await this.lock.releaseLock();
  }

  isLeader(): boolean {
    return this.lock.isLeader;
  }

  private announceController(): void {
    if (!this.lock.isLeader || this.generation === 0) return;
    this.send({
      type: 'controller',
      controller: {
        controllerId: this.identity.id,
        label: this.identity.label,
        generation: this.generation,
      },
    });
  }

  protected onWire(msg: WireMessage): void {
    if (msg.type === 'frame') {
      // 等待接管期间也显示当前画面，并据此记住最新代次（过滤迟到旧消息）。
      if (isNewerFrame(this.snapshot.frame, msg.frame)) {
        this.knownGen = Math.max(this.knownGen, msg.frame.generation);
        this.emit({ frame: msg.frame });
      }
      return;
    }

    if (msg.type === 'program-adopted') {
      // 重新采用成功：通知 UI 重新加载最新冻结条目（含持锁页与排队页）。
      // 单调更新，迟到的旧通知不回退版本。
      const prev = this.snapshot.programVersion;
      if (prev === null || msg.frozenAt >= prev) {
        // 重新采用在同一事务内清掉了撤销资格；内存资格也必须立即失效。
        this.emit({ programVersion: msg.frozenAt, undo: null });
      }
      return;
    }

    if (msg.type === 'blackout-lock') {
      // 持锁者的锁定状态以自身事务结果为准，不听命于任何消息。
      if (this.lock.isLeader) return;
      // 代次栅栏：旧代次的迟到消息（哪怕声称“已解除”）不能解除 / 覆盖
      // 更新代次仍有效的锁定；也不能让刚接管的新一代凭空出现锁定。
      const fenceGen = Math.max(this.knownGen, this.generation);
      if (!isMessageForCurrentGeneration(fenceGen, msg.generation)) return;
      this.knownGen = Math.max(this.knownGen, msg.generation);
      this.emit({ blackoutLock: msg.lock });
      return;
    }

    if (msg.type === 'controller') {
      if (msg.controller) {
        this.knownGen = Math.max(this.knownGen, msg.controller.generation);
        // 出现严格更新的代次：交接已落定（或发生了新接管），清掉交权提示，
        // 并把正在让锁等待中的本页提前唤醒重新排队（目标关闭场景的快速接管）。
        const handoffGen = this.snapshot.handoffGen;
        if (handoffGen > 0 && msg.controller.generation > handoffGen) {
          this.emit({ designation: null, handoffGen: 0 });
        }
        if (!this.lock.isLeader) {
          this.lock.wakeYield();
        }
        if (this.snapshot.status.role === 'waiting') {
          this.emit({
            status: { role: 'waiting', controller: msg.controller },
          });
        }
      }
      return;
    }

    if (msg.type === 'presence') {
      if (!this.lock.isLeader || this.generation === 0) return;
      // 迟到的旧在线声明不能影响后续代次。
      if (!isMessageForCurrentGeneration(this.generation, msg.knownGen)) return;
      const id = msg.controller.controllerId;
      this.candidateMap.set(id, {
        controllerId: id,
        label: msg.controller.label,
        lastSeen: Date.now(),
      });
      this.emit({ candidates: this.candidateList() });
      return;
    }

    if (msg.type === 'presence-request') {
      if (this.lock.isLeader) {
        // 排队页点名找控制者：重新广播一次点名，让晚开的页面立即声明在线。
        if (this.generation !== 0) {
          this.send({ type: 'presence-request', generation: this.generation });
        }
        return;
      }
      // 排队页收到在任控制者点名：立即重新声明（旧代次的点名忽略）。
      if (this.knownGen !== 0 && msg.generation < this.knownGen) return;
      this.knownGen = Math.max(this.knownGen, msg.generation);
      this.announcePresence();
      return;
    }

    if (msg.type === 'handoff-designate') {
      const h = msg.handoff;
      // 迟到的旧交接通知不能影响后续代次。
      if (
        !isMessageForCurrentGeneration(
          Math.max(this.knownGen, this.generation),
          h.generation,
        )
      ) {
        return;
      }
      if (this.lock.isLeader) return;
      this.knownGen = Math.max(this.knownGen, h.generation);
      if (h.targetId === this.identity.id) {
        this.emit({
          designation: {
            generation: h.generation,
            version: h.version,
            expiresAt: h.expiresAt,
          },
          handoffGen: h.generation,
        });
      } else {
        // 其他排队页也显示“交权进行中”，不改自身排队资格。
        this.emit({ handoffGen: h.generation });
      }
      return;
    }
  }

  dispose(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.candidateTimer) clearInterval(this.candidateTimer);
    super.dispose();
    void this.lock.releaseLock();
  }
}
