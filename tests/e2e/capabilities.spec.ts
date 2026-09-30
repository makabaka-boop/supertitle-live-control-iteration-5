import { expect, test } from '@playwright/test';

// 通过 addInitScript 在应用代码前抹掉 Web Locks，模拟旧浏览器 / 受限环境。
test.describe('能力缺失时的降级边界', () => {
  test.use({
    contextOptions: {
      // 每个测试独立上下文，避免污染其他用例。
    },
  });

  test('缺少 Web Locks：仍可编辑节目单，但列明缺项并禁止开演', async ({
    browser,
  }) => {
    const context = await browser.newContext();
    await context.addInitScript(() => {
      Object.defineProperty(window.navigator, 'locks', {
        value: undefined,
        configurable: true,
      });
    });
    const page = await context.newPage();

    await page.goto('/#/edit');
    // 编辑能力完整：可以添加字幕并填写。
    await page.getByRole('button', { name: '＋ 双语字幕' }).click();
    await page
      .getByTestId('cue-card')
      .locator('[data-field="source"]')
      .fill('Senza lock');
    await page
      .getByTestId('cue-card')
      .locator('[data-field="translation"]')
      .fill('无锁也可编辑');

    // 缺项被逐项列明。
    const warning = page.getByTestId('cap-warning');
    await expect(warning).toBeVisible();
    await expect(warning).toContainText('Web Locks');

    // 仍可采用节目单（编辑/持久化不依赖锁）。
    await page.getByTestId('adopt-button').click();
    await expect(page.getByTestId('frozen-banner')).toBeVisible();

    // 但开演页明确禁止，不参与竞争、无任何可操作按钮。
    await page.goto('/#/stage');
    await expect(page.getByTestId('cap-warning')).toContainText('Web Locks');
    await expect(page.getByTestId('status-line')).toContainText('能力缺失');
    await expect(page.getByTestId('next-cue')).toHaveCount(0);
    await expect(page.getByTestId('blackout-btn')).toHaveCount(0);

    await context.close();
  });
});
