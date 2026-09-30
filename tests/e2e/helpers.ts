import { expect, type Page } from '@playwright/test';

/**
 * 每个用例从空节目单起步。
 * 新页面加载应用、再删库：本页 openDb 只发起了 open 请求，
 * 紧接着的 deleteDatabase 会让 open 失败、删除顺利完成；随后重载得到干净库。
 */
export async function resetStorage(page: Page): Promise<void> {
  await page.goto('/#/edit');
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        localStorage.clear();
        const req = indexedDB.deleteDatabase('opera-prompter');
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
        req.onblocked = () =>
          reject(new Error('删除旧库被阻塞，请确认没有其他页面开着本应用'));
      }),
  );
  await page.goto('/#/edit');
}

export async function makeProgram(page: Page): Promise<void> {
  await page.goto('/#/edit');
  await page.getByRole('button', { name: '＋ 双语字幕' }).click();
  await page
    .getByTestId('cue-card')
    .locator('[data-field="source"]')
    .fill('La donna');
  await page
    .getByTestId('cue-card')
    .locator('[data-field="translation"]')
    .fill('女人善变');

  await page.getByRole('button', { name: '＋ 双语字幕' }).click();
  const second = page.getByTestId('cue-card').nth(1);
  await second.locator('[data-field="source"]').fill('Addio');
  await second.locator('[data-field="translation"]').fill('别了');

  await page.getByRole('button', { name: '＋ 黑场提示' }).click();

  await page.getByTestId('adopt-button').click();
  await expect(page.getByTestId('frozen-banner')).toBeVisible();
}

export async function openControl(page: Page): Promise<void> {
  await page.goto('/#/stage');
  await expect(page.getByTestId('status-line')).toContainText('唯一操控者', {
    timeout: 10_000,
  });
}
