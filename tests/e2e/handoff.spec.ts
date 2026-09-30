import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { makeProgram, resetStorage } from './helpers';

async function displayedTranslation(page: Page): Promise<string | null> {
  const view = page.getByTestId('subtitle-view');
  if (await view.isVisible()) {
    return (await view.locator('.translation-line').textContent())?.trim() ?? '';
  }
  return null;
}

/** 读取开演页在页面生命周期内的稳定身份。 */
async function controllerId(page: Page): Promise<string> {
  return (await page.getByTestId('controller-id').textContent())?.trim() ?? '';
}

/** 打开开演页并等待进入终态（持锁 / 排队），返回本页稳定身份。 */
async function openStage(page: Page): Promise<string> {
  await page.goto('/#/stage');
  await expect(page.getByTestId('status-line')).toBeVisible({ timeout: 10_000 });
  return controllerId(page);
}

test.describe.configure({ mode: 'serial' });

test.describe('指定并交权（三控制页 A/B/C + 一投影页）', () => {
  let context: BrowserContext;
  let setup: Page;
  let pageA: Page;
  let pageB: Page;
  let pageC: Page;
  let projector: Page;
  let idA: string;
  let idB: string;
  let idC: string;

  test.beforeAll(async ({ browser }) => {
    // 同上下文 = 同源共享 IndexedDB、Web Locks、BroadcastChannel。
    context = await browser.newContext();
    setup = await context.newPage();
    await resetStorage(setup);
    await makeProgram(setup);

    pageA = await context.newPage();
    pageB = await context.newPage();
    pageC = await context.newPage();
    projector = await context.newPage();

    idA = await openStage(pageA);
    idB = await openStage(pageB);
    idC = await openStage(pageC);
  });

  test.afterAll(async () => {
    await context.close();
  });

  test('准备：A 持锁，B、C 排队且出现在 A 的在线候选中，投影跟随 A', async () => {
    await expect(pageA.getByTestId('status-line')).toContainText('唯一操控者', {
      timeout: 10_000,
    });
    await expect(pageB.getByTestId('waiting-banner')).toBeVisible();
    await expect(pageC.getByTestId('waiting-banner')).toBeVisible();

    // A 先确认一句，交接后应被沿用。
    await pageA.getByTestId('next-cue').click();
    await projector.goto('/#/projector');
    await expect(projector.getByTestId('subtitle-view')).toContainText(
      '女人善变',
    );
    await expect(projector.getByTestId('projector-status')).toContainText(
      '主控台',
    );

    // 候选列表包含 B 和 C（身份稳定可辨认）。
    const buttonsA = pageA.getByTestId('designate-btn');
    await expect(buttonsA).toHaveCount(2, { timeout: 10_000 });
    const candidateIds = await buttonsA.evaluateAll((els) =>
      els.map((el) => (el as HTMLElement).dataset.candidateId ?? ''),
    );
    expect(candidateIds.sort()).toEqual([idB, idC].sort());
    expect(candidateIds).not.toContain(idA);
  });

  test('A 指定 C：先获锁的 B 不开代，C 接管为新一代，投影只显示已确认画面', async () => {
    // 精确点到 C 的“指定并交权”。
    const cBtn = pageA.locator(
      `[data-testid="designate-btn"][data-candidate-id="${idC}"]`,
    );
    await expect(cBtn).toBeVisible();
    await cBtn.click();

    // A 已失锁（记录确认保存后才放锁）。
    await expect(pageA.getByTestId('lost-overlay')).toBeVisible({
      timeout: 10_000,
    });

    // C 收到“被指定”提示（若锁流转极快，提示可能一闪而过；不做强断言）。
    // B 是先排队的非目标：它会先获锁但不能开代，仍在等待。
    await expect(pageB.getByTestId('status-line')).not.toContainText(
      '第 2 代',
      { timeout: 2_000 },
    );

    // C 凭交接记录接管：第 2 代。
    await expect(pageC.getByTestId('status-line')).toContainText('唯一操控者', {
      timeout: 10_000,
    });
    await expect(pageC.getByTestId('status-line')).toContainText('第 2 代');

    // B 始终没有开过第 2 代（此刻仍排队）。
    await expect(pageB.getByTestId('waiting-banner')).toBeVisible();

    // 投影：平滑切到第 2 代已确认画面，内容沿用 A 的最后确认句（不闪黑）。
    await expect(projector.locator('.projector-hud')).toContainText('第 2 代');
    await expect(projector.getByTestId('subtitle-view')).toContainText(
      '女人善变',
    );

    // C 的操控有效且被投影确认；未确认前投影不会抢先变化。
    const before = await displayedTranslation(projector);
    await pageC.getByTestId('cue-run').nth(1).click();
    await expect(projector.getByTestId('subtitle-view')).toContainText('别了');
    const after = await displayedTranslation(projector);
    expect(after).not.toBe(before);
  });

  test('C 关闭后 B 最终接管为新一代，投影继续只显示确认画面', async () => {
    await pageC.close();

    // 被指定者退场：授权到期前 B 让路，到期（或新代次信号）后 B 接管，系统不停摆。
    await expect(pageB.getByTestId('status-line')).toContainText('唯一操控者', {
      timeout: 20_000,
    });
    await expect(pageB.getByTestId('status-line')).toContainText('第 3 代');

    // 接管瞬间沿用上一幅确认画面（别了），不闪黑。
    await expect(projector.locator('.projector-hud')).toContainText('第 3 代');
    await expect(projector.getByTestId('subtitle-view')).toContainText('别了');

    // B 接管后操控有效。
    await pageB.getByTestId('cue-run').first().click();
    await expect(projector.getByTestId('subtitle-view')).toContainText(
      '女人善变',
    );
  });

  test('投影只显示已确认画面：旧代次迟到消息一律丢弃', async () => {
    // 第 1 代 / 第 2 代的幽灵帧都不能覆盖当前第 3 代确认画面。
    for (const gen of [1, 2]) {
      await pageB.evaluate((g) => {
        const ch = new BroadcastChannel('opera-stage-bus');
        ch.postMessage({
          type: 'frame',
          frame: {
            generation: g,
            sequence: 9999,
            controllerId: 'ghost-old',
            controllerLabel: '旧台',
            content: {
              kind: 'subtitle',
              cueId: 'ghost',
              source: 'GHOST',
              translation: `旧代次幽灵句-${g}`,
            },
            publishedAt: Date.now(),
          },
        });
        ch.close();
      }, gen);
    }
    await projector.waitForTimeout(300);
    expect(await displayedTranslation(projector)).not.toBe('旧代次幽灵句-1');
    expect(await displayedTranslation(projector)).not.toBe('旧代次幽灵句-2');
    await expect(projector.getByTestId('subtitle-view')).toContainText(
      '女人善变',
    );
  });
});
