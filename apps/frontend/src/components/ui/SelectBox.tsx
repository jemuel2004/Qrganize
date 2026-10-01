'use client';

import { useEffect, useRef } from 'react';

/** Large checkbox with a "some selected" (dash) state, like Gmail's select-all */
export default function SelectBox({ checked, indeterminate = false, disabled = false, onChange, label }: {
  checked: boolean;
  indeterminate?: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  /** Tooltip + screen-reader label (say why when disabled) */
  label: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = indeterminate && !checked; }, [indeterminate, checked]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={e => onChange(e.target.checked)}
      aria-label={label}
      title={label}
      className="w-[18px] h-[18px] rounded border-[#94A3B8] accent-[#1D5BD6] cursor-pointer align-middle transition-opacity disabled:opacity-30 disabled:cursor-not-allowed"
    />
  );
}
