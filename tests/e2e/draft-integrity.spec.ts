import { expect, test, type Page } from '@playwright/test';
import { resetStorage } from './helpers';

test.use({ storageState: { cookies: [], origins: [] } });

interface StoredCue {
  id: string;
  kind: 'subtitle' | 'blackout';
  source: string;
  translation: string;
  note: string;
}
interface StoredProgram {
  cues: StoredCue[];
  draftRev: number;
  updatedAt: number;
  frozenAt?: number;
}

/**
 * 直接读 IndexedDB 中某个键的持久值（与页面缓存无关，作为存档真相）。
 * 以与应用相同的版本打开：库尚不存在（例如 resetStorage 后应用尚未首次打开）
 * 时，绝不能替它创建一个没有 kv 仓的空库——那会让应用随后的 open(v1)
 * 因不再触发 upgradeneeded 而连到无仓数据库；这里在升级中补上同样的 kv 仓。
 */
async function readKv<T>(page: Page, key: string): Promise<T | null> {
  return page.evaluate(
    (k) =>
      new Promise<T | null>((resolve, reject) => {
        const req = indexedDB.open('opera-prompter', 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('kv')) {
            db.createObjectStore('kv', { keyPath: 'key' });
          }
        };
        req.onsuccess = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('kv')) {
            db.close();
            resolve(null);
            return;
          }
          const tx = db.transaction('kv', 'readonly');
          const getReq = tx.objectStore('kv').get(k);
          getReq.onsuccess = () => {
            const rec = getReq.result as { value: T } | undefined;
            db.close();
            resolve(rec?.value ?? null);
          };
          getReq.onerror = () => {
            db.close();
            reject(getReq.error);
          };
        };
        req.onerror = () => reject(req.error);
      }),
    key,
  );
}

/**
 * 非抛出式读取辅助：expect.poll 的回调一旦抛错会立即终止整个断言
 * （不重试），因此在“可能尚未写入”的窗口期只返回 null，绝不能抛错。
 */
async function draftSource(page: Page): Promise<string | null> {
  const draft = await readKv<StoredProgram>(page, 'draft');
  return draft?.cues[0]?.source ?? null;
}

async function draftTranslation(page: Page): Promise<string | null> {
  const draft = await readKv<StoredProgram>(page, 'draft');
  return draft?.cues[0]?.translation ?? null;
}

/**
 * 工作站 A 保存“一条字幕（Aria uno）”，并在第二页 B 打开同一份草稿。
 * 返回两个页面；此时 A、B 都基于同一持久版本 rev 2。
 */
async function openTwoEditorsOnSameDraft(a: Page, b: Page): Promise<void> {
  await a.getByRole('button', { name: '＋ 双语字幕' }).click();
  await a
    .getByTestId('cue-card')
    .locator('[data-field="source"]')
    .fill('Aria uno');
  await expect
    .poll(() => draftSource(a))
    .toBe('Aria uno');

  await b.goto('/#/edit');
  await expect(
    b.getByTestId('cue-card').locator('[data-field="source"]'),
  ).toHaveValue('Aria uno');
}

test.describe('切页时机：未落盘修改不丢失', () => {
  test.beforeEach(async ({ page }) => {
    await resetStorage(page);
  });

  test('修改后立刻切页：重开编辑页、库内存档与整页刷新逐项一致', async ({
    page,
  }) => {
    await page.goto('/#/edit');
    await page.getByRole('button', { name: '＋ 双语字幕' }).click();
    const firstCard = page.getByTestId('cue-card');
    await firstCard.locator('[data-field="source"]').fill('Va, pensiero');
    await firstCard.locator('[data-field="translation"]').fill('飞吧，思想');
    await page.getByRole('button', { name: '＋ 黑场提示' }).click();
    // 最后一次输入后立刻切页（400ms 防抖不可能已经触发）。
    await page
      .getByTestId('cue-card')
      .nth(1)
      .getByPlaceholder('舞台备注（仅控制端可见）')
      .fill('幕间黑场 10 秒');

    // 立刻切到放行（开演）页面：编辑器卸载时必须先把未落盘内容落盘。
    await page.getByRole('link', { name: '开演控制台' }).click();
    await expect(page.getByTestId('status-line')).toBeVisible();

    // 切回编辑页：刚才的修改必须逐项还在。
    await page.getByRole('link', { name: '编辑节目单' }).click();
    const cards = page.getByTestId('cue-card');
    await expect(cards).toHaveCount(2);
    await expect(cards.nth(0).locator('[data-field="source"]')).toHaveValue(
      'Va, pensiero',
    );
    await expect(cards.nth(0).locator('[data-field="translation"]')).toHaveValue(
      '飞吧，思想',
    );
    await expect(
      cards.nth(1).getByPlaceholder('舞台备注（仅控制端可见）'),
    ).toHaveValue('幕间黑场 10 秒');

    // 存档（draft 键）与编辑页逐项一致，顺序也一致。
    const draft = await readKv<StoredProgram>(page, 'draft');
    expect(draft).not.toBeNull();
    expect(draft?.cues).toHaveLength(2);
    expect(draft?.cues[0].kind).toBe('subtitle');
    expect(draft?.cues[0].source).toBe('Va, pensiero');
    expect(draft?.cues[0].translation).toBe('飞吧，思想');
    expect(draft?.cues[1].kind).toBe('blackout');
    expect(draft?.cues[1].note).toBe('幕间黑场 10 秒');

    // 整页刷新后依然一致（不是内存残留）。
    await page.reload();
    await expect(page.getByTestId('cue-card')).toHaveCount(2);
    await expect(
      page.getByTestId('cue-card').nth(0).locator('[data-field="source"]'),
    ).toHaveValue('Va, pensiero');
  });
});

