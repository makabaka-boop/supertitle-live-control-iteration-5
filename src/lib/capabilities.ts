// 运行能力探测。缺项时编辑功能仍可用，但必须列明缺项并禁止开演。

import type { CapabilityReport } from '../types';

export function detectCapabilities(): CapabilityReport {
  const hasIDB =
    typeof indexedDB !== 'undefined' &&
    typeof indexedDB.open === 'function' &&
    typeof IDBFactory !== 'undefined';
  const hasLocks =
    typeof navigator !== 'undefined' &&
    !!navigator.locks &&
    typeof navigator.locks.request === 'function';
  const hasBC =
    typeof BroadcastChannel !== 'undefined' &&
    typeof BroadcastChannel === 'function';
  const hasClone = typeof structuredClone === 'function';

  const missing: string[] = [];
  if (!hasIDB) missing.push('IndexedDB（持久状态与代次事务）');
  if (!hasLocks) missing.push('Web Locks（跨页面唯一控制者）');
  if (!hasBC) missing.push('BroadcastChannel（画面即时发布）');
  if (!hasClone) missing.push('structuredClone（状态安全序列化）');

  return {
    indexedDB: hasIDB,
    webLocks: hasLocks,
    broadcastChannel: hasBC,
    structuredClone: hasClone,
    missing,
  };
}
