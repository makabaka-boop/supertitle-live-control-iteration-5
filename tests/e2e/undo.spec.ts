import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { makeProgram, resetStorage } from './helpers';

/**
 * “一次撤销上一帧”多页面验收（主控 A / 备用 B / 投影页）：
 * 连续切句、普通黑场、重复撤销、普通接管交权、迟到广播、写入故障、
 * 重新采用后资格失效。撤销帧以更高序号发布，投影端不会误判为迟到旧画面。
 */

async function displayedTranslation(page: Page): Promise<string | null> {
  const view = page.getByTestId('subtitle-view');
  if (await view.isVisible()) {
    return (await view.locator('.translation-line').textContent())?.trim() ?? '';
  }
  return null;
}

async function frameSeq(page: Page): Promise<number | null> {
  const hud = page.locator('.projector-hud');
  const text = (await hud.textContent()) ?? '';
  const m = text.match(/(\d+)#/);
  return m ? Number(m[1]) : null;
}

async function controllerId(page: Page): Promise<string> {
  return (await page.getByTestId('controller-id').textContent())?.trim() ?? '';
}

test.describe.configure({ mode: 'serial' });

test.describe('一次撤销上一帧（连续切句 / 黑场 / 重复撤销 / 交权 / 迟到广播 / 写入故障）', () => {
  let context: BrowserContext;
  let setup: Page;
  let pageA: Page;
  let pageB: Page;
  let pageC: Page;
  let projector: Page;
  let idB: string;

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
    await pageB.goto('/#/stage');
    await expect(pageB.getByTestId('waiting-banner')).toBeVisible({
      timeout: 10_000,
    });
    idB = await controllerId(pageB);
    // C 也先排队在线，供后续“指定交权”直接点选。
    await pageC.goto('/#/stage');
    await expect(pageC.getByTestId('waiting-banner')).toBeVisible({
      timeout: 10_000,
    });
    await projector.goto('/#/projector');
    await expect(projector.getByTestId('projector-status')).toContainText('主控台');
  });

  test.afterAll(async () => {
    await context.close();
  });

  test('开场无撤销资格：撤销按钮禁用', async () => {
    await expect(pageA.getByTestId('undo-btn')).toBeDisabled();
  });

  test('连续切句误切下一句：撤销后投影回到上一句，且帧序号继续增大；不能重复撤销', async () => {
    await pageA.getByTestId('cue-run').nth(0).click();
    await expect(projector.getByTestId('subtitle-view')).toContainText('女人善变');
    await expect(pageA.getByTestId('undo-btn')).toBeEnabled();

    // 误切到下一句。
    await pageA.getByTestId('cue-run').nth(1).click();
    await expect(projector.getByTestId('subtitle-view')).toContainText('别了');
    const seqMistake = await frameSeq(projector);
    expect(seqMistake).not.toBeNull();

    // 撤销：投影回到上一句。
    await pageA.getByTestId('undo-btn').click();
    await expect(projector.getByTestId('subtitle-view')).toContainText('女人善变');

    // 撤销不是回退序号：序号严格大于误切帧，投影不会把它当迟到旧画面。
    const seqUndo = await frameSeq(projector);
    expect(seqUndo).toBe((seqMistake ?? 0) + 1);

    // 资格一次性：按钮立即禁用，重复点击无效，画面稳定。
    await expect(pageA.getByTestId('undo-btn')).toBeDisabled();
    expect(await displayedTranslation(projector)).toBe('女人善变');
  });

  test('误切普通黑场：撤销后投影恢复黑场之前的字幕', async () => {
    await pageA.getByTestId('blackout-btn').click();
    await expect(projector.getByTestId('blackout-view')).toBeVisible();
    await expect(pageA.getByTestId('undo-btn')).toBeEnabled();

    await pageA.getByTestId('undo-btn').click();
    await expect(projector.getByTestId('subtitle-view')).toContainText('女人善变');
    await expect(pageA.getByTestId('undo-btn')).toBeDisabled();
  });

  test('迟到广播：被撤销掉的旧帧晚到不能覆盖撤销后画面', async () => {
    const seqNow = await frameSeq(projector);
    expect(seqNow).not.toBeNull();

    // 从外部注入一条“迟到”的旧序号黑场帧（模拟失锁旧页 / 网络重放）。
    await pageB.evaluate(
      ({ gen, seq }) => {
        const ch = new BroadcastChannel('opera-stage-bus');
        ch.postMessage({
          type: 'frame',
          frame: {
            generation: gen,
            sequence: seq,
            controllerId: 'late',
            controllerLabel: '迟到页',
            content: { kind: 'blackout', cueId: null, source: '', translation: '' },
            publishedAt: Date.now(),
          },
        });
        ch.close();
      },
      { gen: 1, seq: (seqNow ?? 1) - 1 },
    );
    await projector.waitForTimeout(400);

    // 投影仍显示撤销恢复的字幕，不被旧帧压黑。
    expect(await displayedTranslation(projector)).toBe('女人善变');
    expect(await frameSeq(projector)).toBe(seqNow);
  });

  test('普通接管交权：B 接为新一代后撤销按钮禁用，撤销无效', async () => {
    // A 再确认一句，给旧资格制造素材。
    await pageA.getByTestId('cue-run').nth(1).click();
    await expect(projector.getByTestId('subtitle-view')).toContainText('别了');
    await expect(pageA.getByTestId('undo-btn')).toBeEnabled();

    await pageA.getByTestId('stand-down').click();
    await expect(pageA.getByTestId('lost-overlay')).toBeVisible({ timeout: 10_000 });
    await expect(pageB.getByTestId('status-line')).toContainText('唯一操控者', {
      timeout: 10_000,
    });
    await expect(pageB.getByTestId('status-line')).toContainText('第 2 代');
    await expect(projector.locator('.projector-hud')).toContainText('第 2 代');

    // 新代次不沿用旧资格：B 的撤销按钮禁用。
    await expect(pageB.getByTestId('undo-btn')).toBeDisabled();

    // 失锁旧页 A 也没有可点的撤销入口（按钮 disabled）。
    await expect(pageA.getByTestId('undo-btn')).toBeDisabled();
  });

  test('指定交权同样不沿用资格：B 指定 C，C 成第 3 代后撤销按钮禁用', async () => {
    // B 先发布一句以产生资格，随后指定交权给排队中的 C。
    await pageB.getByTestId('cue-run').nth(0).click();
    await expect(projector.getByTestId('subtitle-view')).toContainText('女人善变');
    await expect(pageB.getByTestId('undo-btn')).toBeEnabled();

    const idC = await controllerId(pageC);
    const btn = pageB.locator(
      `[data-testid="designate-btn"][data-candidate-id="${idC}"]`,
    );
    await expect(btn).toBeVisible({ timeout: 10_000 });
    await btn.click();

    await expect(pageB.getByTestId('lost-overlay')).toBeVisible({ timeout: 10_000 });
    await expect(pageC.getByTestId('status-line')).toContainText('唯一操控者', {
      timeout: 10_000,
    });
    await expect(pageC.getByTestId('status-line')).toContainText('第 3 代');
    await expect(projector.locator('.projector-hud')).toContainText('第 3 代');
    await expect(pageC.getByTestId('undo-btn')).toBeDisabled();

    // 失锁旧页 B 也没有可用的撤销入口。
    await expect(pageB.getByTestId('undo-btn')).toBeDisabled();

    // 避免未使用告警：idB 仅用于排查。
    expect(idB.length).toBeGreaterThan(0);
  });

  test('写入故障：撤销事务失败时控制台与投影都停留在误切帧，恢复后撤销成功', async () => {
    // 当前 C 为第 3 代：先连续两句制造撤销素材。
    await pageC.getByTestId('cue-run').nth(0).click();
    await expect(projector.getByTestId('subtitle-view')).toContainText('女人善变');
    await pageC.getByTestId('cue-run').nth(1).click();
    await expect(projector.getByTestId('subtitle-view')).toContainText('别了');
    const seqBefore = await frameSeq(projector);

    // 让下一笔 IDB 删除 / 写入抛 Quota 错误（一次性）。
    await pageC.evaluate(() => {
      const original = IDBObjectStore.prototype.put;
      (window as unknown as { __origUndoPut?: typeof original }).__origUndoPut =
        original;
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

    await pageC.getByTestId('undo-btn').click();
    await expect(pageC.getByTestId('control-error')).toContainText(/Error|错误|撤销/, {
      timeout: 5_000,
    });

    // 控制台 / 投影 / 序号都停留在误切帧（别了），没有先成功后回退。
    expect(await displayedTranslation(projector)).toBe('别了');
    expect(await frameSeq(projector)).toBe(seqBefore);
    // 失败不消费资格：报错恢复后按钮仍可用。
    await expect(pageC.getByTestId('undo-btn')).toBeEnabled();

    await pageC.getByTestId('undo-btn').click();
    await expect(projector.getByTestId('subtitle-view')).toContainText('女人善变');
    await expect(pageC.getByTestId('undo-btn')).toBeDisabled();
    expect(await frameSeq(projector)).toBe((seqBefore ?? 0) + 1);
  });

  test('紧急黑场锁定后撤销资格作废，且锁定期间不产生新资格', async () => {
    // 先切一句产生资格，再紧急锁定（同事务清资格 + 黑场帧）。
    await pageC.getByTestId('cue-run').nth(1).click();
    await expect(projector.getByTestId('subtitle-view')).toContainText('别了');
    await expect(pageC.getByTestId('undo-btn')).toBeEnabled();

    await pageC.getByTestId('emergency-lock-btn').click();
    await expect(pageC.getByTestId('blackout-locked-banner')).toBeVisible();
    await expect(projector.getByTestId('blackout-view')).toBeVisible();
    await expect(pageC.getByTestId('undo-btn')).toBeDisabled();

    // 锁定中的普通黑场不产生资格。
    await pageC.getByTestId('blackout-btn').click();
    await projector.waitForTimeout(200);
    await expect(pageC.getByTestId('undo-btn')).toBeDisabled();

    // 解除后画面仍黑，依旧没有可撤销资格。
    await pageC.getByTestId('emergency-unlock-btn').click();
    await expect(pageC.getByTestId('blackout-locked-banner')).toBeHidden();
    await expect(pageC.getByTestId('undo-btn')).toBeDisabled();
    await expect(projector.getByTestId('blackout-view')).toBeVisible();
  });

  test('重新采用删除当前可撤销目标：资格失效，撤销被拒，画面不变', async () => {
    // 解除后当前画面是黑场；切到“女人善变”再切黑场，使撤销目标=女人善变。
    await pageC.getByTestId('cue-run').nth(0).click();
    await expect(projector.getByTestId('subtitle-view')).toContainText('女人善变');
    await pageC.getByTestId('blackout-btn').click();
    await expect(projector.getByTestId('blackout-view')).toBeVisible();
    await expect(pageC.getByTestId('undo-btn')).toBeEnabled();

    // 编辑页删掉第一条字幕并重新采用。
    const editor = await context.newPage();
    await editor.goto('/#/edit');
    const ids = await editor
      .getByTestId('cue-card')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-cue-id') ?? ''));
    await editor
      .locator(`[data-cue-id="${ids[0]}"] .icon-btn[aria-label="删除"]`)
      .click();
    await editor.getByTestId('adopt-button').click();
    await expect(editor.getByTestId('frozen-banner')).toContainText('2 条');
    await editor.close();

    // C 收到重新采用通知：撤销按钮立即禁用。
    await expect(pageC.getByTestId('undo-btn')).toBeDisabled({ timeout: 5_000 });
    // 投影仍是当前黑场帧。
    await expect(projector.getByTestId('blackout-view')).toBeVisible();
  });
});
