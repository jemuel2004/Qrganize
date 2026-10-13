/**
 * PATHFIT classes meet only in the department's two PATHFIT venues: the CCA
 * Gym and the SAO Room (stored as "Sao"). No other room, lecture or
 * laboratory, may hold them.
 *
 * Venues are recognised by room name. Every path that gives a class a room
 * uses these checks: Scheduling's save and conflict preview, Rooms → Classes
 * Without a Room, the Excel workload import and faculty room requests.
 */

const nameKey = (value: unknown) => String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** PATH-FIT 1, PATHFIT 3, "Path Fit 2" … */
export function isPathfitSubject(subjectCode: unknown): boolean {
  return nameKey(subjectCode).startsWith('PATHFIT');
}

/** The permitted venues, as people name them */
export const PATHFIT_VENUE_NAMES = ['CCA Gym', 'SAO Room'] as const;

const VENUE_KEYS = new Set(['CCAGYM', 'SAO', 'SAOROOM']);

/** True for the CCA Gym and the SAO Room ("Sao", "SAO Room", "cca gym" …) */
export function isPathfitVenue(roomName: unknown): boolean {
  return VENUE_KEYS.has(nameKey(roomName));
}

/** May this room hold this subject? Only the PATHFIT rule — room types are checked separately. */
export function pathfitRoomAllowed(subjectCode: unknown, roomName: unknown): boolean {
  return !isPathfitSubject(subjectCode) || isPathfitVenue(roomName);
}

export const PATHFIT_VENUE_RULE = `PATHFIT classes may only use the ${PATHFIT_VENUE_NAMES.join(' or the ')}.`;
