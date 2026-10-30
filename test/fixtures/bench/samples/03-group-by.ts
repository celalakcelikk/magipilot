export interface Order {
  id: string;
  customerId: string;
  total: number;
  createdAt: Date;
}

/**
 * Groups items by the key returned from `keyOf`, preserving input order inside each group.
 */
export function groupBy<T, K extends PropertyKey>(items: readonly T[], keyOf: (item: T) => K): Record<K, T[]> {
  return items.reduce(
    (groups, item) => {
      const key = keyOf(item);
      <FILL>(groups[key] ??= []).push(item);</FILL>
      return groups;
    },
    {} as Record<K, T[]>,
  );
}

export function totalsByCustomer(orders: readonly Order[]): Map<string, number> {
  const grouped = groupBy(orders, (order) => order.customerId);
  const totals = new Map<string, number>();
  for (const [customerId, customerOrders] of Object.entries(grouped)) {
    totals.set(
      customerId,
      customerOrders.reduce((sum, order) => sum + order.total, 0),
    );
  }
  return totals;
}
