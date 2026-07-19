export const CAT_FRAME_DURATION_MS = 160;
export const CAT_WIDTH = 12;
export const CAT_HEIGHT = 3;

/**
 * Compact Braille line-art poses for the sitting cat.
 */
export const CAT_POSES = [
  [
    "  ⡠⡪⠕⢀⣀⢰⠑⠔⢱",
    "  ⢇⡣⢴⠁⢄⠫⠬⡪⡬⠂",
    "   ⠈⠉⠒⠒⠓⠒⠚⠚",
  ],
  [
    "  ⡠⡪⠕⢀⣀⢰⠑⠔⢱",
    "  ⢇⡣⢴⠁⢄⠫⠤⡢⡬⠂",
    "   ⠈⠉⠒⠒⠓⠒⠚⠚",
  ],
  [
    "  ⡎⡆ ⢀⣀⢰⠑⠔⢱",
    "  ⡇⠧⢴⠁⢄⠫⠬⡪⡬⠂",
    "  ⠈⠉⠉⠒⠒⠓⠒⠚⠚",
  ],
  [
    "  ⡎⡆ ⢀⣀⢰⠑⠔⢱",
    "  ⡇⠧⢴⠁⢄⠫⠤⡱⡭⠂",
    "  ⠈⠉⠉⠒⠒⠓⠒⠚⠚",
  ],
  [
    "⠐⠭⡢⡀ ⢀⣀⢰⠑⠔⢱",
    "  ⢇⡣⢴⠁⢄⠫⠤⡱⡭⠂",
    "   ⠈⠉⠒⠒⠓⠒⠚⠚",
  ],
  [
    "  ⡎⡆ ⢀⣀⢠⠢⡠⢢",
    "  ⡇⠧⢴⠁⢄⢝⣀⣢⣚⠄",
    "  ⠈⠉⠉⠒⠒⠓⠒⠚⠚",
  ],
  [
    "  ⡠⡪⠕⢀⣀⢠⠢⡠⢢",
    "  ⢇⡣⢴⠁⢄⢝⣀⣢⣚⠄",
    "   ⠈⠉⠒⠒⠓⠒⠚⠚",
  ],
  [
    "  ⡠⡪⠕⢀⣀⢠⠢⡠⢢",
    "  ⢇⡣⢴⠁⢄⢝⣀⣠⣘⠄",
    "   ⠈⠉⠒⠒⠓⠒⠚⠚",
  ],
  [
    "⠐⠭⡢⡀ ⢀⣀⢠⠢⡠⢢",
    "  ⢇⡣⢴⠁⢄⢝⣀⣢⣚⠄",
    "   ⠈⠉⠒⠒⠓⠒⠚⠚",
  ],
] as const;

/** Animation order, including held frames. */
export const CAT_FRAME_SEQUENCE = [
  0, 1, 0, 0, 2, 3, 3, 4, 4, 3, 3, 5, 5, 6, 7, 6, 6, 5, 5, 8, 8, 4, 4, 3, 2, 2, 0,
] as const;

export function getCatPose(frameIndex: number): readonly string[] {
  const normalized = ((Math.trunc(frameIndex) % CAT_FRAME_SEQUENCE.length) + CAT_FRAME_SEQUENCE.length)
    % CAT_FRAME_SEQUENCE.length;
  return CAT_POSES[CAT_FRAME_SEQUENCE[normalized]!]!;
}
