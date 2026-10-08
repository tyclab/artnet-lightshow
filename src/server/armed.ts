// Only output.setArmed() writes this flag because arming also changes output sessions.

let armed = false;
const disarmListeners = new Set<() => void>();

function onDisarm(listener: () => void): void { disarmListeners.add(listener); }

function isArmed(): boolean { return armed; }

function setArmedFlag(on: boolean): boolean {
  if (!on) for (const listener of disarmListeners) listener();
  if (armed === on) return false;
  armed = on;
  return true;
}

export { isArmed, setArmedFlag, onDisarm };
