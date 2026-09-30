import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { makeProgram, resetStorage } from './helpers';

/**
 * 紧急黑场锁定多页面验收：
 * 主控 A、备用 B（+ 指定交权用的 C）与投影页同源并存。覆盖设置、普通接管、
 * 指定交权、显式解除、写入失败原子性，以及旧代次页面 / 迟到消息越权。
 */

async function isBlack(page: Page): Promise<boolean> {
  return page.getByTestId('blackout-view').isVisible();
}

async function displayedTranslation(page: Page): Promise<string | null> {
  const view = page.getByTestId('subtitle-view');
  if (await view.isVisible()) {
    return (await view.locator('.translation-line').textContent())?.trim() ?? '';
  }
  return null;
}

test.describe.configure({ mode: 'serial' });

test.describe('紧急黑场锁定（设置 / 接管 / 交权 / 解除 / 失败 / 越权）', () => {
  let context: BrowserContext;
  let setup: Page;
  let pageA: Page;
  let pageB: Page;
  let pageC: Page;
  let projector: Page;

  test.beforeAll(async ({ browser }) => {
    // 同上下文 = 同源共享 IndexedDB、Web Locks、BroadcastChannel。
    context = await browser.newContext();
    setup = await context.newPage();
    await resetStorage(setup);
    await makeProgram(setup); // 1=女人善变 2=别了 3=黑场提示

    pageA = await context.newPage();
    pageB = await context.newPage();
    pageC = await context.newPage();
    projector = await context.newPage();

    await pageA.goto('/#/stage');
    await expect(pageA.getByTestId('status-line')).toContainText('唯一操控者', {
      timeout: 10_000,
    });
    for (const p of [pageB, pageC]) {
      await p.goto('/#/stage');
      await expect(p.getByTestId('waiting-banner')).toBeVisible({
        timeout: 10_000,
      });
    }
    await projector.goto('/#/projector');
    await expect(projector.getByTestId('projector-status')).toContainText('主控台');
  });

  test.afterAll(async () => {
    await context.close();
  });

  test('设置：一笔事务确认后投影持续黑场；切句禁用、普通黑场仍是单帧', async () => {
    // 先投出一句字幕，随后用紧急锁定把它压成持续黑场。
    await pageA.getByTestId('cue-run').first().click();
    await expect(projector.getByTestId('subtitle-view')).toContainText('女人善变');

    await pageA.getByTestId('emergency-lock-btn').click();

    // 主控与备用都进入锁定态。
    await expect(pageA.getByTestId('blackout-locked-banner')).toBeVisible();
    await expect(pageA.getByTestId('status-line')).toContainText('紧急黑场锁定中');
    await expect(pageB.getByTestId('blackout-locked-banner')).toBeVisible({
      timeout: 5_000,
    });

    // 投影持续黑场，无任何文字。
    await expect(projector.getByTestId('blackout-view')).toBeVisible();
    expect(await projector.locator('.source-line, .translation-line').count()).toBe(0);

    // 锁定期间切句入口全部禁用（即使强制点击也发不出去）。
    await expect(pageA.getByTestId('next-cue')).toBeDisabled();
    await expect(pageA.getByTestId('cue-run').first()).toBeDisabled();

    // 普通黑场按钮仍可用：只产生单帧黑场，不设置 / 改变锁定。
    await expect(pageA.getByTestId('blackout-btn')).toBeEnabled();
    await pageA.getByTestId('blackout-btn').click();
    await projector.waitForTimeout(200);
    expect(await isBlack(projector)).toBe(true);
    await expect(pageA.getByTestId('blackout-locked-banner')).toBeVisible();
  });

  test('普通接管：锁定跨接管存活，B 接权首帧黑场且必须显式解除才能切句', async () => {
    await pageA.getByTestId('stand-down').click();

    await expect(pageA.getByTestId('lost-overlay')).toBeVisible({ timeout: 10_000 });
    await expect(pageB.getByTestId('status-line')).toContainText('唯一操控者', {
      timeout: 10_000,
    });
    await expect(pageB.getByTestId('status-line')).toContainText('第 2 代');

    // 锁定随接管保留：B 一上任就在锁定态，首帧强制黑场。
    await expect(pageB.getByTestId('blackout-locked-banner')).toBeVisible();
    await expect(projector.locator('.projector-hud')).toContainText('第 2 代');
    expect(await isBlack(projector)).toBe(true);

    // 未解除前 B 切句被禁用 / 拒绝，投影保持黑场。
    await expect(pageB.getByTestId('cue-run').first()).toBeDisabled();
    await pageB.getByTestId('cue-run').nth(1).click({ force: true }).catch(() => {});
    await projector.waitForTimeout(300);
    expect(await displayedTranslation(projector)).toBeNull();

    // 旧主控 A 已失锁：没有解除入口，任何操作无效。
    await expect(pageA.getByTestId('emergency-unlock-btn')).toHaveCount(0);

    // B 显式解除：画面保持黑场，但恢复可切句。
    await pageB.getByTestId('emergency-unlock-btn').click();
    await expect(pageB.getByTestId('blackout-locked-banner')).toBeHidden();
    expect(await isBlack(projector)).toBe(true);

    await pageB.getByTestId('cue-run').nth(1).click();
    await expect(projector.getByTestId('subtitle-view')).toContainText('别了');
  });

  test('指定交权：B 锁定后指定 C，C 带锁接权（首帧黑场），显式解除后恢复', async () => {
    // B 再次设置锁定。
    await pageB.getByTestId('emergency-lock-btn').click();
    await expect(pageB.getByTestId('blackout-locked-banner')).toBeVisible();
    await expect(projector.getByTestId('blackout-view')).toBeVisible();

    // C 应已在 B 的在线候选中（心跳 presence）。
    const cId =
      (await pageC.getByTestId('controller-id').textContent())?.trim() ?? '';
    const cBtn = pageB.locator(
      `[data-testid="designate-btn"][data-candidate-id="${cId}"]`,
    );
    await expect(cBtn).toBeVisible({ timeout: 10_000 });
    await cBtn.click();

    await expect(pageB.getByTestId('lost-overlay')).toBeVisible({ timeout: 10_000 });
    await expect(pageC.getByTestId('status-line')).toContainText('唯一操控者', {
      timeout: 10_000,
    });
    await expect(pageC.getByTestId('status-line')).toContainText('第 3 代');

    // 锁定跨指定交权存活：C 带锁接权，投影黑场。
    await expect(pageC.getByTestId('blackout-locked-banner')).toBeVisible();
    await expect(projector.locator('.projector-hud')).toContainText('第 3 代');
    expect(await isBlack(projector)).toBe(true);

    // 排队页 B、失锁旧页都没有解除按钮；C 解除后恢复。
    await expect(pageB.getByTestId('emergency-unlock-btn')).toHaveCount(0);
    await pageC.getByTestId('emergency-unlock-btn').click();
    await expect(pageC.getByTestId('blackout-locked-banner')).toBeHidden();
    await pageC.getByTestId('cue-run').first().click();
    await expect(projector.getByTestId('subtitle-view')).toContainText('女人善变');
  });

  test('旧代次迟到的“解除锁定”消息不能解除：锁定仍在、切句继续被拒', async () => {
    // C 再锁一次（当前第 3 代）。
    await pageC.getByTestId('emergency-lock-btn').click();
    await expect(pageC.getByTestId('blackout-locked-banner')).toBeVisible();
    await expect(projector.getByTestId('blackout-view')).toBeVisible();

    // 从旧代次（1、2）注入伪造的“已解除”消息。
    for (const gen of [1, 2]) {
      await pageB.evaluate((g) => {
        const ch = new BroadcastChannel('opera-stage-bus');
        ch.postMessage({ type: 'blackout-lock', lock: null, generation: g });
        ch.close();
      }, gen);
    }
    await pageC.waitForTimeout(400);

    // 锁定未被旧消息解除。
    await expect(pageC.getByTestId('blackout-locked-banner')).toBeVisible();
    await expect(pageC.getByTestId('cue-run').first()).toBeDisabled();
    await pageC.getByTestId('cue-run').first().click({ force: true }).catch(() => {});
    await projector.waitForTimeout(300);
    expect(await displayedTranslation(projector)).toBeNull();
    expect(await isBlack(projector)).toBe(true);

    // C 显式解除后立刻恢复（证明锁本身仍工作正常）。
    await pageC.getByTestId('emergency-unlock-btn').click();
    await expect(pageC.getByTestId('blackout-locked-banner')).toBeHidden();
  });

  test('写入失败：设置事务回滚，画面、锁定、投影都保留上一个确认状态', async () => {
    // 当前 C 为第 3 代、已解除。先确认一句字幕作为“上一个确认状态”。
    await pageC.getByTestId('cue-run').first().click();
    await expect(projector.getByTestId('subtitle-view')).toContainText('女人善变');

    // 让下一笔 IDB 写入抛 QuotaExceededError（一次性）。
    await pageC.evaluate(() => {
      const original = IDBObjectStore.prototype.put;
      (window as unknown as { __origPut?: typeof original }).__origPut = original;
      let armed = true;
      IDBObjectStore.prototype.put = function patched(
        this: IDBObjectStore,
        ...args: unknown[]
      ) {
        if (armed) {
          armed = false;
          throw new DOMException('QuotaExceededError', 'QuotaExceededError');
        }
        return original.apply(this, args as [unknown, IDBValidKey?]);
      };
    });

    await pageC.getByTestId('emergency-lock-btn').click();
    // 报错上屏。
    await expect(pageC.getByTestId('control-error')).toContainText(/Error|错误|锁定/, {
      timeout: 5_000,
    });

    // 画面仍是上一幅确认字幕，没有变黑。
    await expect(projector.getByTestId('subtitle-view')).toContainText('女人善变');
    // 没有锁定横幅、没有解除按钮（锁定未成立）。
    await expect(pageC.getByTestId('blackout-locked-banner')).toHaveCount(0);
    await expect(pageC.getByTestId('emergency-unlock-btn')).toHaveCount(0);
    // 紧急锁定按钮仍在（未锁定），可在恢复后重试。
    await expect(pageC.getByTestId('emergency-lock-btn')).toBeVisible();

    // 恢复后正常锁定。
    await pageC.getByTestId('emergency-lock-btn').click();
    await expect(pageC.getByTestId('blackout-locked-banner')).toBeVisible({
      timeout: 5_000,
    });
    await expect(projector.getByTestId('blackout-view')).toBeVisible();
  });

  test('刷新主控：锁定与黑场同时还原，不出现“画面黑了但锁定丢失”', async () => {
    // 上一用例结束时 C 处于锁定黑场。刷新 C：重新竞争接管为新一代。
    await pageC.reload();
    await expect(pageC.getByTestId('status-line')).toContainText('唯一操控者', {
      timeout: 10_000,
    });

    // 锁定与黑场都在；未解除前切句入口禁用。
    await expect(pageC.getByTestId('blackout-locked-banner')).toBeVisible();
    expect(await isBlack(projector)).toBe(true);
    await expect(pageC.getByTestId('cue-run').first()).toBeDisabled();

    await pageC.getByTestId('emergency-unlock-btn').click();
    await expect(pageC.getByTestId('blackout-locked-banner')).toBeHidden();
  });
});
