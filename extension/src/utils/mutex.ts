// Serializes async critical sections. storage.local/session have no
// transactions, so two concurrent read-modify-write cycles (a recorded step
// arriving while a navigation step is appended, a sync merge racing a save)
// would otherwise silently drop one of the writes.
export const createMutex = () => {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  };
};
