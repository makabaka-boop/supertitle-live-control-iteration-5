import { beforeEach, describe, expect, it } from 'vitest';
import type { FrameContent } from '../../src/types';
import {
  _resetDatabaseForTests,
  loadBlackoutLock,
  loadFrame,
} from '../../src/lib/db';
import { adoptCues } from './program';
import { ControllerSession, ViewerSession } from '../../src/lib/sessions';
import type { SessionSnapshot } from '../../src/lib/sessions';

const cue = (id: string, source: string, translation: string) => ({
  id,
  kind: 'subtitle' as const,
  source,
  translation,
  note: '',
});

const sub = (id: string, s: string, t: string): FrameContent => ({
  kind: 'subtitle',
  cueId: id,
  source: s,
  translation: t,
});

const BLACK: FrameContent = {
  kind: 'blackout',
  cueId: null,
  source: '',
  translation: '',
};

function snap(s: { current: SessionSnapshot }): SessionSnapshot {
  return s.current;
}

const flush = (ms = 20) => new Promise((r) => setTimeout(r, ms));

beforeEach(async () => {
  await _resetDatabaseForTests();
  await adoptCues([
    cue('c1', 'Ah', '啊'),
    cue('c2', 'Oh', '哦'),
  ]);
});

describe('设置：一笔事务确认后才广播，投影持续黑场', () => {
  it('紧急锁定后：本页与排队页进入锁定态、投影黑场、切句被拒', async () => {
    const a = new ControllerSession({ id: 'a', label: '甲台' });
    const b = new ControllerSession({ id: 'b', label: '乙台' });
    const viewer = new ViewerSession();
    void a.enterContention();
    void b.enterContention();
    void viewer.hydrateFromStorage();
    await flush(30);
    expect(snap(a).status.role).toBe('leader');

    await a.publish(sub('c1', 'Ah', '啊'));
    await flush();
    expect(snap(viewer).frame?.content.translation).toBe('啊');

    await a.engageEmergencyBlackout();
    await flush();

    // 三端状态：持锁页 / 排队页锁定，投影黑场。
    expect(snap(a).blackoutLock).not.toBeNull();
    expect(snap(b).blackoutLock).not.toBeNull();
    expect(snap(viewer).frame?.content.kind).toBe('blackout');
    expect(snap(viewer).frame?.content.cueId).toBeNull();

    // 锁定期间切句请求一律拒绝（DB 栅栏 + 错误上抛）。
    await expect(a.publish(sub('c2', 'Oh', '哦'))).rejects.toThrow(/锁定/);
    await flush();
    expect(snap(viewer).frame?.content.kind).toBe('blackout');

    // 普通黑场按钮仍可发单帧黑场，不改变锁定。
    const lockedAt = snap(a).blackoutLock?.lockedAt;
    await a.publish(BLACK);
    await flush();
    expect(snap(a).blackoutLock?.lockedAt).toBe(lockedAt);
    expect(snap(viewer).frame?.content.kind).toBe('blackout');

    a.dispose();
    b.dispose();
    viewer.dispose();
  });

  it('失锁 / 排队页不能设置或解除锁定', async () => {
    const a = new ControllerSession({ id: 'a', label: '甲台' });
    const b = new ControllerSession({ id: 'b', label: '乙台' });
    void a.enterContention();
    void b.enterContention();
    await flush(30);

    await expect(b.engageEmergencyBlackout()).rejects.toThrow(/失去控制权/);
    await expect(b.releaseEmergencyBlackout()).rejects.toThrow(/失去控制权/);
    expect(await loadBlackoutLock()).toBeNull();

    a.dispose();
    b.dispose();
  });
});

