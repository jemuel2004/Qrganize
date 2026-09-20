/**
 * Shared Framer Motion presets for admin navigation chrome.
 * Soft, premium micro-interactions (Vercel / Linear style).
 */

export const NAV_EASE = [0.16, 1, 0.3, 1] as const; // easeOut-ish cubic
export const NAV_DURATION = 0.2;
export const NAV_DURATION_FAST = 0.18;

export const navItemHover = {
  y: -2,
  scale: 1.03,
  transition: { duration: NAV_DURATION, ease: NAV_EASE },
};

export const navItemTap = {
  scale: 0.98,
  transition: { duration: NAV_DURATION_FAST, ease: NAV_EASE },
};

export const dropdownVariants = {
  hidden: {
    opacity: 0,
    y: -12,
    scale: 0.96,
  },
  visible: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: {
      duration: NAV_DURATION,
      ease: NAV_EASE,
      when: 'beforeChildren' as const,
      staggerChildren: 0.03,
    },
  },
  exit: {
    opacity: 0,
    y: -8,
    scale: 0.98,
    transition: { duration: NAV_DURATION_FAST, ease: NAV_EASE },
  },
};

export const dropdownItemVariants = {
  hidden: { opacity: 0, x: -4 },
  visible: {
    opacity: 1,
    x: 0,
    transition: { duration: NAV_DURATION_FAST, ease: NAV_EASE },
  },
};

export const notificationListVariants = {
  hidden: {},
  visible: {
    transition: { staggerChildren: 0.04, delayChildren: 0.04 },
  },
};

export const notificationRowVariants = {
  hidden: { opacity: 0, y: -6 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: NAV_DURATION, ease: NAV_EASE },
  },
};

export const logoHover = {
  scale: 1.04,
  rotate: 3,
  transition: { duration: 0.2, ease: NAV_EASE },
};

export const logoTap = {
  scale: 0.96,
  transition: { duration: NAV_DURATION_FAST, ease: NAV_EASE },
};

export const instantTransition = { duration: 0 };
