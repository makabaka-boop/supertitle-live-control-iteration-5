import { useEffect, useMemo, useRef, useState } from 'react';
import type { CapabilityReport, Cue, FrameContent, FrameState } from '../types';
import {
  ControllerSession,
  createIdentity,
} from '../lib/sessions';
import { useSession } from '../lib/useSessionSnapshot';
import { loadPersisted } from '../lib/db';
import { StageView } from '../components/StageView';

interface ControlPageProps {
  capabilities: CapabilityReport;
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

export function ControlPage({ capabilities }: ControlPageProps) {
  // 整个页面生命周期只创建一个控制会话（稳定身份、锁、通道绑定）。
  const session = useMemo(() => {
    const identity = createIdentity('主控台');
    return new ControllerSession(identity);
  }, []);
  const snapshot = useSession(session);

  const [frozenCues, setFrozenCues] = useState<Cue[] | null>(null);
  const [frozenAt, setFrozenAt] = useState<number | null>(null);
  const [frozenDraftRev, setFrozenDraftRev] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [handoffError, setHandoffError] = useState<string | null>(null);
  const [handoffPending, setHandoffPending] = useState(false);
  const [lockError, setLockError] = useState<string | null>(null);
  const [lockPending, setLockPending] = useState(false);

  // 打开即读取冻结版本；能力齐全才进入唯一锁竞争，缺项时只做静态展示。
  const banned = capabilities.missing.length > 0;
  const programVersion = snapshot.programVersion;

  useEffect(() => {
    let disposed = false;
    void loadPersisted()
      .then(({ frozen }) => {
        if (disposed) return;
        setFrozenCues(frozen?.cues ?? null);
        setFrozenAt(frozen?.frozenAt ?? null);
        setFrozenDraftRev(frozen?.draftRev ?? null);
        setLoadError(null);
      })
      .catch((err: unknown) => {
        if (!disposed) {
          setLoadError(
            `读取在演版本失败：${err instanceof Error ? err.message : String(err)}`,
          );
        }
      });
    if (banned) {
      setLoadError('缺少演出所需能力，已禁止开演。');
      return () => {
        disposed = true;
      };
    }
    void session.hydrateFrame();
    void session.enterContention();

    const onUnload = () => void session.standDown();
    window.addEventListener('pagehide', onUnload);
    return () => {
      disposed = true;
      window.removeEventListener('pagehide', onUnload);
      void session.dispose();
    };
  }, [session, banned]);

  // 编辑页重新采用成功：无论本页持锁还是排队，都丢弃打开时缓存的旧条目，
  // 改以库中最新冻结版本为准（首帧 null 是初始值，不是通知，跳过）。
  const reloadVersion = useRef<number | null>(null);
  useEffect(() => {
    if (programVersion === null || reloadVersion.current === programVersion) {
      return;
    }
    reloadVersion.current = programVersion;
    let disposed = false;
    void loadPersisted()
      .then(({ frozen }) => {
        if (disposed) return;
        setFrozenCues(frozen?.cues ?? null);
        setFrozenAt(frozen?.frozenAt ?? null);
        setFrozenDraftRev(frozen?.draftRev ?? null);
        setLoadError(null);
      })
      .catch((err: unknown) => {
        if (!disposed) {
          setLoadError(
            `重新加载在演版本失败：${err instanceof Error ? err.message : String(err)}`,
          );
        }
      });
    return () => {
      disposed = true;
    };
  }, [programVersion]);

  const isLeader = snapshot.status.role === 'leader';
  const isWaiting = snapshot.status.role === 'waiting';
  const isLost = snapshot.status.role === 'lost';
  // 紧急黑场锁定：跨接管 / 交权 / 重新采用存活，以持久记录（经会话同步）为准。
  const isLocked = snapshot.blackoutLock !== null;
  const lostGeneration =
    snapshot.status.role === 'lost' ? snapshot.status.generation : 0;
  const waitingController =
    snapshot.status.role === 'waiting' ? snapshot.status.controller : null;
  const activeIndex = useMemo(() => {
    const id = snapshot.frame?.content.cueId;
    if (!id || !frozenCues) return -1;
    return frozenCues.findIndex((c) => c.id === id);
  }, [snapshot.frame, frozenCues]);

  async function send(content: FrameContent) {
    setActionError(null);
    try {
      await session.publish(content);
    } catch (err) {
      // 事务失败（含失锁、代次过期、控制者不符）：画面未变，报错。
      setActionError(
        err instanceof Error ? err.message : `操控失败：${String(err)}`,
      );
    }
  }

  // 一次撤销上一帧：前一帧内容以更高序号重新发布（不是回退序号），
  // 投影端按序号栅栏当新画面接受；资格一次性，事务失败画面不变。
  async function undo() {
    setActionError(null);
    try {
      await session.undoLastFrame();
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : `撤销失败：${String(err)}`,
      );
    }
  }

