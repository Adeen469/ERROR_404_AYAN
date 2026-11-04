import React, { useState, useRef, useEffect } from 'react';
import { Check, ChevronDown } from 'lucide-react';

// A dropdown that actually looks like Locora, instead of the browser's
// plain native select: parchment-white trigger, Deep Forest focus ring,
// forest-tinted selected row. Native <option> lists are OS-rendered and
// cannot be themed, so this renders its own list. Used everywhere a
// <select> used to sit: Discover filters, LocationPicker, Create/Edit
// category.

export interface ThemedSelectOption {
  value: string;
  label: string;
  // Greyed out and unclickable (used by the date/time picker for past
  // hours and minutes). Options without this behave exactly as before.
  disabled?: boolean;
}

interface ThemedSelectProps {
  value: string;
  options: ThemedSelectOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
  disabled?: boolean;
  // 'bar': compact filter-bar trigger. 'form': full-width form field.
  // 'drawer': full-width, taller, for the mobile filter drawer.
  size?: 'bar' | 'form' | 'drawer';
  // Optional free-text entry rendered INSIDE the dropdown popover, not as
  // a separate field on the page. Typing here must not close the popover.
  // The caller owns the text (customValue) and what it means; the trigger
  // shows it when it is non-empty because it matches no option.
  customValue?: string;
  onCustomChange?: (value: string) => void;
  customPlaceholder?: string;
  customLabel?: string;
  // Hidden type-to-search: when the popover is open, typing letters
  // filters the option list, but the typed text is NEVER shown anywhere
  // — there is no search box, and the trigger keeps showing only the
  // selected result. Picking a result clears the search. Off by default,
  // so every existing dropdown behaves exactly as before.
  searchable?: boolean;
}

export function ThemedSelect({
  value,
  options,
  onChange,
  ariaLabel,
  disabled,
  size = 'form',
  customValue,
  onCustomChange,
  customPlaceholder,
  customLabel,
  searchable,
}: ThemedSelectProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  // The typed search is held here only — it is never rendered, so the
  // user sees only the filtered results, never their keystrokes.
  const [searchQuery, setSearchQuery] = useState('');
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open ]);

  // Type-to-search capture: only while this popover is open, and never
  // while typing in a real input (e.g. the custom-value box). One
  // printable key appends to the hidden search; Backspace removes the
  // last letter; pausing for ~1.2s resets it so a new search starts
  // fresh. Closing the popover or picking a result also resets it.
  useEffect(() => {
    if (!open || !searchable) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return;
      }
      if (e.key === 'Backspace') {
        setSearchQuery((q) => q.slice(0, -1));
      } else if (e.key.length === 1) {
        setSearchQuery((q) => q + e.key.toLowerCase());
      } else {
        return;
      }
      if (searchTimer.current) clearTimeout(searchTimer.current);
      searchTimer.current = setTimeout(() => setSearchQuery(''), 1200);
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [open, searchable]);

  useEffect(() => {
    if (!open) setSearchQuery('');
  }, [open ]);

  const selected = options.find((o) => o.value === value);
  const label = selected ? selected.label : value;

  // The list the user actually sees: narrowed by the hidden search when
  // one is in progress, full list otherwise.
  const visibleOptions =
    searchable && searchQuery
      ? options.filter((o) => o.label.toLowerCase().includes(searchQuery))
      : options;

  const triggerSize =
    size === 'bar'
      ? 'px-3 py-2.5 text-xs shrink-0'
      : size === 'drawer'
        ? 'w-full px-3 py-3 text-sm'
        : 'w-full px-3 py-2.5 text-xs';
  const popoverSize =
    size === 'bar'
      ? 'left-0 min-w-full w-max max-w-[calc(100vw-2rem)]'
      : 'left-0 right-0';

  return (
    <div ref={wrapRef} className={`relative ${size === 'bar' ? '' : 'w-full'}`}>
      <button
        type="button"
        aria-label={ariaLabel}
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className={`inline-flex items-center justify-between gap-2 rounded-xl border bg-white text-[#1E2320] font-medium shadow-2xs transition-colors cursor-pointer ${triggerSize} ${
          open
            ? 'border-[#1E3F35] ring-1 ring-[#1E3F35]'
            : 'border-[#E2DFD8] hover:border-[#1E3F35]/50'
        } disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:border-[#E2DFD8]`}
      >
        <span className="truncate">{label}</span>
        <ChevronDown
          className={`w-3.5 h-3.5 shrink-0 text-[#5F635D] transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && !disabled && (
        <div
          className={`absolute z-30 mt-2 bg-white border border-[#E7E3DB] rounded-xl shadow-lg py-1 max-h-64 overflow-y-auto ${popoverSize}`}
        >
          {searchable && (
            <p className="px-3 py-2 text-[11px] text-[#5F635D] border-b border-[#E7E3DB]">
              Type to search
            </p>
          )}
          {searchable && searchQuery && visibleOptions.length === 0 && (
            <p className="px-3 py-2 text-xs text-[#5F635D]">
              No matching results
            </p>
          )}
          {visibleOptions.map((opt) => {
            const isSelected = opt.value === value;
            return (
              <button
                key={opt.value}
                type="button"
                disabled={opt.disabled}
                onClick={() => {
                  if (opt.disabled) return;
                  onChange(opt.value);
                  setSearchQuery('');
                  setOpen(false);
                }}
                className={`w-full flex items-center justify-between gap-2 text-left px-3 py-2 transition-colors ${
                  opt.disabled
                    ? 'text-[#C9C4B8] opacity-50 cursor-not-allowed'
                    : 'cursor-pointer'
                } ${
                  size === 'drawer' ? 'text-sm' : 'text-xs'
                } ${
                  isSelected
                    ? 'bg-[#EAF1ED] text-[#1E3F35] font-semibold'
                    : opt.disabled
                      ? ''
                      : 'text-[#1E2320] hover:bg-[#F4F1EA]'
                }`}
              >
                <span className="truncate">{opt.label}</span>
                {isSelected && <Check className="w-3.5 h-3.5 shrink-0" />}
              </button>
            );
          })}
          {onCustomChange && (
            <div
              className="border-t border-[#E7E3DB] px-3 py-2"
              // Clicking into the input must not close the popover: the
              // outside-click handler only closes on mousedown outside
              // this wrapper, and this block is inside it.
              onMouseDown={(e) => e.stopPropagation()}
            >
              <label className="block text-[11px] font-semibold text-[#5F635D] mb-1">
                {customLabel || 'Or type a custom value'}
              </label>
              <input
                type="text"
                value={customValue || ''}
                onChange={(e) => onCustomChange(e.target.value)}
                placeholder={customPlaceholder}
                aria-label={customLabel || 'Custom value'}
                className="w-full text-xs bg-white border border-[#E2DFD8] rounded-lg px-3 py-2 text-[#1E2320] focus:border-[#1E3F35] focus:ring-1 focus:ring-[#1E3F35] outline-none"
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
