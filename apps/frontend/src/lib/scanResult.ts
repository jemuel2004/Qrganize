/*
 * What a room QR scan (POST /api/qr/scan) answered, and how to say it —
 * shared by Scan Room QR and the room page a phone camera opens, so both show
 * the same titles, messages and colours.
 */

export interface ScanResult {
  status: 'In-Use' | 'Pending' | 'Valid' | 'Late' | 'Overuse' | 'Blocked' | 'Unauthorized' | 'Invalid' | 'Error';
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
  | 'blocked'
  | 'unauthorized'
  | 'invalid'
  | 'overuse'
  | 'error';

export interface ModalPresentation {
  kind: ModalKind;
  title: string;
  message: string;
  buttonLabel: string;
  action: 'done' | 'scan_again';
  tone: 'success' | 'warning' | 'danger' | 'neutral' | 'info';
}

export function presentScanResult(result: ScanResult): ModalPresentation {
  if (result.status === 'Error') {
    return {
      kind: 'error',
      title: 'Connection Problem',
      message: result.message || "We couldn't verify this QR code. Check your connection and try again.",
      buttonLabel: 'Try Again',
      action: 'scan_again',
      tone: 'danger',
    };
  }
  if (result.status === 'Invalid') {
    return {
      kind: 'invalid',
      title: 'Invalid Room QR Code',
      message: result.message || 'This QR code could not be verified. Please scan a valid QRganize room QR code.',
      buttonLabel: 'Scan Again',
      action: 'scan_again',
      tone: 'neutral',
    };
  }
  if (result.status === 'Blocked') {
    return {
      kind: 'blocked',
      title: 'Unable to Check In',
      message: result.message || 'This room is currently occupied.',
      buttonLabel: 'Close',
      action: 'done',
      tone: 'danger',
    };
  }
  if (result.status === 'Unauthorized') {
    return {
      kind: 'unauthorized',
      title: 'Unauthorized Room',
      message: result.message || 'This room is assigned to a different faculty member at this time.',
      buttonLabel: 'Close',
      action: 'done',
      tone: 'danger',
    };
  }
  if (result.status === 'Overuse') {
    return {
      kind: 'overuse',
      title: 'Session Ended',
      message: result.message || 'The class session has already ended. The scan window is closed.',
      buttonLabel: 'Close',
      action: 'done',
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
      action: 'scan_again',
      tone: 'warning',
    };
  }
  if (result.status === 'In-Use' && result.already_occupied) {
    return {
      kind: 'already',
      title: 'Already Checked In',
      message: result.message || 'You are already occupying this room. This room has already been successfully scanned.',
      buttonLabel: 'Done',
      action: 'done',
      tone: 'success',
    };
  }
  if (result.status === 'In-Use' && result.scan_status === 'Late') {
    return {
      kind: 'late',
      title: 'Late Check-In',
      message: result.message || 'You checked in after the scheduled start time.',
      buttonLabel: 'Continue',
      action: 'done',
      tone: 'warning',
    };
  }
  if (result.status === 'Late') {
    return {
      kind: 'late',
      title: 'Late Check-In',
      message: result.message || 'You checked in after the scheduled start time.',
      buttonLabel: 'Continue',
      action: 'done',
      tone: 'warning',
    };
  }
  if (result.status === 'In-Use' || result.status === 'Valid') {
    return {
      kind: 'success',
      title: 'Room Occupied Successfully',
      message: result.message || 'You are now checked in and occupying this room.',
      buttonLabel: 'Done',
      action: 'done',
      tone: 'success',
    };
  }
  return {
    kind: 'invalid',
    title: 'Scan Result',
    message: result.message || 'Scan completed.',
    buttonLabel: 'Close',
    action: 'done',
    tone: 'neutral',
  };
}
