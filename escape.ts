/**
 * One Escape closes one thing: the most recently opened Radar surface (Filter, Hidden list,
 * track box, review sheet). Surfaces register while open; a keypress something else already
 * handled (defaultPrevented, e.g. a composer popover) is left alone.
 */
export type EscapeKey = { key: string; defaultPrevented: boolean; preventDefault(): void };

export function createEscapeStack() {
  const stack: Array<() => void> = [];
  return {
    /** Register a handler; returns the unregister function. */
    push(handler: () => void): () => void {
      const entry = () => handler();
      stack.push(entry);
      return () => {
        const index = stack.lastIndexOf(entry);
        if (index >= 0) stack.splice(index, 1);
      };
    },
    get size() {
      return stack.length;
    },
    /** Runs the top handler; true when the key was consumed. */
    handle(event: EscapeKey): boolean {
      if (event.key !== "Escape" || event.defaultPrevented) return false;
      const top = stack[stack.length - 1];
      if (top === undefined) return false;
      event.preventDefault();
      top();
      return true;
    },
  };
}
