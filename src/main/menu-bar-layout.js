const MENU_BAR_POPOVER_SIZE = Object.freeze({
  width: 344,
  height: 566
});

const THEME_MENU_SIZE = Object.freeze({
  width: 514,
  height: 358
});

function calculateThemeMenuPosition(parentBounds, themeBounds, workArea, anchorTop) {
  const rightX = parentBounds.x + parentBounds.width + 6;
  const rightLimit = workArea.x + workArea.width - themeBounds.width - 8;
  const x = rightX <= rightLimit ? rightX : Math.max(workArea.x + 8, parentBounds.x - themeBounds.width - 6);
  const desiredY = parentBounds.y + anchorTop - 2;
  const y = Math.max(
    workArea.y + 8,
    Math.min(workArea.y + workArea.height - themeBounds.height - 8, desiredY)
  );
  return { x: Math.round(x), y: Math.round(y) };
}

module.exports = { calculateThemeMenuPosition, MENU_BAR_POPOVER_SIZE, THEME_MENU_SIZE };
