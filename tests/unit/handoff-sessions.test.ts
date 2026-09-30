import { beforeEach, describe, expect, it } from 'vitest';
import type { FrameContent } from '../../src/types';
import {
  _resetDatabaseForTests,
  loadFrame,
  loadHandoff,
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

function snap(s: { current: SessionSnapshot }): SessionSnapshot {
  return s.current;
}

const flush = (ms = 20) => new Promise((r) => setTimeout(r, ms));

beforeEach(async () => {
  await _resetDatabaseForTests();
  await adoptCues([cue('c1', 'Ah', '啊'), cue('c2', 'Oh', '哦')]);
});

describe('指定并交权（真实锁队列 + 持久裁决）', () => {
  it('A 指定 C：先获锁的 B 不开代，C 凭授权接管；C 关闭后 B 最终接管', async () => {
    const a = new ControllerSession({ id: 'a', label: '甲台' });
    void a.enterContention();
    await flush();
    expect(snap(a).status.role).toBe('leader');
    // A 先确认一句，交接后应被沿用。
    await a.publish(sub('c1', 'Ah', '啊'));
    await flush();

    const b = new ControllerSession({ id: 'b', label: '乙台' });
    const c = new ControllerSession({ id: 'c', label: '丙台' });
    void b.enterContention();
    void c.enterContention();
    await flush(30);
    expect(snap(b).status.role).toBe('waiting');
    expect(snap(c).status.role).toBe('waiting');

    // 在线候选表：A 能看到 B、C（不含自己）。
    const candidates = snap(a).candidates.map((x) => x.controllerId).sort();
    expect(candidates).toEqual(['b', 'c']);

    // C 收到“被指定”提示（也可能因派发稍后才到，多等一拍）。
    await flush(20);

    // A 指定 C：记录确认保存后才放锁。
    const record = await a.designate('c', 5000);
    expect(record.sourceId).toBe('a');
    expect(record.targetId).toBe('c');
    expect(record.generation).toBe(1);

    await flush(30);

    // 关键：B 在队列里先于 C 获锁，但 B 不是目标 → 不改代次让路。
    expect(snap(b).status.role).toBe('waiting');
    expect(snap(a).status.role).toBe('lost');

    // C 消费授权成功，开启第 2 代，沿用 A 的最后确认画面。
    expect(snap(c).status).toMatchObject({
      role: 'leader',
      generation: 2,
      controllerId: 'c',
    });
    expect(snap(c).frame?.generation).toBe(2);
    expect(snap(c).frame?.sequence).toBe(0);
    expect(snap(c).frame?.content.translation).toBe('啊');
    // 授权已单次消费。
    expect(await loadHandoff()).toBeNull();

    // C 操控有效。
    await c.publish(sub('c2', 'Oh', '哦'));
    await flush();
    expect((await loadFrame())?.content.translation).toBe('哦');

    // C 关闭（崩溃 / 关标签）：浏览器释放锁，排队中的 B 最终接管为新一代。
    c.dispose();
    await flush(50);
    // 最坏等到授权相关等待结束也应完成；这里 B 被 gen2 广播提前唤醒。
    const deadline = Date.now() + 3000;
    while (snap(b).status.role !== 'leader' && Date.now() < deadline) {
      await flush(20);
    }
    expect(snap(b).status).toMatchObject({ role: 'leader', generation: 3 });
    // 接管沿用上一幅确认画面。
    expect(snap(b).frame?.generation).toBe(3);
    expect(snap(b).frame?.content.translation).toBe('哦');

    // A 是失锁旧页，任何操作无效。
    await expect(a.publish(sub('c1', 'late', '迟到'))).rejects.toThrow(
      /失去控制权/,
    );

    a.dispose();
    b.dispose();
  });

  it('被指定页关闭 / 授权过期：系统不停摆，排队页过期后普通接管', async () => {
    const a = new ControllerSession({ id: 'a', label: '甲台' });
    void a.enterContention();
    await flush();
    await a.publish(sub('c1', 'Ah', '啊'));

    const b = new ControllerSession({ id: 'b', label: '乙台' });
    const c = new ControllerSession({ id: 'c', label: '丙台' });
    void b.enterContention();
    void c.enterContention();
    await flush(30);

    // 短期限授权（测试加速）：指定 C。
    await a.designate('c', 200);
    // 被指定的 C 在获锁前关闭：没人能消费授权。
    c.dispose();
    await flush(10);

    // B 先获锁但非目标 → 让路；此时 C 已关闭，授权到期后 B 普通接管。
    const deadline = Date.now() + 3000;
    while (snap(b).status.role !== 'leader' && Date.now() < deadline) {
      await flush(30);
    }
    expect(snap(b).status).toMatchObject({ role: 'leader' });
    const gen = (snap(b).status as { generation: number }).generation;
    expect(gen).toBe(2);
    expect(snap(b).frame?.content.translation).toBe('啊');
    // 过期授权已被普通接管事务清理。
    expect(await loadHandoff()).toBeNull();

    a.dispose();
    b.dispose();
  });

  it('投影只显示已确认画面：交接过程不闪黑、不显示未确认帧', async () => {
    const viewer = new ViewerSession();
    await viewer.hydrateFromStorage();

    const a = new ControllerSession({ id: 'a', label: '甲台' });
    void a.enterContention();
    await flush();
    await a.publish(sub('c1', 'Ah', '啊'));
    await flush();
    expect(snap(viewer).frame?.content.translation).toBe('啊');

    const b = new ControllerSession({ id: 'b', label: '乙台' });
    const c = new ControllerSession({ id: 'c', label: '丙台' });
    void b.enterContention();
    void c.enterContention();
    await flush(30);
    await a.designate('c', 5000);
    await flush(30);

    // C 的新一代确认帧到达（沿用画面），投影平滑切代，内容不闪黑。
    expect(snap(c).status).toMatchObject({ role: 'leader', generation: 2 });
    expect(snap(viewer).frame?.generation).toBe(2);
    expect(snap(viewer).frame?.content.translation).toBe('啊');

    // 迟到的旧交接通知（gen 1）不能影响第 2 代之后。
    const { CHANNEL_NAME } = await import('../../src/lib/sessions');
    new BroadcastChannel(CHANNEL_NAME).postMessage({
      type: 'handoff-designate',
      handoff: {
        generation: 1,
        version: 'late',
        sourceId: 'a',
        targetId: 'b',
        expiresAt: Date.now() + 9999,
      },
    });
    await flush();
    // B 不会因旧通知自认被指定；它仍是等待者（随后 C 关闭才接管）。
    expect(snap(b).designation).toBeNull();

    a.dispose();
    b.dispose();
    c.dispose();
    viewer.dispose();
  });
});
