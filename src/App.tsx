import { useEffect, useMemo, useState } from 'react';
import { detectCapabilities } from './lib/capabilities';
import { EditorPage } from './pages/EditorPage';
import { ControlPage } from './pages/ControlPage';
import { ProjectorPage } from './pages/ProjectorPage';

type Route = 'edit' | 'stage' | 'projector';

function parseHash(): Route {
  const h = location.hash.replace(/^#\/?/, '');
  if (h === 'stage') return 'stage';
  if (h === 'projector') return 'projector';
  return 'edit';
}

export default function App() {
  const [route, setRoute] = useState<Route>(parseHash);
  // 能力在整个页面生命周期内只探测一次；缺项时编辑仍可用但禁止开演。
  const capabilities = useMemo(() => detectCapabilities(), []);

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  if (route === 'projector') {
    return <ProjectorPage />;
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <h1>歌剧舞台提词台</h1>
        <nav>
          <a
            href="#/edit"
            className={route === 'edit' ? 'active' : ''}
          >
            编辑节目单
          </a>
          <a
            href="#/stage"
            className={route === 'stage' ? 'active' : ''}
          >
            开演控制台
          </a>
          <a href="#/projector">投影页（只读）</a>
        </nav>
      </header>
      {route === 'edit' ? (
        <EditorPage capabilities={capabilities} />
      ) : (
        <ControlPage capabilities={capabilities} />
      )}
    </div>
  );
}
