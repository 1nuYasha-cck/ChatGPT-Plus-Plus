const test = require("node:test");
const assert = require("node:assert/strict");
const { calculateThemeMenuPosition, MENU_BAR_POPOVER_SIZE, THEME_MENU_SIZE } = require("../src/main/menu-bar-layout");

test("menu bar popover uses the narrow ChatGPT-style dimensions", () => {
  assert.deepEqual(MENU_BAR_POPOVER_SIZE, { width: 344, height: 566 });
  assert.deepEqual(THEME_MENU_SIZE, { width: 514, height: 358 });
});

test("theme menu aligns vertically with the clicked theme row and stays on screen", () => {
  const position = calculateThemeMenuPosition(
    { x: 1300, y: 30, width: 344, height: 555 },
    { width: 514, height: 264 },
    { x: 0, y: 0, width: 1728, height: 1000 },
    314.5
  );
  assert.deepEqual(position, { x: 780, y: 343 });
  assert.ok(position.y > 250, "theme menu should move down to the clicked row");

  const clamped = calculateThemeMenuPosition(
    { x: 1300, y: 700, width: 344, height: 555 },
    { width: 514, height: 264 },
    { x: 0, y: 0, width: 1728, height: 900 },
    314.5
  );
  assert.equal(clamped.y, 628);
});
