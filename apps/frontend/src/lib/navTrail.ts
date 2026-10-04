'use client';

/**
 * The pages this tab has visited inside the app, so Back returns to where the
 * user actually came from (My Schedule → My Workload → Back = My Schedule).
 *
 * Kept per tab in sessionStorage, so a reload keeps it. With no earlier page
 * (a link opened fresh, e.g. from Messenger) Back goes to the user's home page
 * instead of leaving the app.
 */

import { useEffect } from 'react';

const KEY = 'qrganize:nav-trail';
const MAX = 30;

let trail: string[] | null = null;
let home = '/';

function read(): string[] {
  if (trail) return trail;
  try {
    const saved = JSON.parse(sessionStorage.getItem(KEY) ?? '[]');
    trail = Array.isArray(saved) ? saved.filter((p): p is string => typeof p === 'string') : [];
  } catch {
    trail = [];
  }
  return trail;
}

function save(t: string[]) {
  trail = t.slice(-MAX);
  try { sessionStorage.setItem(KEY, JSON.stringify(trail)); } catch { /* storage unavailable */ }
}

function recordVisit(path: string) {
  const t = [...read()];
  if (t[t.length - 1] === path) return;        // reload, or the same page again
  if (t[t.length - 2] === path) t.pop();       // went back one page
  else t.push(path);
  save(t);
}

/** Shells call this: records each page and remembers where "home" is for this role. */
export function useNavTrail(pathname: string, homeHref: string) {
  useEffect(() => { home = homeHref; }, [homeHref]);
  useEffect(() => { recordVisit(pathname); }, [pathname]);
}

/** 'back' when the previous page in this tab is part of the app, otherwise the home page to open. */
export function backTarget(): 'back' | string {
  const t = read();
  const canGoBack = t.length > 1 && typeof window !== 'undefined' && window.history.length > 1;
  return canGoBack ? 'back' : home;
}
