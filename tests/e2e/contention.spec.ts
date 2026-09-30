import { expect, test, type Page } from '@playwright/test';
import { makeProgram, openControl, resetStorage } from './helpers';

async function displayedTranslation(page: Page): Promise<string | null> {
  const view = page.getByTestId('subtitle-view');
  if (await view.isVisible()) {
    return (await view.locator('.translation-line').textContent())?.trim() ?? '';
  }
  return null;
}

test.describe.configure({ mode: 'serial' });

test.describe('多页面唯一操控者争用（同源多页面）', () => {
  let setup: Page;
  let leader: Page;
  let waiter: Page;
  let projector: Page;

  test.beforeAll(async ({ browser }) => {
    // 控制页 / 投影页必须同一上下文：同源共享 IndexedDB、Web Locks、BroadcastChannel。
    const context = await browser.newContext();
    setup = await context.newPage();
    await resetStorage(setup);
    await makeProgram(setup);

    leader = await context.newPage();
    waiter = await context.newPage();
    projector = await context.newPage();
  });

  test.afterAll(async () => {
    await setup.context().close();
  });

  test('只有一个页面成为控制者，其他控制页只读排队；切句/黑场投影跟随', async () => {
    await openControl(leader);

    await waiter.goto('/#/stage');
    await expect(waiter.getByTestId('waiting-banner')).toBeVisible({
      timeout: 10_000,
    });
    await expect(waiter.getByTestId('next-cue')).toBeDisabled();
    await expect(waiter.getByTestId('blackout-btn')).toBeDisabled();

    await projector.goto('/#/projector');
    await expect(projector.getByTestId('projector-status')).toContainText(
      '主控台',
    );

    await leader.getByTestId('next-cue').click();
    await expect(projector.getByTestId('subtitle-view')).toContainText(
      '女人善变',
    );
    await leader.getByTestId('next-cue').click();
    await expect(projector.getByTestId('subtitle-view')).toContainText('别了');

    await leader.getByTestId('blackout-btn').click();
    await expect(projector.getByTestId('blackout-view')).toBeVisible();
    expect(await projector.locator('.source-line, .translation-line').count()).toBe(0);

    await expect(waiter.getByTestId('status-line')).toContainText('排队');
  });

  test('控制页关闭后排队者接管为新代次，观众看到新代次确认画面', async () => {
    await leader.close();

    await expect(waiter.getByTestId('status-line')).toContainText('唯一操控者', {
      timeout: 10_000,
    });
    await expect(waiter.getByTestId('status-line')).toContainText('第 2 代');

    // 接管瞬间沿用黑场（上一幅确认画面），新控制者切到第一句。
    await waiter.getByTestId('cue-run').first().click();
    await expect(projector.getByTestId('subtitle-view')).toContainText(
      '女人善变',
    );
    await expect(projector.locator('.projector-hud')).toContainText('第 2 代');
  });

  test('失锁旧页的迟到消息（旧代次/同代次旧序号）不能覆盖；投影重载读持久状态', async () => {
    // 旧代次高序号“幽灵帧”：必须被代次栅栏丢弃。
    await waiter.evaluate(() => {
      const ch = new BroadcastChannel('opera-stage-bus');
      ch.postMessage({
        type: 'frame',
        frame: {
          generation: 1,
          sequence: 9999,
          controllerId: 'ghost-old',
          controllerLabel: '旧台',
          content: {
            kind: 'subtitle',
            cueId: 'ghost',
            source: 'GHOST',
            translation: '旧代次幽灵句',
          },
          publishedAt: Date.now(),
        },
      });
      ch.close();
    });
    await projector.waitForTimeout(300);
    expect(await displayedTranslation(projector)).not.toBe('旧代次幽灵句');
    await expect(projector.getByTestId('subtitle-view')).toContainText(
      '女人善变',
    );

    // 同代次更小序号也不能回退。
    await waiter.evaluate(() => {
      const ch = new BroadcastChannel('opera-stage-bus');
      ch.postMessage({
        type: 'frame',
        frame: {
          generation: 2,
          sequence: 0,
          controllerId: 'new-but-old-seq',
          controllerLabel: '伪',
          content: {
            kind: 'subtitle',
            cueId: 'x',
            source: 'OLDSEQ',
            translation: '旧序号',
          },
          publishedAt: Date.now(),
        },
      });
      ch.close();
    });
    await projector.waitForTimeout(300);
    expect(await displayedTranslation(projector)).not.toBe('旧序号');

    // 投影重载：读取持久状态，仍是新代次确认画面，之后继续接收更新。
    await projector.reload();
    await expect(projector.getByTestId('subtitle-view')).toContainText(
      '女人善变',
    );
    await expect(projector.locator('.projector-hud')).toContainText('第 2 代');

    await waiter.getByTestId('cue-run').nth(1).click();
    await expect(projector.getByTestId('subtitle-view')).toContainText('别了');
  });

  test('失锁旧页本身立即禁用，操作无效', async () => {
    // 第三个控制页排队；让 waiter 退场，第三者接管，waiter 立即失锁。
    const third = await setup.context().newPage();
    await third.goto('/#/stage');
    await expect(third.getByTestId('waiting-banner')).toBeVisible();

    await waiter.getByTestId('stand-down').click();
    await expect(third.getByTestId('status-line')).toContainText('唯一操控者', {
      timeout: 10_000,
    });
    await expect(waiter.getByTestId('lost-overlay')).toBeVisible();
    await expect(waiter.getByTestId('next-cue')).toBeDisabled();
    await expect(waiter.getByTestId('blackout-btn')).toBeDisabled();

    const before = await displayedTranslation(projector);
    // 旧页即便强行点列表项，publish 也被本地状态拦截。
    await waiter.getByTestId('cue-run').first().click({ force: true }).catch(() => {});
    await projector.waitForTimeout(300);
    expect(await displayedTranslation(projector)).toBe(before);

    await third.close();
  });
});
