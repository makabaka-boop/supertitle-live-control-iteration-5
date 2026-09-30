import { useEffect, useState } from 'react';
import type { BaseSession, SessionSnapshot } from './sessions';

/** 订阅会话快照（ViewerSession / ControllerSession 通用）。 */
export function useSession(session: BaseSession): SessionSnapshot {
  const [snapshot, setSnapshot] = useState<SessionSnapshot>(session.current);
  useEffect(() => session.subscribe(setSnapshot), [session]);
  return snapshot;
}