describe('接管 / 交权：锁定持续存在，新控制者须显式解除', () => {
  it('普通接管：锁定跨代次存活，新 leader 首帧黑场、未解除前不能切句', async () => {
    const a = new ControllerSession({ id: 'a', label: '甲台' });
    const b = new ControllerSession({ id: 'b', label: '乙台' });
    const viewer = new ViewerSession();
    void a.enterContention();
    void b.enterContention();
    void viewer.hydrateFromStorage();
    await flush(30);

    await a.publish(sub('c1', 'Ah', '啊'));
    await flush();
    await a.engageEmergencyBlackout();
    await flush();
    expect(await loadBlackoutLock()).not.toBeNull();

    // A 退场，B 普通接管为第 2 代。
    await a.standDown();
    await flush();
    await flush();
    expect(snap(b).status).toMatchObject({ role: 'leader', generation: 2 });

    // 锁定仍在；B 的首帧是强制黑场（不是沿用 c1 字幕）。
    expect(snap(b).blackoutLock).not.toBeNull();
    expect(snap(b).frame?.generation).toBe(2);
    expect(snap(b).frame?.content.kind).toBe('blackout');
    expect(snap(b).frame?.content.cueId).toBeNull();
    expect(snap(viewer).frame?.generation).toBe(2);
    expect(snap(viewer).frame?.content.kind).toBe('blackout');

    // 未显式解除：B 切句被拒。
    await expect(b.publish(sub('c2', 'Oh', '哦'))).rejects.toThrow(/锁定/);
    expect((await loadFrame())?.content.kind).toBe('blackout');

    // 旧主控 A（第 1 代）任何操作都无效。
    await expect(a.publish(sub('c1', 'late', '迟到'))).rejects.toThrow(
      /失去控制权/,
    );

    // B 显式解除后恢复发布，画面切到解除后的第一句。
    await b.releaseEmergencyBlackout();
    await flush();
    expect(snap(b).blackoutLock).toBeNull();
    expect(snap(a).blackoutLock).toBeNull(); // 解除广播也同步给旧页
    await b.publish(sub('c2', 'Oh', '哦'));
    await flush();
    expect(snap(viewer).frame?.content.translation).toBe('哦');

    a.dispose();
    b.dispose();
    viewer.dispose();
  });

  it('指定交权：被指定页带锁接管，其他排队页与旧页均不能解除', async () => {
    const a = new ControllerSession({ id: 'a', label: '甲台' });
    const b = new ControllerSession({ id: 'b', label: '乙台' });
    const c = new ControllerSession({ id: 'c', label: '丙台' });
    const viewer = new ViewerSession();
    void a.enterContention();
    void b.enterContention();
    void c.enterContention();
    void viewer.hydrateFromStorage();
    await flush(30);

    await a.publish(sub('c1', 'Ah', '啊'));
    await flush();
    await a.engageEmergencyBlackout();
    await flush();
    expect(snap(viewer).frame?.content.kind).toBe('blackout');

    // A 指定 C 交权（锁定中同样允许交权）。
    await a.designate('c', 5000);
    await flush(40);

    expect(snap(c).status).toMatchObject({ role: 'leader', generation: 2 });
    // 锁定跨交权存活，接权首帧强制黑场。
    expect(snap(c).blackoutLock).not.toBeNull();
    expect(snap(c).frame?.content.kind).toBe('blackout');
    expect(snap(viewer).frame?.generation).toBe(2);
    expect(snap(viewer).frame?.content.kind).toBe('blackout');

    // 排队中的 B 不能解除；旧主控 A 不能解除。
    await expect(b.releaseEmergencyBlackout()).rejects.toThrow(/失去控制权/);
    await expect(a.releaseEmergencyBlackout()).rejects.toThrow(/失去控制权/);
    expect(await loadBlackoutLock()).not.toBeNull();

    // C 未解除前切句被拒，解除后恢复。
    await expect(c.publish(sub('c2', 'Oh', '哦'))).rejects.toThrow(/锁定/);
    await c.releaseEmergencyBlackout();
    await flush();
    await c.publish(sub('c2', 'Oh', '哦'));
    await flush();
    expect(snap(viewer).frame?.content.translation).toBe('哦');

    a.dispose();
    b.dispose();
    c.dispose();
    viewer.dispose();
  });
});

