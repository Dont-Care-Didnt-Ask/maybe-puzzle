import { expect, test } from '@playwright/test';

test('board and Lichess piece themes change live without changing the position', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('./');
  await expect(page.locator('#start')).toBeEnabled();
  await expect(page.getByText('Calculate without the guarantee.', { exact: true })).toHaveCount(0);
  await expect(page.getByText("The position doesn't tell you.", { exact: true })).toHaveCount(0);
  await page.locator('[name=ratio_mode][value=fixed]').check();
  await page.locator('#fraction').evaluate((input) => { input.value = '0'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.locator('#start').click();
  await expect(page.locator('#training')).toBeVisible();
  await expect(page.locator('#next')).toBeEnabled();
  const fen = await page.locator('#board').getAttribute('data-fen');
  const original = await page.locator('cg-board').evaluate((board) => getComputedStyle(board).backgroundImage);
  await page.locator('#appearance summary').click();
  for (const board of ['blue', 'green', 'grey']) {
    await page.locator('#board-theme').selectOption(board);
    await expect(page.locator('html')).toHaveAttribute('data-board-theme', board);
    expect(await page.locator('cg-board').evaluate((board) => getComputedStyle(board).backgroundImage)).not.toBe(original);
  }
  for (const pieces of ['merida', 'chessnut']) {
    const loaded = page.waitForResponse((response) => response.url().endsWith(`/themes/pieces/${pieces}/wK.svg`));
    await page.locator('#piece-theme').selectOption(pieces);
    expect((await loaded).status()).toBe(200);
    const image = await page.locator('#board piece.white.king').first().evaluate((piece) => getComputedStyle(piece).backgroundImage);
    expect(image).toContain(`/chess-puzzle-not-puzzle/themes/pieces/${pieces}/wK.svg`);
  }
  await page.locator('#board-theme').selectOption('brown');
  await page.locator('#piece-theme').selectOption('cburnett');
  expect(await page.locator('cg-board').evaluate((board) => getComputedStyle(board).backgroundImage)).toBe(original);
  await expect(page.locator('#board')).toHaveAttribute('data-fen', fen);
  await expect(page.locator('#position-number')).toHaveText('Position 1');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
  expect(errors).toEqual([]);
});
