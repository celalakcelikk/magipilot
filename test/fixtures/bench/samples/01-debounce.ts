/**
 * Small timing helpers used by the editor integration.
 */

export type Callback<A extends unknown[]> = (...args: A) => void;

export interface Debounced<A extends unknown[]> {
  (...args: A): void;
  cancel(): void;
  flush(): void;
}

/**
 * Returns a function that delays invoking `fn` until `waitMs` milliseconds have elapsed
 * since the last time the debounced function was invoked.
 */
export function debounce<A extends unknown[]>(fn: Callback<A>, waitMs: number): Debounced<A> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pendingArgs: A | undefined;

  const debounced = ((...args: A) => {
    pendingArgs = args;
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    <FILL>timer = setTimeout(() => {
      timer = undefined;
      const callArgs = pendingArgs;
      pendingArgs = undefined;
      if (callArgs) {
        fn(...callArgs);
      }
    }, waitMs);</FILL>
  }) as Debounced<A>;

  debounced.cancel = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    pendingArgs = undefined;
  };

  debounced.flush = () => {
    if (timer !== undefined && pendingArgs) {
      clearTimeout(timer);
      timer = undefined;
      const callArgs = pendingArgs;
      pendingArgs = undefined;
      fn(...callArgs);
    }
  };

  return debounced;
}
