/** Orders project updates around an in-flight workspace snapshot. */
export function createProjectHydrationBuffer<Update>() {
  let active: { updates: Update[] } | null = null;

  return {
    begin() {
      const hydration = { updates: [] as Update[] };
      active = hydration;
      return hydration;
    },
    buffer(update: Update): boolean {
      if (!active) return false;
      active.updates.push(update);
      return true;
    },
    commit(
      hydration: { updates: Update[] },
      applySnapshot: () => void,
      applyUpdate: (update: Update) => void,
    ): boolean {
      if (active !== hydration) return false;
      active = null;
      applySnapshot();
      for (const update of hydration.updates) applyUpdate(update);
      return true;
    },
    cancel(hydration: { updates: Update[] }): void {
      if (active === hydration) active = null;
    },
  };
}
