import type { FrameState } from '../types';

/**
 * 纯展示当前已确认画面。blackout（含 cueId 为 null 的显式黑场）全黑。
 */
export function StageView({
  frame,
  hud,
}: {
  frame: FrameState | null;
  hud?: string;
}) {
  const content = frame?.content;
  const isBlack = !content || content.kind === 'blackout';

  return (
    <>
      {hud && <div className="projector-hud">{hud}</div>}
      {isBlack ? (
        // 黑场：全黑，不投出任何文字（含显式黑场按钮与黑场条目）。
        <div className="blackout-mark" data-testid="blackout-view" aria-label="黑场" />
      ) : (
        <div className="stage-content" data-testid="subtitle-view">
          {content.source && <p className="source-line">{content.source}</p>}
          {content.translation && (
            <p className="translation-line">{content.translation}</p>
          )}
        </div>
      )}
    </>
  );
}