test.describe('两处编辑交错：后保存的旧内容不覆盖已确认新内容', () => {
  test('后保存方收到冲突、已确认内容保留；载入最新后继续编辑可保存', async ({
    context,
  }) => {
    const a = await context.newPage();
    const b = await context.newPage();
    await resetStorage(a);
    await openTwoEditorsOnSameDraft(a, b);

    // A 先确认新版本（rev 3）。
    await a
      .getByTestId('cue-card')
      .locator('[data-field="source"]')
      .fill('Aria uno v2');
    await expect
      .poll(() => draftSource(a))
      .toBe('Aria uno v2');

    // B 基于同一旧版本继续校对并保存：必须报冲突，而不是静默覆盖。
    await b
      .getByTestId('cue-card')
      .locator('[data-field="translation"]')
      .fill('译文来自B');
    await expect(b.getByTestId('conflict-banner')).toBeVisible();

    // 存档仍是 A 已确认的内容，B 的旧内容没有落进去。
    let archived = await readKv<StoredProgram>(a, 'draft');
    expect(archived?.draftRev).toBe(3);
    expect(archived?.cues[0].source).toBe('Aria uno v2');
    expect(archived?.cues[0].translation).toBe('');

    // B 不显示“保存成功”，且未解决冲突前不能放行。
    await expect(b.getByTestId('save-state')).toHaveText(
      '版本冲突：本页修改未保存',
    );
    await expect(b.getByTestId('adopt-button')).toBeDisabled();

    // A 不受影响：无冲突提示，版本号仍是 3。
    await expect(a.getByTestId('conflict-banner')).toHaveCount(0);
    await expect(a.getByTestId('draft-rev')).toHaveText('草稿版本 3');

    // B 显式选择“载入最新”：屏幕切到 A 的已确认版本，B 的未保存修改放弃。
    await b.getByTestId('conflict-reload').click();
    await expect(b.getByTestId('conflict-banner')).toHaveCount(0);
    await expect(
      b.getByTestId('cue-card').locator('[data-field="source"]'),
    ).toHaveValue('Aria uno v2');
    await expect(
      b.getByTestId('cue-card').locator('[data-field="translation"]'),
    ).toHaveValue('');

    // B 在最新版本上继续校对：保存成功，版本单调推进到 4。
    await b
      .getByTestId('cue-card')
      .locator('[data-field="translation"]')
      .fill('译文最终版');
    await expect(b.getByTestId('draft-rev')).toHaveText('草稿版本 4');
    await expect
      .poll(() => draftTranslation(b))
      .toBe('译文最终版');

    // B 整页刷新：存档内容与版本不变，A 的新内容和 B 的后续校对都在。
    await b.reload();
    await expect(
      b.getByTestId('cue-card').locator('[data-field="source"]'),
    ).toHaveValue('Aria uno v2');
    await expect(
      b.getByTestId('cue-card').locator('[data-field="translation"]'),
    ).toHaveValue('译文最终版');
    await expect(b.getByTestId('draft-rev')).toHaveText('草稿版本 4');

    archived = await readKv<StoredProgram>(b, 'draft');
    expect(archived?.draftRev).toBe(4);
  });

  test('冲突后显式“用本页内容覆盖”：本页内容成为新版本，版本号单调', async ({
    context,
  }) => {
    const a = await context.newPage();
    const b = await context.newPage();
    await resetStorage(a);
    await openTwoEditorsOnSameDraft(a, b);

    // A 改原文并保存（rev 3）。
    await a
      .getByTestId('cue-card')
      .locator('[data-field="source"]')
      .fill('Aria uno v2');
    await expect
      .poll(() => draftSource(a))
      .toBe('Aria uno v2');

    // B 改译文，保存冲突。
    await b
      .getByTestId('cue-card')
      .locator('[data-field="translation"]')
      .fill('译文来自B');
    await expect(b.getByTestId('conflict-banner')).toBeVisible();

    // 舞台监督明确选择以 B 为准：覆盖是显式动作，不是静默发生。
    await b.getByTestId('conflict-overwrite').click();
    await expect(b.getByTestId('conflict-banner')).toHaveCount(0);
    await expect(b.getByTestId('draft-rev')).toHaveText('草稿版本 4');
    await expect
      .poll(() => draftTranslation(b))
      .toBe('译文来自B');
    // 覆盖基于对方版本号推进，不回退版本。
    const archived = await readKv<StoredProgram>(b, 'draft');
    expect(archived?.draftRev).toBe(4);
    expect(archived?.cues[0].source).toBe('Aria uno'); // B 基于 rev 2 的屏幕内容
    expect(archived?.cues[0].translation).toBe('译文来自B');
  });
});

