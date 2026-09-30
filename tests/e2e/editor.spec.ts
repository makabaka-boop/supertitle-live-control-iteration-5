import { expect, test } from '@playwright/test';
import { makeProgram, resetStorage } from './helpers';

test.use({ storageState: { cookies: [], origins: [] } });

test.describe('编辑 / 排序 / 冻结边界', () => {
  test.beforeEach(async ({ page }) => {
    await resetStorage(page);
  });

  test('空节目单不能采用，按钮禁用且有提示', async ({ page }) => {
    await page.goto('/#/edit');
    const adopt = page.getByTestId('adopt-button');
    await expect(adopt).toBeDisabled();
    await expect(page.getByText('空节目单无法采用')).toBeVisible();
  });

  test('编辑、排序并预览；采用后继续编辑不影响在演版本', async ({ page }) => {
    await page.goto('/#/edit');

    await page.getByRole('button', { name: '＋ 双语字幕' }).click();
    const card = page.getByTestId('cue-card');
    await card.locator('[data-field="source"]').fill('Prima riga');
    await card.locator('[data-field="translation"]').fill('第一行');

    await page.getByRole('button', { name: '＋ 黑场提示' }).click();

    // 预览中先字幕后黑场。
    await expect(page.locator('.stage-preview .src')).toHaveText('Prima riga');
    expect(await page.locator('.stage-preview .blackout').count()).toBe(1);

    // 采用。
    await page.getByTestId('adopt-button').click();
    await expect(page.getByTestId('frozen-banner')).toBeVisible();

    // 之后删光节目单并改草稿：在演版本 banner 仍在，且开演页仍是 2 条。
    const removeButtons = page.getByRole('button', { name: '删除' });
    await removeButtons.nth(1).click();
    await removeButtons.nth(0).click();
    await page.getByRole('button', { name: '＋ 双语字幕' }).click();
    const newCard = page.getByTestId('cue-card');
    await newCard.locator('[data-field="source"]').fill('DOPO');
    await newCard.locator('[data-field="translation"]').fill('改后');

    // 未重新采用前，开演页用的仍是冻结快照。
    await page.goto('/#/stage');
    await expect(page.getByTestId('status-line')).toContainText('唯一操控者');
    const runs = page.getByTestId('cue-run');
    await expect(runs).toHaveCount(2);
    await expect(runs.first()).toContainText('Prima riga');
  });

  test('上移下移改变排序，投影预览跟随', async ({ page }) => {
    await makeProgram(page);
    // 初始顺序：La donna / Addio / 黑场。把 Addio 上移到第一位。
    const cards = page.getByTestId('cue-card');
    await cards.nth(1).getByRole('button', { name: '上移' }).click();
    await page.getByTestId('adopt-button').click();

    await page.goto('/#/stage');
    await expect(page.getByTestId('status-line')).toContainText('唯一操控者');
    const runs = page.getByTestId('cue-run');
    await expect(runs.first()).toContainText('Addio');
    await expect(runs.nth(1)).toContainText('La donna');
  });
});