  async function designate(targetId: string) {
    setHandoffError(null);
    setHandoffPending(true);
    try {
      // 待交接记录确认保存后才放锁；失败则本页继续在任。
      await session.designate(targetId);
    } catch (err) {
      setHandoffError(
        err instanceof Error ? err.message : `指定交权失败：${String(err)}`,
      );
      setHandoffPending(false);
    }
  }

  function cueContent(cue: Cue): FrameContent {
    if (cue.kind === 'blackout') {
      return { kind: 'blackout', cueId: cue.id, source: '', translation: '' };
    }
    return {
      kind: 'subtitle',
      cueId: cue.id,
      source: cue.source,
      translation: cue.translation,
    };
  }

  function gotoCue(index: number) {
    if (!frozenCues || index < 0 || index >= frozenCues.length) return;
    void send(cueContent(frozenCues[index]));
  }

  function go(delta: -1 | 1) {
    if (!frozenCues) return;
    const base = activeIndex >= 0 ? activeIndex : -1;
    const next = base + delta;
    if (next < 0 || next >= frozenCues.length) return;
    gotoCue(next);
  }

  function explicitBlackout() {
    void send({ kind: 'blackout', cueId: null, source: '', translation: '' });
  }

  // 紧急黑场锁定：锁定记录与已确认黑场帧一笔事务确认后才生效 / 广播。
  async function engageEmergencyLock() {
    setLockError(null);
    setLockPending(true);
    try {
      await session.engageEmergencyBlackout();
    } catch (err) {
      setLockError(
        err instanceof Error ? err.message : `紧急锁定失败：${String(err)}`,
      );
    } finally {
      setLockPending(false);
    }
  }

  // 显式解除：只删锁定记录，画面保持黑场，直到主控主动切句。
  async function releaseEmergencyLock() {
    setLockError(null);
    setLockPending(true);
    try {
      await session.releaseEmergencyBlackout();
    } catch (err) {
      setLockError(
        err instanceof Error ? err.message : `解除锁定失败：${String(err)}`,
      );
    } finally {
      setLockPending(false);
    }
  }

  const shownError =
    lockError ?? actionError ?? handoffError ?? snapshot.error ?? loadError;

