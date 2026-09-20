/** Distribute free rows evenly after honoring each card's minimum. */
export function bodyBudgets(minimums: readonly number[], available: number): number[] {
  const budgets = [...minimums];
  let spare = Math.max(0, available - budgets.reduce((sum, n) => sum + n, 0));
  if (!budgets.length) return budgets;
  const each = Math.floor(spare / budgets.length);
  spare %= budgets.length;
  return budgets.map((minimum, index) => minimum + each + (index < spare ? 1 : 0));
}
