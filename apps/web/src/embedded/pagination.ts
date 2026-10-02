export function canAutoAppend(target: Pick<HTMLElement, "scrollTop" | "scrollHeight" | "clientHeight">, state: { busy: boolean; pending: boolean; error: boolean; hasMore: boolean; capacityReached: boolean }): boolean {
  return !state.busy && !state.pending && !state.error && state.hasMore && !state.capacityReached
    && target.scrollTop > 0 && target.scrollHeight - target.clientHeight - target.scrollTop < 200;
}