  return (
    <div className="performance-layout">
      {/* 本页稳定身份（页面生命周期内不变，便于舞台监督辨认交权对象）。 */}
      <span hidden data-testid="controller-id">
        {session.controllerId}
      </span>
      <div className="stage-area" data-testid="stage">
        <StageView frame={snapshot.frame} />
        {isLost && (
          <div className="lost-overlay" data-testid="lost-overlay">
            <h2>本页已失去控制权</h2>
            <p className="muted">
              另一个控制页面已接管（第 {lostGeneration} 代之后的新代次）。
              本页操控已全部禁用，迟到操作不会影响投影。
            </p>
            <button className="btn" onClick={() => location.reload()}>
              重新进入排队
            </button>
          </div>
        )}
      </div>

      <aside className="side-panel">
        {banned && (
          <div className="capability-warning" data-testid="cap-warning">
            <h3>缺少演出能力，禁止开演</h3>
            <ul>
              {capabilities.missing.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
            <p className="muted">节目单仍可在“编辑”页修改。</p>
          </div>
        )}

        <StatusLine
          status={snapshot.status}
          frame={snapshot.frame}
          banned={banned}
          controllerId={session.controllerId}
          locked={isLocked}
        />

        {shownError && (
          <div className="error-banner" role="alert" data-testid="control-error">
            {shownError}
          </div>
        )}

        {isLocked && (
          <div
            className="status-line blackout-locked"
            data-testid="blackout-locked-banner"
          >
            ⛔ 紧急黑场锁定中：切句一律拒绝，投影持续黑场。
            {isLeader
              ? '锁定在本代次控制者显式解除前持续有效（接管、交权、重新采用均不消失）。'
              : '新控制者必须显式解除后才可继续发布 cue。'}
          </div>
        )}

        {isWaiting && snapshot.designation && (
          <div
            className="status-line designated"
            data-testid="designated-banner"
          >
            ⏱ 舞台监督已指定本页接权（授权 5 秒内有效）。
            当前控制者一释放 Web Lock，本页即凭交接记录接管；
            若授权失效则自动回到普通排队。
          </div>
        )}

        {isWaiting && !snapshot.designation && snapshot.handoffGen > 0 && (
          <div className="status-line handoff-pending" data-testid="handoff-pending">
            交权进行中：等待被指定的控制页接管，授权过期后排队页按顺序接管。
          </div>
        )}

        {banned ? (
          <div className="muted">
            能力缺失，本页不会参与开演，也不提供任何操控入口。
            请更换支持 IndexedDB / Web Locks / BroadcastChannel 的浏览器后重试。
          </div>
        ) : frozenCues === null ? (
          <div className="muted">读取在演版本…</div>
        ) : frozenCues.length === 0 ? (
          <div className="error-banner" data-testid="no-program">
            尚未采用节目单。请先到“编辑”页排好节目单并点击“采用节目单”。
          </div>
        ) : (
          <>
            <div className="nav-row">
              <button
                className="btn"
                data-testid="prev-cue"
                disabled={!isLeader || isLocked || activeIndex <= 0}
                onClick={() => go(-1)}
              >
                ↑ 上一句
              </button>
              <button
                className="btn"
                data-testid="next-cue"
                disabled={
                  !isLeader || isLocked || activeIndex === frozenCues.length - 1
                }
                onClick={() => go(1)}
              >
                下一句 ↓
              </button>
            </div>
            {/* 一次撤销上一帧：仅限当前控制者、当前代次；前一帧以更高序号重新发布。 */}
            <button
              className="btn undo-button"
              data-testid="undo-btn"
              disabled={!isLeader || isLocked || !snapshot.canUndo}
              onClick={() => void undo()}
              title="把上一幅画面以新序号重新发布（仅可撤销最近一次普通切句/黑场）"
            >
              ↶ 撤销上一帧（仅一次）
            </button>
            <button
              className="btn danger big-stage-button"
              data-testid="blackout-btn"
              disabled={!isLeader}
              onClick={explicitBlackout}
            >
              ● 黑场（单帧，不锁定）
            </button>

            {/* 紧急黑场锁定：锁定记录 + 已确认黑场帧一笔事务原子写入。 */}
            {isLeader && !isLocked && (
              <button
                className="btn danger emergency-lock-button"
                data-testid="emergency-lock-btn"
                disabled={lockPending}
                onClick={() => void engageEmergencyLock()}
              >
                ⛔ 紧急黑场锁定（持续黑场，禁止切句）
              </button>
            )}
            {isLeader && isLocked && (
              <button
                className="btn emergency-unlock-button"
                data-testid="emergency-unlock-btn"
                disabled={lockPending}
                onClick={() => void releaseEmergencyLock()}
              >
                解除紧急黑场锁定（恢复可切句；画面保持黑场）
              </button>
            )}

            <div className="cue-run-list" data-testid="cue-run-list">
              {frozenCues.map((cue, i) => (
                <button
                  key={cue.id}
                  className={`cue-run${i === activeIndex ? ' active' : ''}`}
                  disabled={!isLeader || isLocked}
                  data-testid="cue-run"
                  data-active={i === activeIndex}
                  onClick={() => gotoCue(i)}
                >
                  <div className="cue-run-kind">
                    {i + 1}. {cue.kind === 'blackout' ? '黑场' : '字幕'}
                  </div>
                  {cue.kind === 'subtitle' ? (
                    <>
                      <div className="cue-run-src">{cue.source || '（原文空）'}</div>
                      <div className="cue-run-tr">{cue.translation || '（译文空）'}</div>
                    </>
                  ) : (
                    <div className="cue-run-src muted">{cue.note || '全黑'}</div>
                  )}
                </button>
              ))}
            </div>
            <div className="muted" data-testid="frozen-version">
              在演版本冻结于{' '}
              {frozenAt ? new Date(frozenAt).toLocaleString() : '—'}，
              共 {frozenCues.length} 条
              {frozenDraftRev !== null ? `（对应草稿版本 ${frozenDraftRev}）` : ''}
              ；之后的编辑不影响本版本。
            </div>
          </>
        )}

        {isLeader && (
          <div className="handoff-panel" data-testid="handoff-panel">
            <h3>指定并交权（在线控制页）</h3>
            <p className="muted">
              交接记录（来源代次、唯一版本、目标身份、5 秒期限）确认保存后才释放
              Web Lock；仅被指定页可消费授权开下一代，其他排队页不改代次地让路。
            </p>
            {snapshot.candidates.length === 0 ? (
              <div className="muted" data-testid="no-candidates">
                暂无其他在线控制页（请先打开更多开演页并等待其声明在线）。
              </div>
            ) : (
              <ul className="candidate-list">
                {snapshot.candidates.map((c) => (
                  <li key={c.controllerId} className="candidate-item">
                    <span className="candidate-label">
                      {c.label}
                      <span className="candidate-id">（{shortId(c.controllerId)}）</span>
                    </span>
                    <button
                      className="btn small"
                      data-testid="designate-btn"
                      data-candidate-id={c.controllerId}
                      disabled={handoffPending}
                      onClick={() => void designate(c.controllerId)}
                    >
                      指定并交权
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {isLeader && (
          <button
            className="btn"
            data-testid="stand-down"
            onClick={() => void session.standDown()}
          >
            退场交权（交给排队页面）
          </button>
        )}
        {isWaiting && (
          <div className="status-line waiting" data-testid="waiting-banner">
            正在等待唯一操控权：当前已有控制页持锁。
            {waitingController
              ? ` 控制者：${waitingController.label}（第 ${waitingController.generation} 代）`
              : ''}
            {' '}对方关闭、退场或指定交权后本页自动接管。
          </div>
        )}
      </aside>
    </div>
  );
}

function StatusLine({
  status,
  frame,
  banned,
  controllerId,
  locked,
}: {
  status: ReturnType<typeof useSession>['status'];
  frame: FrameState | null;
  banned: boolean;
  controllerId: string;
  locked: boolean;
}) {
  if (banned) {
    return (
      <div className="status-line lost" data-testid="status-line">
        能力缺失：本页不会参与开演。
      </div>
    );
  }
  if (status.role === 'leader') {
    return (
      <div className="status-line leader" data-testid="status-line">
        ● 本页是唯一操控者 · 第 {status.generation} 代 · 本页 {shortId(controllerId)}
        {locked ? ' · ⛔ 紧急黑场锁定中' : ''}
        <div className="controller-readout">
          {frame
            ? `画面序号 ${frame.sequence} · 控制者 ${shortId(status.controllerId)}`
            : ''}
        </div>
      </div>
    );
  }
  if (status.role === 'waiting') {
    return (
      <div className="status-line waiting" data-testid="status-line">
        ◌ 排队等待控制权（只读监视中）· 本页 {shortId(controllerId)}
        {locked ? ' · ⛔ 紧急黑场锁定中' : ''}
      </div>
    );
  }
  if (status.role === 'lost') {
    return (
      <div className="status-line lost" data-testid="status-line">
        ✕ 已失锁（第 {status.generation} 代）· 操控禁用
      </div>
    );
  }
  return (
    <div className="status-line" data-testid="status-line">
      只读监视中
    </div>
  );
}

