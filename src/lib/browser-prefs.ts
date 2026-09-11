// Browser preference storage: notification settings, etc.

export const NOTIFY_KEY = "harness.notifyInBrowser";

export function isNotifyEnabled(): boolean {
  try {
    const value = localStorage.getItem(NOTIFY_KEY);
    return value === "true";
  } catch {
    return false;
  }
}

export function setNotifyEnabled(on: boolean): void {
  try {
    if (on) {
      localStorage.setItem(NOTIFY_KEY, "true");
    } else {
      localStorage.removeItem(NOTIFY_KEY);
    }
  } catch {
    // Silently fail if localStorage is unavailable (private browsing, etc.)
  }
}