test.describe('一次持久化失败后放行：不冻结未持久化草稿，不半更新', () => {
  test.beforeEach(async ({ page }) => {
    // 注入一次针对 draft 键的写盘失败：只失败一次，随后自动恢复。
    await page.addInitScript(() => {
      const proto = IDBObjectStore.prototype;
      const orig = proto.put;
      proto.put = function (
        this: IDBObjectStore,
        ...args: Parameters<IDBObjectStore['put']>
      ) {
        const w = window as unknown as Record<string, unknown>;
        const [value] = args;
        const rec = value as { key?: string } | undefined;
        if (w.__failNextDraftPut === true && rec && rec.key === 'draft') {
          w.__failNextDraftPut = false;
          w.__draftPutFailures =
            typeof w.__draftPutFailures === 'number'
              ? w.__draftPutFailures + 1
              : 1;
          throw new DOMException('注入的写盘失败（测试）', 'UnknownError');
        }
        return orig.apply(this, args);
      };
    });
    await resetStorage(page);
  });

  test('保存失败后继续编辑并放行：编辑页 / 存档 / 放行页 / 重开一致且同版本', async ({
    page,
  }) => {
    await page.goto('/#/edit');
    await page.getByRole('button', { name: '＋ 双语字幕' }).click();
    const card = page.getByTestId('cue-card');
    await card.locator('[data-field="source"]').fill('Coro');
    await card.locator('[data-field="translation"]').fill('合唱');
    await expect
      .poll(() => draftSource(page))
      .toBe('Coro');

    // 武装一次写盘失败，再修改原文：自动保存失败、明确报错，不落盘。
    await page.evaluate(() => {
      (window as unknown as { __failNextDraftPut: boolean }).__failNextDraftPut =
        true;
    });
    await card.locator('[data-field="source"]').fill('Coro modificato');
    await expect(page.getByText('草稿保存失败')).toBeVisible();
    await expect(page.getByTestId('save-state')).toHaveText('有未保存的修改');
    expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).__draftPutFailures)).toBe(1);

    // 存档确认停留在旧内容：没有半更新。
    let draft = await readKv<StoredProgram>(page, 'draft');
    expect(draft?.cues[0].source).toBe('Coro');

    // 失败后立刻继续编辑并放行（点击速度快于 400ms 防抖）。
    await card.locator('[data-field="translation"]').fill('合唱改');
    await page.getByTestId('adopt-button').click();
    await expect(page.getByTestId('frozen-banner')).toBeVisible();

    // 编辑页、存档、放行快照引用同一版本（rev 5），内容逐项一致。
    await expect(page.getByTestId('draft-rev')).toHaveText('草稿版本 5');
    draft = await readKv<StoredProgram>(page, 'draft');
    const frozen = await readKv<StoredProgram>(page, 'frozen');
    expect(draft?.draftRev).toBe(5);
    expect(frozen?.draftRev).toBe(5);
    expect(draft?.cues).toEqual(frozen?.cues);
    expect(draft?.cues[0]).toMatchObject({
      source: 'Coro modificato',
      translation: '合唱改',
    });
    await expect(page.getByTestId('frozen-banner')).toContainText(
      '对应草稿版本 5',
    );

    // 放行（开演）页显示的必须是本次确认的在演版本，不是旧草稿。
    await page.goto('/#/stage');
    await expect(page.getByTestId('status-line')).toContainText('唯一操控者');
    const runs = page.getByTestId('cue-run');
    await expect(runs).toHaveCount(1);
    await expect(runs.first()).toContainText('Coro modificato');
    await expect(runs.first()).toContainText('合唱改');
    // 放行页可追溯到与存档相同的草稿版本。
    await expect(page.getByTestId('frozen-version')).toContainText(
      '对应草稿版本 5',
    );

    // 重新打开草稿：与现场（在演）版本一致，不出现“现场是新的、草稿是旧的”。
    await page.goto('/#/edit');
    await expect(page.getByTestId('cue-card')).toHaveCount(1);
    await expect(
      page.getByTestId('cue-card').locator('[data-field="source"]'),
    ).toHaveValue('Coro modificato');
    await expect(
      page.getByTestId('cue-card').locator('[data-field="translation"]'),
    ).toHaveValue('合唱改');
    await expect(page.getByTestId('draft-rev')).toHaveText('草稿版本 5');
    await expect(page.getByTestId('frozen-banner')).toContainText(
      '对应草稿版本 5',
    );
  });
});
