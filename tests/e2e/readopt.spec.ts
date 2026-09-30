import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { makeProgram, resetStorage } from './helpers';

/**
 * 验收场景（编辑页 / 主控页 / 备用页 / 投影页）：
 * 两张控制页都已打开（缓存旧条目）后，校对员在编辑页对在演节目做
 * 删减、改文案、重排并重新采用；随后主控退场触发备用页普通接管。
 * 断言：旧 cue 不可继续发布、备用页只展示新条目、被删除的最后确认
 * 画面以黑场进入新代次；失败采用与未采用草稿都不改变在演结果。
 */

test.describe.configure({ mode: 'serial' });

test.describe('重新采用（删减 / 改文案 / 重排）后的在演一致性', () => {
  let context: BrowserContext;
  let editor: Page;
  let leader: Page;
  let backup: Page;
  let projector: Page;

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext();
    editor = await context.newPage();
    await resetStorage(editor);
    await makeProgram(editor);
    // 初始节目：A=女人善变、B=别了、BK=黑场，已采用。

    leader = await context.newPage();
    backup = await context.newPage();
    projector = await context.newPage();
  });

  test.afterAll(async () => {
    await context.close();
  });

  test('主控与备用先后打开；主控把即将被删除的 A 句确认为当前画面，投影跟随', async () => {
    await leader.goto('/#/stage');
    await expect(leader.getByTestId('status-line')).toContainText('唯一操控者', {
      timeout: 10_000,
    });

    await backup.goto('/#/stage');
    await expect(backup.getByTestId('waiting-banner')).toBeVisible({
      timeout: 10_000,
    });

    await projector.goto('/#/projector');
    await expect(projector.getByTestId('projector-status')).toContainText('主控台');

    await leader.getByTestId('cue-run').first().click();
    await expect(projector.getByTestId('subtitle-view')).toContainText('女人善变');
  });

  test('校对员删减 A、改写 B 文案、重排后重新采用', async () => {
    let ids = await editor
      .getByTestId('cue-card')
      .evaluateAll((els) =>
        els.map((e) => e.getAttribute('data-cue-id') ?? ''),
      );
    expect(ids).toHaveLength(3);
    const [idA, idB, idBk] = ids;

    // 删减 A。
    await editor
      .locator(`[data-cue-id="${idA}"] .icon-btn[aria-label="删除"]`)
      .click();

    // 改写 B 的译文。
    await editor
      .locator(`[data-cue-id="${idB}"]`)
      .locator('[data-field="translation"]')
      .fill('再会吧，朋友');

    // 重排：把黑场条目移到 B 之前。
    await editor
      .locator(`[data-cue-id="${idBk}"] .icon-btn[aria-label="上移"]`)
      .click();

    ids = await editor
      .getByTestId('cue-card')
      .evaluateAll((els) =>
        els.map((e) => e.getAttribute('data-cue-id') ?? ''),
      );
    expect(ids).toEqual([idBk, idB]);

    await editor.getByTestId('adopt-button').click();
    await expect(editor.getByTestId('frozen-banner')).toContainText('2 条');
  });

  test('重新采用后主控的可操作 cue 立即与最新冻结版本一致，旧 cue 无法再发布', async () => {
    const runs = leader.getByTestId('cue-run');
    await expect(runs).toHaveCount(2, { timeout: 10_000 });
    await expect(leader.getByTestId('cue-run-list')).toContainText('再会吧，朋友');
    await expect(leader.getByTestId('cue-run-list')).not.toContainText('女人善变');

    // 主控此刻不再发布任何新画面：最后确认画面仍是已被删除的 A，
    // 为下一用例的“删除画面进入黑场”制造前提。
    await expect(projector.getByTestId('subtitle-view')).toContainText('女人善变');
  });

  test('主控退场后备用普通接管为新代次：删除画面确定进入黑场，备用只展示新条目', async () => {
    await leader.getByTestId('stand-down').click();

    await expect(backup.getByTestId('status-line')).toContainText('唯一操控者', {
      timeout: 10_000,
    });
    await expect(backup.getByTestId('status-line')).toContainText('第 2 代');

    // 上一代最后确认画面 A 已被删除：新代次以黑场进入，旧句绝不继续投出。
    await expect(projector.locator('.projector-hud')).toContainText('第 2 代');
    await expect(projector.getByTestId('blackout-view')).toBeVisible();
    await expect(projector.locator('.source-line, .translation-line')).toHaveCount(0);

    // 备用页可操作 cue 只有新节目的两条（黑场 + 改写后的 B）。
    await expect(backup.getByTestId('cue-run')).toHaveCount(2);
    await expect(backup.getByTestId('cue-run-list')).toContainText('再会吧，朋友');
    await expect(backup.getByTestId('cue-run-list')).not.toContainText('女人善变');

    // 备用切到 B（新文案）：投影确认；旧文案在备用列表中从未出现。
    await backup.getByTestId('cue-run').nth(1).click();
    await expect(projector.getByTestId('subtitle-view')).toContainText('再会吧，朋友');

    // 切到黑场条目同样有效。
    await backup.getByTestId('cue-run').first().click();
    await expect(projector.getByTestId('blackout-view')).toBeVisible();
  });

  test('未采用的草稿不影响演出', async () => {
    // 编辑页新增一条草稿字幕但不点击“采用节目单”。
    await editor.getByRole('button', { name: '＋ 双语字幕' }).click();
    const draftCard = editor.getByTestId('cue-card').last();
    await draftCard.locator('[data-field="source"]').fill('Bozza');
    await draftCard.locator('[data-field="translation"]').fill('草稿新句');
    await editor.waitForTimeout(600); // 等草稿防抖落盘（落盘的只是 draft）。

    // 备用页的在演列表与投影都不受草稿影响。
    await expect(backup.getByTestId('cue-run')).toHaveCount(2);
    await expect(backup.getByTestId('cue-run-list')).not.toContainText('草稿新句');
    await expect(projector.getByTestId('blackout-view')).toBeVisible();

    // 备用仍可正常操控在演版本。
    await backup.getByTestId('cue-run').nth(1).click();
    await expect(projector.getByTestId('subtitle-view')).toContainText('再会吧，朋友');
  });

  test('重新采用失败：保留原节目与最后有效画面，不产生半更新状态', async () => {
    // 在编辑页注入一次性写盘失败：仅当事务写入 frozen 时抛 Quota 错误。
    await editor.evaluate(() => {
      const proto = IDBObjectStore.prototype as unknown as {
        put: (...args: unknown[]) => unknown;
      };
      const original = proto.put;
      proto.put = function patchedPut(this: IDBObjectStore, ...args: unknown[]) {
        const value = args[0] as { key?: string } | undefined;
        if (value && value.key === 'frozen') {
          proto.put = original;
          throw new DOMException('QuotaExceededError', 'QuotaExceededError');
        }
        return original.apply(this, args as [unknown, IDBValidKey?]);
      };
    });

    await editor.getByTestId('adopt-button').click();
    await expect(editor.getByRole('alert')).toContainText('采用失败');

    // 冻结横幅仍是上一版（2 条），没有变成草稿的 3 条，也没有清空。
    await expect(editor.getByTestId('frozen-banner')).toContainText('2 条');

    // 在演结果完全不变：备用仍是第 2 代唯一操控者，列表仍为 2 条，
    // 最后有效画面（B 新文案）继续可投，演出不中断。
    await expect(backup.getByTestId('status-line')).toContainText('唯一操控者');
    await expect(backup.getByTestId('status-line')).toContainText('第 2 代');
    await expect(backup.getByTestId('cue-run')).toHaveCount(2);
    await expect(projector.getByTestId('subtitle-view')).toContainText('再会吧，朋友');

    await backup.getByTestId('cue-run').first().click();
    await expect(projector.getByTestId('blackout-view')).toBeVisible();
    await backup.getByTestId('cue-run').nth(1).click();
    await expect(projector.getByTestId('subtitle-view')).toContainText('再会吧，朋友');
  });
});
