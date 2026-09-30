import { useEffect, useMemo } from 'react';
import { ViewerSession } from '../lib/sessions';
import { useSession } from '../lib/useSessionSnapshot';
import { StageView } from '../components/StageView';

/**
 * 投影页：严格只读。
 * - 打开 / 重开先从 IndexedDB 读取上一幅已确认画面；
 * - 之后只接受更高代次、或同代次更大序号的广播帧；
 * - 显示当前有效控制者；失锁旧页的迟到消息由代次栅栏丢弃。
 */
export function ProjectorPage() {
  const session = useMemo(() => new ViewerSession(), []);
  const snapshot = useSession(session);

  useEffect(() => {
    void session.hydrateFromStorage();
    return () => session.dispose();
  }, [session]);

  const controller =
    snapshot.status.role === 'viewer' ? snapshot.status.controller : null;
  const frameControllerId = snapshot.frame?.controllerId;
  const gen = snapshot.frame?.generation;
  const seq = snapshot.frame?.sequence;

  const hud = [
    '观众投影',
    controller ? `控制者：${controller.label}` : frameControllerId ? '控制者：（仅持久记录）' : '等待开演',
    gen !== undefined ? `第 ${gen} 代 · ${seq}#` : '',
  ]
    .filter(Boolean)
    .join('　');

  return (
    <div className="performance-layout nobar">
      <div className="stage-area" data-testid="projector-stage">
        <StageView frame={snapshot.frame} hud={hud} />
      </div>
      <aside className="side-panel">
        <div className="status-line" data-testid="projector-status">
          {controller
            ? `当前控制者：${controller.label}（第 ${controller.generation} 代）`
            : '当前无有效控制者（投影只读，不能操控）'}
        </div>
        {snapshot.error && (
          <div className="error-banner" role="alert">
            {snapshot.error}
          </div>
        )}
        <div className="muted">
          本页只读：只接受更高代次、或同代次更大序号的画面；
          旧控制页面的迟到消息会被丢弃，刷新后以持久状态为准。
        </div>
        <a className="btn" href="#/edit" style={{ textAlign: 'center' }}>
          ← 返回编辑台
        </a>
      </aside>
    </div>
  );
}
