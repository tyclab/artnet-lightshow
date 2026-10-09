// Disarm an arm left with nothing playing, so a forgotten arm does not keep the rig's lamps from the house.

export interface IdleDisarmDeps {
  /** The clock, in milliseconds (monotonic). */
  now: () => number;
  armed: () => boolean;
  playing: () => boolean;
  /** The limit in minutes; 0 never disarms. */
  minutes: () => number;
  disarm: (minutes: number) => void;
}

export interface IdleDisarm {
  tick(): void;
}

function createIdleDisarm({ now, armed, playing, minutes, disarm }: IdleDisarmDeps): IdleDisarm {
  let idleSince: number | null = null;

  return {
    tick() {
      const limit = minutes();
      if (!armed() || playing() || limit === 0) {
        idleSince = null;
        return;
      }
      const at = now();
      idleSince ??= at;
      if (at - idleSince < limit * 60_000) return;
      idleSince = Infinity;   // once per idle period: only a reset above starts the next
      disarm(limit);
    },
  };
}

export {
  createIdleDisarm,
};