describe('旧代次页面与迟到消息不能解除或覆盖锁定', () => {
  it('旧代次伪造的“已解除”广播被代次栅栏丢弃，排队页保持锁定', async () => {
    const a = new ControllerSession({ id: 'a', label: '甲台' });
    const b = new ControllerSession({ id: 'b', label: '乙台' });
    void a.enterContention();
    void b.enterContention();
    await flush(30);
    await a.engageEmergencyBlackout();
    await flush();
    expect(snap(b).blackoutLock).not.toBeNull();

    // A 退场、B 接管为第 2 代（锁仍在）。
    await a.standDown();
    await flush();
    await flush();
    expect(snap(b).status).toMatchObject({ role: 'leader', generation: 2 });
    expect(snap(b).blackoutLock).not.toBeNull();

    // 迟到的旧代次（gen 1）“解除锁定”消息抵达 B：必须丢弃。
    const { CHANNEL_NAME } = await import('../../src/lib/sessions');
    new BroadcastChannel(CHANNEL_NAME).postMessage({
      type: 'blackout-lock',
      lock: null,
      generation: 1,
    });
    await flush();
    expect(snap(b).blackoutLock).not.toBeNull();

    // 旧代次的“重新锁定”消息同样不能覆盖新代次状态。
    new BroadcastChannel(CHANNEL_NAME).postMessage({
      type: 'blackout-lock',
      lock: {
        generation: 1,
        controllerId: 'a',
        controllerLabel: '甲台',
        lockedAt: 1,
      },
      generation: 1,
    });
    await flush();
    // 锁仍是接管事务保留的那一条（来自 A 设置时的记录，generation 字段为 1，
    // 但当前代次为 2）：关键是没被消息清空 / 替换。
    expect(snap(b).blackoutLock).not.toBeNull();
    expect(await loadBlackoutLock()).not.toBeNull();

    a.dispose();
    b.dispose();
  });

  it('持锁 leader 不理会任何总线上的锁定 / 解除消息', async () => {
    const a = new ControllerSession({ id: 'a', label: '甲台' });
    void a.enterContention();
    await flush();

    const { CHANNEL_NAME } = await import('../../src/lib/sessions');
    // 伪造“解除”。
    new BroadcastChannel(CHANNEL_NAME).postMessage({
      type: 'blackout-lock',
      lock: null,
      generation: 1,
    });
    await flush();
    expect(snap(a).blackoutLock).toBeNull();

    await a.engageEmergencyBlackout();
    await flush();
    // 伪造更高代次的“解除”也不能影响在任 leader。
    new BroadcastChannel(CHANNEL_NAME).postMessage({
      type: 'blackout-lock',
      lock: null,
      generation: 99,
    });
    await flush();
    expect(snap(a).blackoutLock).not.toBeNull();

    a.dispose();
  });
});

describe('写入失败与刷新语义', () => {
  it('engage 写入失败：数据库、本地控制台与“投影”都保留上一个确认状态', async () => {
    const a = new ControllerSession({ id: 'a', label: '甲台' });
    const viewer = new ViewerSession();
    void a.enterContention();
    void viewer.hydrateFromStorage();
    await flush();
    await a.publish(sub('c1', 'Ah', '啊'));
    await flush();
    expect(snap(viewer).frame?.content.translation).toBe('啊');

    const originalPut = IDBObjectStore.prototype.put;
    let armed = true;
    IDBObjectStore.prototype.put = function patchedPut(
      this: IDBObjectStore,
      ...args: unknown[]
    ) {
      if (armed) {
        armed = false;
        throw new DOMException('QuotaExceededError', 'QuotaExceededError');
      }
      return originalPut.apply(this, args as [unknown, IDBValidKey?]);
    };

    await expect(a.engageEmergencyBlackout()).rejects.toThrow();
    IDBObjectStore.prototype.put = originalPut;
    await flush();

    // 三方一致保留上一个确认状态。
    expect(await loadBlackoutLock()).toBeNull();
    const stored = await loadFrame();
    expect(stored?.content.translation).toBe('啊');
    expect(snap(a).frame?.content.translation).toBe('啊');
    expect(snap(a).blackoutLock).toBeNull();
    expect(snap(viewer).frame?.content.translation).toBe('啊');

    // 错误恢复后可正常锁定。
    await a.engageEmergencyBlackout();
    await flush();
    expect(snap(a).blackoutLock).not.toBeNull();
    expect(snap(viewer).frame?.content.kind).toBe('blackout');

    a.dispose();
    viewer.dispose();
  });

  it('刷新后锁定与黑场帧同时还原，不出现“画面黑了但锁定丢失”', async () => {
    const a = new ControllerSession({ id: 'a', label: '甲台' });
    void a.enterContention();
    await flush();
    await a.engageEmergencyBlackout();
    await flush();
    expect(await loadBlackoutLock()).not.toBeNull();
    a.dispose();
    await flush(40); // 等锁释放，避免新会话排队。

    // 新页面（模拟刷新）先 hydrate：锁定与画面必须同时到位。
    const reopened = new ControllerSession({ id: 'a2', label: '甲台-刷新' });
    await reopened.hydrateFrame();
    expect(snap(reopened).blackoutLock).not.toBeNull();
    expect(snap(reopened).frame?.content.kind).toBe('blackout');

    // 接管为新一代：锁定仍在、首帧黑场。
    void reopened.enterContention();
    await flush(30);
    expect(snap(reopened).status).toMatchObject({ role: 'leader' });
    expect(snap(reopened).blackoutLock).not.toBeNull();
    expect(snap(reopened).frame?.content.kind).toBe('blackout');

    reopened.dispose();
  });
});
