/*
 * What a room QR scan (POST /api/qr/scan) answered, and how to say it —
 * shared by Scan Room QR and the room page a phone camera opens, so both show
 * the same titles, messages and colours.
 */

export interface ScanResult {
  /** 'Error' (no answer) and 'SignedOut' (sign-in expired) are set by the page, not the server */
  status: 'In-Use' | 'Pending' | 'Valid' | 'Late' | 'Overuse' | 'Blocked' | 'Unauthorized' | 'Invalid' | 'Error' | 'SignedOut';
  /** Blocked: another faculty holds the room ('in_use'), the room is not theirs now ('not_assigned'),
   *  or a free room they can't use — only a class with no room may ('not_eligible'), the room doesn't
   *  suit the class ('wrong_room'), the class runs past the time the room is free until ('not_enough_time'),
   *  30 minutes or less of its free time are left ('too_late'), they already hold another room ('already_in_room'),
   *  or its freed class time hasn't started yet ('not_yet_free') */
  reason?: 'in_use' | 'not_assigned' | 'not_eligible' | 'wrong_room' | 'not_enough_time' | 'too_late' | 'already_in_room' | 'not_yet_free';
  scan_status?: 'Valid' | 'Late' | 'Overuse';
  message: string;
  scan_time: string;
  already_occupied?: boolean;
  /** ISO timestamp from room_occupancy.occupied_at when already checked in */
  checked_in_at?: string | null;
  room?: { id: number; name: string; type: string };
  schedule?: {
    subject_name: string;
    session_start: string | null;
    session_end: string | null;
    block_name: string;
    program_code?: string;
  };
  occupancy?: { faculty_name: string; status: string; expires_at?: string | null };
  occupancy_status?: 'Pending' | 'Occupied';
  authorized_faculty?: string;
  available_rooms?: { id: number; room_name: string; room_type: string; building: string | null }[];
  expires_in_mins?: number;
  error?: string;
}


export type ModalKind =
  | 'success'
  | 'already'
  | 'pending'
  | 'late'
  | 'in_use'
  | 'not_assigned'
  | 'invalid'
  | 'overuse'
  | 'error'
  | 'signed_out';

/**
 * What the button does. 'close' only dismisses — the camera keeps running and
 * the same QR is not read again until it has left the camera's view; 'retry'
 * reads the same QR again (no answer came back); 'sign_in' goes to the sign-in page.
 */
export type ScanAction = 'close' | 'retry' | 'sign_in';

export interface ModalPresentation {
  kind: ModalKind;
  title: string;
  message: string;
  buttonLabel: string;
  action: ScanAction;
  tone: 'success' | 'warning' | 'danger' | 'neutral' | 'info';
}

/** The room is not the faculty's at this time (checked by the server) — the same words wherever it shows */
export const NOT_ASSIGNED_MESSAGE =
  'You are not scheduled to use this room at the selected time. Please check your class schedule or scan the QR code of your assigned room.';

/** Titles for a free room the faculty can't use (the message comes from the server) */
const FREE_ROOM_TITLE = {
  not_eligible: 'Room Not Available',
  wrong_room: 'Wrong Kind of Room',
  not_enough_time: 'Not Enough Time',
  too_late: 'Too Little Time Left',
  already_in_room: 'You Already Have a Room',
  not_yet_free: 'Not Free Yet',
} as const;

export function presentScanResult(result: ScanResult): ModalPresentation {
  if (result.status === 'Error') {
    return {
      kind: 'error',
      title: 'Connection Problem',
      message: "We couldn't check this room. Check your internet connection, then try again.",
      buttonLabel: 'Try Again',
      action: 'retry',
      tone: 'danger',
    };
  }
  if (result.status === 'SignedOut') {
    return {
      kind: 'signed_out',
      title: 'Please Sign In Again',
      message: 'Your sign-in has expired. Sign in again to scan room QR codes.',
      buttonLabel: 'Sign In',
      action: 'sign_in',
      tone: 'info',
    };
  }
  if (result.status === 'Invalid') {
    return {
      kind: 'invalid',
      title: 'Invalid Room QR Code',
      message: 'This is not a current QRganize room QR code — it may be old or replaced. Please scan the QR code posted at the room.',
      buttonLabel: 'Close',
      action: 'close',
      tone: 'neutral',
    };
  }
  if (result.status === 'Blocked' && (result.reason === 'in_use' || result.occupancy)) {
    return {
      kind: 'in_use',
      title: 'Room In Use',
      message: result.message || 'Another faculty member is using this room right now.',
      buttonLabel: 'Close',
      action: 'close',
      tone: 'danger',
    };
  }
  // A free room this class can't use: the server says exactly why (only a class with no room
  // may use it, the room doesn't suit the class, or the class would run past the free time)
  if (result.status === 'Blocked' && result.reason && result.reason in FREE_ROOM_TITLE) {
    return {
      kind: 'not_assigned',
      title: FREE_ROOM_TITLE[result.reason as keyof typeof FREE_ROOM_TITLE],
      message: result.message || NOT_ASSIGNED_MESSAGE,
      buttonLabel: 'Close',
      action: 'close',
      tone: 'danger',
    };
  }
  if (result.status === 'Blocked' || result.status === 'Unauthorized') {
    return {
      kind: 'not_assigned',
      title: 'Room Not Assigned',
      message: NOT_ASSIGNED_MESSAGE,
      buttonLabel: 'Close',
      action: 'close',
      tone: 'danger',
    };
  }
  if (result.status === 'Overuse') {
    return {
      kind: 'overuse',
      title: 'Session Ended',
      message: result.message || 'The class session has already ended. The scan window is closed.',
      buttonLabel: 'Close',
      action: 'close',
      tone: 'danger',
    };
  }
  if (result.status === 'Pending') {
    const mins = result.expires_in_mins ?? 15;
    return {
      kind: 'pending',
      title: 'Room Reserved',
      message: result.message
        || `This room is reserved for you for ${mins} minutes. Scan the QR code at the room to confirm your check-in.`,
      buttonLabel: 'Got it',
      action: 'close',
      tone: 'warning',
    };
  }
  if (result.status === 'In-Use' && result.already_occupied) {
    return {
      kind: 'already',
      title: 'Already Checked In',
      message: result.message || 'You are already occupying this room. This room has already been successfully scanned.',
      buttonLabel: 'Done',
      action: 'close',
      tone: 'success',
    };
  }
  if ((result.status === 'In-Use' && result.scan_status === 'Late') || result.status === 'Late') {
    return {
      kind: 'late',
      title: 'Late Check-In',
      message: result.message || 'You checked in after the scheduled start time.',
      buttonLabel: 'Continue',
      action: 'close',
      tone: 'warning',
    };
  }
  if (result.status === 'In-Use' || result.status === 'Valid') {
    return {
      kind: 'success',
      title: 'Room Occupied Successfully',
      message: result.message || 'You are now checked in and occupying this room.',
      buttonLabel: 'Done',
      action: 'close',
      tone: 'success',
    };
  }
  return {
    kind: 'invalid',
    title: 'Scan Result',
    message: result.message || 'Scan completed.',
    buttonLabel: 'Close',
    action: 'close',
    tone: 'neutral',
  };
}
