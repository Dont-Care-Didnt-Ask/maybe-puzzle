import { expect, test } from '@playwright/test';
import { makeAssets } from './data-fixtures.js';

test('preview themes before starting and use the selected appearance in training', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const { files } = makeAssets();
  await page.route('**/training/**', (route) => {
    const file = route.request().url().split('/training/')[1];
    const body = files.get(file);
    return body ? route.fulfill({ body: Buffer.from(body), contentType: file.endsWith('.gz') ? 'application/gzip' : 'application/json' }) : route.abort();
  });
  await page.goto('./');
  await expect(page.locator('#start')).toBeEnabled();
  await expect(page.getByText('A chess training experiment', { exact: true })).toHaveCount(0);
  await expect(page.locator('#data-status')).toHaveText(/^[\d,]+ puzzles · [\d,]+ ordinary positions$/);
  await expect(page.locator('.intro #appearance')).toHaveCount(1);
  await page.locator('#appearance summary').click();
  const preview = page.locator('#theme-preview');
  await expect(preview.locator('piece')).toHaveCount(32);
  const original = await preview.locator('cg-board').evaluate((board) => getComputedStyle(board).backgroundImage);
  for (const board of ['blue', 'green', 'grey']) {
    await page.locator(`#board-theme [data-theme=${board}]`).click();
    await expect(page.locator('html')).toHaveAttribute('data-board-theme', board);
    expect(await preview.locator('cg-board').evaluate((board) => getComputedStyle(board).backgroundImage)).not.toBe(original);
  }
  for (const pieces of ['merida', 'chessnut']) {
    await page.locator(`#piece-theme [data-theme=${pieces}]`).click();
    const image = await preview.locator('piece.white.king').evaluate((piece) => getComputedStyle(piece).backgroundImage);
    expect(image).toContain(`/themes/pieces/${pieces}/wK.svg`);
  }
  // Keyboard focus previews an option without committing it.
  await page.locator('#piece-theme [data-theme=merida]').focus();
  await expect(preview).toHaveAttribute('aria-label', 'grey board with merida pieces preview');
  await page.locator('#anchor').focus();
  await expect(preview).toHaveAttribute('aria-label', 'grey board with chessnut pieces preview');
  await expect(page.locator('#piece-theme [data-theme=chessnut]')).toHaveAttribute('aria-pressed', 'true');
  if (test.info().project.name === 'desktop') {
    await page.locator('#board-theme [data-theme=blue]').hover();
    await expect(preview).toHaveAttribute('aria-label', 'blue board with chessnut pieces preview');
    await page.locator('#setup-title').hover();
    await expect(preview).toHaveAttribute('aria-label', 'grey board with chessnut pieces preview');
  }
  await page.locator('[name=ratio_mode][value=fixed]').check();
  await page.locator('#fraction').evaluate((input) => { input.value = '0'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.locator('#start').click();
  await expect(page.locator('#training')).toBeVisible();
  await expect(page.locator('#next')).toBeEnabled();
  await expect(page.locator('html')).toHaveAttribute('data-board-theme', 'grey');
  await expect(page.locator('html')).toHaveAttribute('data-piece-theme', 'chessnut');
  const image = await page.locator('#board piece.white.king').evaluate((piece) => getComputedStyle(piece).backgroundImage);
  expect(image).toContain('/themes/pieces/chessnut/wK.svg');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
  expect(errors).toEqual([]);
});
