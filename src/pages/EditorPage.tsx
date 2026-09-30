import { useMemo } from 'react';
import type { CapabilityReport, Cue } from '../types';
import { useProgram } from '../lib/useProgram';

interface EditorPageProps {
  capabilities: CapabilityReport;
}

export function EditorPage({ capabilities }: EditorPageProps) {
  const {
    state,
    addCue,
    updateCue,
    removeCue,
    moveCue,
    adopt,
    reloadLatest,
    overwriteWithMine,
  } = useProgram();
  const { draft, frozen, saving, dirty, savedAt, error, conflict } = state;

  // 预览按当前编辑顺序生成（黑场条目也占一位）。
  const previewCues = useMemo(
    () => draft.cues.slice(0, 6),
    [draft.cues],
  );

  return (
    <div className="content">
      {error && <div className="error-banner" role="alert">{error}</div>}

      {conflict && (
        <div className="error-banner" role="alert" data-testid="conflict-banner">
          <div>
            ⚠ 版本冲突：另一窗口已保存更新的节目单草稿（版本
            {conflict.persistedRev}，
            {new Date(conflict.persistedAt).toLocaleTimeString()}）。
            为避免覆盖对方已确认的内容，本页自动保存已暂停；本页修改仍保留在
            屏幕上，未被丢弃。
          </div>
          <div className="conflict-actions">
            <button
              className="btn"
              data-testid="conflict-reload"
              onClick={() => void reloadLatest()}
            >
              载入最新草稿（放弃本页修改）
            </button>
            <button
              className="btn"
              data-testid="conflict-overwrite"
              onClick={() => void overwriteWithMine()}
            >
              用本页内容覆盖对方版本
            </button>
          </div>
        </div>
      )}

      {capabilities.missing.length > 0 && (
        <div className="capability-warning" data-testid="cap-warning">
          <h3>当前浏览器缺少演出所需能力（仍可编辑节目单，但禁止开演）</h3>
          <ul>
            {capabilities.missing.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </div>
      )}

      {frozen && (
        <div className="frozen-banner" data-testid="frozen-banner">
          ✦ 已采用在演版本：{frozen.cues.length} 条，
          冻结于 {new Date(frozen.frozenAt).toLocaleString()}
          {frozen.draftRev !== undefined ? `（对应草稿版本 ${frozen.draftRev}）` : ''}。
          继续编辑不会影响正在演出的版本，需再次点“采用节目单”才会更新。
        </div>
      )}

      <div className="editor-toolbar">
        <button className="btn" onClick={() => addCue('subtitle')}>
          ＋ 双语字幕
        </button>
        <button className="btn" onClick={() => addCue('blackout')}>
          ＋ 黑场提示
        </button>
        <button
          className="btn primary"
          data-testid="adopt-button"
          disabled={draft.cues.length === 0 || conflict !== null}
          onClick={() => void adopt()}
          title={
            draft.cues.length === 0
              ? '空节目单不能采用'
              : conflict
                ? '请先解决版本冲突（载入最新或显式覆盖）再采用'
                : '把当前编辑内容冻结为在演版本（与草稿存档同版本）'
          }
        >
          采用节目单
        </button>
        <span className="save-state" data-testid="save-state">
          {conflict
            ? '版本冲突：本页修改未保存'
            : saving
              ? '保存中…'
              : dirty
                ? '有未保存的修改'
                : savedAt
                  ? `草稿已保存 ${new Date(savedAt).toLocaleTimeString()}`
                  : ''}
        </span>
        <span className="muted" data-testid="draft-rev">
          草稿版本 {draft.draftRev}
        </span>
      </div>

      {draft.cues.length === 0 ? (
        <div className="empty-hint">
          节目单为空。添加第一条双语字幕或黑场提示；空节目单无法采用。
        </div>
      ) : (
        draft.cues.map((cue, idx) => (
          <CueEditor
            key={cue.id}
            cue={cue}
            index={idx}
            total={draft.cues.length}
            onUpdate={(patch) => updateCue(cue.id, patch)}
            onRemove={() => removeCue(cue.id)}
            onMove={(dir) => moveCue(cue.id, dir)}
          />
        ))
      )}

      <div className="preview-panel">
        <h3>投影预览（按当前排序）</h3>
        <div className="stage-preview">
          {previewCues.length === 0 ? (
            <span className="muted">尚无可预览条目</span>
          ) : (
            previewCues.map((c, i) =>
              c.kind === 'blackout' ? (
                <div className="blackout" key={c.id}>
                  ◼ 黑场 {i + 1}
                  {c.note ? `｜${c.note}` : ''}
                </div>
              ) : (
                <div key={c.id}>
                  <div className="src">{c.source || '（原文空）'}</div>
                  <div className="tr">{c.translation || '（译文空）'}</div>
                </div>
              ),
            )
          )}
        </div>
      </div>
    </div>
  );
}

interface CueEditorProps {
  cue: Cue;
  index: number;
  total: number;
  onUpdate: (patch: Partial<Omit<Cue, 'id'>>) => void;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
}

function CueEditor({ cue, index, total, onUpdate, onRemove, onMove }: CueEditorProps) {
  return (
    <div
      className={`cue-card${cue.kind === 'blackout' ? ' blackout' : ''}`}
      data-testid="cue-card"
      data-cue-id={cue.id}
    >
      <div className="cue-index">{index + 1}</div>
      <div className="cue-fields">
        <div className="row2">
          <select
            value={cue.kind}
            onChange={(e) => onUpdate({ kind: e.target.value as Cue['kind'] })}
            aria-label="条目类型"
          >
            <option value="subtitle">双语字幕</option>
            <option value="blackout">黑场提示</option>
          </select>
          <input
            value={cue.note}
            placeholder="舞台备注（仅控制端可见）"
            onChange={(e) => onUpdate({ note: e.target.value })}
          />
        </div>
        {cue.kind === 'subtitle' ? (
          <>
            <textarea
              value={cue.source}
              placeholder="原文行"
              data-field="source"
              onChange={(e) => onUpdate({ source: e.target.value })}
            />
            <textarea
              value={cue.translation}
              placeholder="译文行"
              data-field="translation"
              onChange={(e) => onUpdate({ translation: e.target.value })}
            />
          </>
        ) : (
          <div>
            <span className="kind-badge blackout">黑场：投影将全黑</span>
            <span className="muted" style={{ marginLeft: 8 }}>
              可用备注记录黑场意图，不投出文字。
            </span>
          </div>
        )}
      </div>
      <div className="cue-actions">
        <button
          className="icon-btn"
          aria-label="上移"
          disabled={index === 0}
          onClick={() => onMove(-1)}
        >
          ↑
        </button>
        <button
          className="icon-btn"
          aria-label="下移"
          disabled={index === total - 1}
          onClick={() => onMove(1)}
        >
          ↓
        </button>
        <button
          className="icon-btn"
          aria-label="删除"
          onClick={onRemove}
        >
          ✕
        </button>
      </div>
    </div>
  );
}
