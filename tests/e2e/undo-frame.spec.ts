import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { makeProgram, resetStorage } from './helpers';

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

async function frameSeq(page: Page): Promise<number | null> {
  const text = (await page.locator('.projector-hud').textContent()) ?? '';
  const match = text.match(/(\d+)#/);
  return match ? Number(match[1]) : null;
}

async function controllerId(page: Page): Promise<string> {
  return (await page.getByTestId('controller-id').textContent())?.trim() ?? '';
}

test.describe.configure({ mode: 'serial' });

test.describe('一次撤销上一帧（连续切句 / 黑场 / 交权 / 迟到消息 / 写盘失败）', () => {
  let context: BrowserContext | undefined;
  let setup!: Page;
  let pageA!: Page;
  let pageB!: Page;
  let pageC!: Page;
  let projector!: Page;
  let idC = '';

  test.beforeAll(async ({ browser }) => {
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
      await expect(p.getByTestId('waiting-banner')).toBeVisible({ timeout: 10_000 });
    }
    idC = await controllerId(pageC);

    await projector.goto('/#/projector');
    await expect(projector.getByTestId('projector-status')).toContainText('主控台');
    expect(await isBlack(projector)).toBe(true);
  });

  test.afterAll(async () => {
    await context?.close();
  });

  test('连续切句：撤销最近一次且使用更高序号，投影不把它当旧画面；不能重复撤销', async () => {
    await expect(pageA.getByTestId('undo-frame-btn')).toBeDisabled();

    await pageA.getByTestId('next-cue').click();
    await expect(projector.getByTestId('subtitle-view')).toContainText('女人善变');
    await expect(pageA.getByTestId('undo-frame-btn')).toBeEnabled();

    await pageA.getByTestId('next-cue').click();
    await expect(projector.getByTestId('subtitle-view')).toContainText('别了');
    await expect(frameSeq(projector)).resolves.toBe(2);

    await pageA.getByTestId('undo-frame-btn').click();
    await expect(projector.getByTestId('subtitle-view')).toContainText('女人善变');
    await expect(frameSeq(projector)).resolves.toBe(3);
    await expect(pageA.getByTestId('undo-frame-btn')).toBeDisabled();

    // 资格已消费：强制重复点击也不能继续回退到开场黑场。
    await pageA.getByTestId('undo-frame-btn').click({ force: true }).catch(() => {});
    await projector.waitForTimeout(200);
    await expect(projector.getByTestId('subtitle-view')).toContainText('女人善变');
    await expect(frameSeq(projector)).resolves.toBe(3);
  });

  test('普通黑场也可撤销，撤销后恢复前一句；随后资格再次清空', async () => {
    await pageA.getByTestId('blackout-btn').click();
    await expect(projector.getByTestId('blackout-view')).toBeVisible();
    await expect(frameSeq(projector)).resolves.toBe(4);
    await expect(pageA.getByTestId('undo-frame-btn')).toBeEnabled();

    await pageA.getByTestId('undo-frame-btn').click();
    await expect(projector.getByTestId('subtitle-view')).toContainText('女人善变');
    await expect(frameSeq(projector)).resolves.toBe(5);
    await expect(pageA.getByTestId('undo-frame-btn')).toBeDisabled();
  });

  test('指定交权后旧资格不得沿用；新控制者的新发布才可撤销', async () => {
    const cBtn = pageA.locator(
      `[data-testid="designate-btn"][data-candidate-id="${idC}"]`,
    );
    await expect(cBtn).toBeVisible({ timeout: 10_000 });
    await cBtn.click();

    await expect(pageA.getByTestId('lost-overlay')).toBeVisible({ timeout: 10_000 });
    await expect(pageC.getByTestId('status-line')).toContainText('第 2 代', {
      timeout: 10_000,
    });
    await expect(pageC.getByTestId('undo-frame-btn')).toBeDisabled();

    // C 的第一幅新画面沿用 A 的最后确认句（女人善变），不闪黑。
    await expect(projector.locator('.projector-hud')).toContainText('第 2 代');
    await expect(projector.getByTestId('subtitle-view')).toContainText('女人善变');

    await pageC.getByTestId('next-cue').click();
    await expect(projector.getByTestId('subtitle-view')).toContainText('别了');
    await expect(pageC.getByTestId('undo-frame-btn')).toBeEnabled();
    await pageC.getByTestId('undo-frame-btn').click();
    await expect(projector.getByTestId('subtitle-view')).toContainText('女人善变');
    await expect(frameSeq(projector)).resolves.toBe(2);
    await expect(pageC.getByTestId('undo-frame-btn')).toBeDisabled();
  });

  test('撤销产生的是高序号新帧：旧代次迟到广播和更低序号都不能覆盖投影', async () => {
    await pageC.getByTestId('next-cue').click();
    await expect(projector.getByTestId('subtitle-view')).toContainText('别了');
    await expect(frameSeq(projector)).resolves.toBe(3);
    await pageC.getByTestId('undo-frame-btn').click();
    await expect(projector.getByTestId('subtitle-view')).toContainText('女人善变');
    await expect(frameSeq(projector)).resolves.toBe(4);

    for (const frame of [
      { generation: 1, sequence: 9999, source: 'GHOST-G1', translation: '旧代次幽灵' },
      { generation: 2, sequence: 1, source: 'OLDSEQ', translation: '旧序号画面' },
    ]) {
      await pageB.evaluate((f) => {
        const ch = new BroadcastChannel('opera-stage-bus');
        ch.postMessage({
          type: 'frame',
          frame: {
            generation: f.generation,
            sequence: f.sequence,
            controllerId: 'ghost',
            controllerLabel: '幽灵',
            content: {
              kind: 'subtitle',
              cueId: 'ghost',
              source: f.source,
              translation: f.translation,
            },
            publishedAt: Date.now(),
          },
        });
        ch.close();
      }, frame);
    }

    await projector.waitForTimeout(300);
    expect(await displayedTranslation(projector)).toBe('女人善变');
    await expect(frameSeq(projector)).resolves.toBe(4);
  });

  test('撤销写盘失败：错误上屏，控制台、投影和持久帧都停留；恢复后可重试', async () => {
    await pageC.getByTestId('next-cue').click();
    await expect(projector.getByTestId('subtitle-view')).toContainText('别了');
    await expect(frameSeq(projector)).resolves.toBe(5);
    await expect(pageC.getByTestId('undo-frame-btn')).toBeEnabled();

    await pageC.evaluate(() => {
      const original = IDBObjectStore.prototype.put;
      let armed = true;
      IDBObjectStore.prototype.put = function patchedPut(
        this: IDBObjectStore,
        ...args: unknown[]
      ) {
        const value = args[0] as { key?: string };
        if (armed && value?.key === 'frame') {
          armed = false;
          throw new DOMException('QuotaExceededError', 'QuotaExceededError');
        }
        return original.apply(this, args as [unknown, IDBValidKey?]);
      };
    });

    await pageC.getByTestId('undo-frame-btn').click();
    await expect(pageC.getByTestId('control-error')).toBeVisible({ timeout: 5_000 });

    // 事务已回滚：投影仍是误切后的“别了”，序号仍为 5；资格没被消费。
    await expect(projector.getByTestId('subtitle-view')).toContainText('别了');
    await expect(frameSeq(projector)).resolves.toBe(5);
    await expect(pageC.getByTestId('undo-frame-btn')).toBeEnabled();

    // 下一次点击走恢复后的数据库：以前一内容发布 seq=6，而不是重放旧序号。
    await pageC.getByTestId('undo-frame-btn').click();
    await expect(projector.getByTestId('subtitle-view')).toContainText('女人善变');
    await expect(frameSeq(projector)).resolves.toBe(6);
    await expect(pageC.getByTestId('undo-frame-btn')).toBeDisabled();
  });
});
