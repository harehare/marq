/**
 * try / catch / finally for event handlers in components. React Compiler cannot compile `finally`
 * (it leaves the whole component unoptimized), so handlers call this instead. Without `onError`, the
 * error is thrown on, as it would be without a catch.
 */
export async function attempt(work: () => Promise<unknown>, onError?: (e: unknown) => void, done?: () => void): Promise<void> {
  try {
    await work();
  } catch (e) {
    if (!onError) throw e;
    onError(e);
  } finally {
    done?.();
  }
}
