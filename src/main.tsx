import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

// 纯离线单页，不加载任何外部脚本 / 字体 / 统计。
// 不使用 StrictMode：会话对象持有 Web Lock / BroadcastChannel 等单例资源，
// 开发期 effect 双调用会先释放再重占，反而制造“失锁”假象。
const container = document.getElementById('root');
if (!container) throw new Error('缺少 #root 挂载点');
createRoot(container).render(<App />);
