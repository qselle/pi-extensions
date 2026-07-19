export function removeTerminalControls(value: string): string {
  return value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b_[^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\r\n]/g, "");
}

export function containsTerminalText(value: string): boolean {
  return removeTerminalControls(value).trim().length > 0;
}

export function isEditorBorder(value: string, columns: number): boolean {
  const plain = removeTerminalControls(value).trim();
  if ([...plain].length < columns - 2) return false;
  return /^─+$/.test(plain) || /^─── [↑↓] \d+ more ─*$/.test(plain);
}

export function findEditorTopBorder(
  frame: readonly string[],
  visibleFrom: number,
  columns: number,
  rows: number,
): number | undefined {
  let lowerBorder: number | undefined;
  const largestEditorSpan = Math.max(5, Math.floor(rows * 0.3)) + 1;

  for (let row = frame.length - 1; row >= visibleFrom; row--) {
    if (!isEditorBorder(frame[row] ?? "", columns)) continue;
    if (lowerBorder === undefined) {
      lowerBorder = row;
      continue;
    }

    const span = lowerBorder - row;
    if (span > largestEditorSpan) return undefined;
    if (span >= 2) return row;
  }
  return undefined;
}

export function rightEdgeRange(columns: number, width: number, rightMargin: number): {
  left: number;
  right: number;
} {
  const left = Math.max(0, columns - width - rightMargin);
  return { left, right: left + width };
}
