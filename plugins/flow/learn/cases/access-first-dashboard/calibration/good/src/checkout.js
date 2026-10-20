// Checkout totals. Deployed yesterday with the new line-item discounts.
export function total(items) {
  return items.reduce((sum, item) => sum + item.price * item.qty * (1 - (item.discount ?? 0)), 0);
}
