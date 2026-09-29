/*
 * Day colours shared by every timetable view: paired meeting days share a
 * colour — Mon+Thu royal blue, Tue+Fri teal, Wed indigo, Sat/Sun slate.
 */

export interface DayTone { pair: string; bar: string; bg: string; col: string; border: string; text: string }

export const TT_TONE_MTH: DayTone = { pair: 'MTh', bar: '#1D5BD6', bg: '#EAF1FD', col: 'rgba(29,91,214,0.035)',  border: '#BFD3F5', text: '#164BB5' };
export const TT_TONE_TF:  DayTone = { pair: 'TF',  bar: '#0D9488', bg: '#E6F7F4', col: 'rgba(13,148,136,0.04)',  border: '#9ADFD4', text: '#0F766E' };
export const TT_TONE_W:   DayTone = { pair: 'W',   bar: '#6366F1', bg: '#EEF0FE', col: 'rgba(99,102,241,0.035)', border: '#C7CBFA', text: '#4338CA' };
export const TT_TONE_SAT: DayTone = { pair: 'Sat', bar: '#64748B', bg: '#F1F4F8', col: 'rgba(100,116,139,0.04)', border: '#CBD5E1', text: '#475569' };

/** Overload classes — red on any day, so they stand out on the timetable. */
export const TT_TONE_OVERLOAD: DayTone = { pair: 'OL', bar: '#DC2626', bg: '#FEF2F2', col: 'rgba(220,38,38,0.04)', border: '#FCA5A5', text: '#B91C1C' };

export const TT_DAY_TONES: Record<string, DayTone> = {
  Monday: TT_TONE_MTH, Thursday: TT_TONE_MTH,
  Tuesday: TT_TONE_TF, Friday: TT_TONE_TF,
  Wednesday: TT_TONE_W, Saturday: TT_TONE_SAT, Sunday: TT_TONE_SAT,
};

export const dayTone = (day: string): DayTone => TT_DAY_TONES[day] ?? TT_TONE_SAT;
