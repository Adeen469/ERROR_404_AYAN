import React, { useState, useRef, useEffect } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import {
  filterSearchOptions,
  findExactMatch,
} from '../../utils/searchable-options';

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
  // Searchable: a search input sits at the top of the popover (it is
  // NOT a field on the page, and it is NOT an option). Typing in it
  // filters the real options in real time; the query itself never
  // becomes an option and never becomes the field value — only clicking
  // a result, or Enter on an exact match / a highlighted result, calls
  // onChange. The trigger always shows the selected result only, and
  // the search clears on select or close. Off by default, so every
  // existing dropdown behaves exactly as before. This replaces the
  // earlier hidden type-to-search, which had no input to type into: a
  // closed field is a button, not an input, so typing did nothing, and
  // on mobile no keyboard ever appeared.
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
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  // Selected value (the `value` prop) and search query are separate
  // state on purpose: typing only ever narrows the list, it never
  // writes the field. Only selectOption() writes the field.
  const [searchQuery, setSearchQuery] = useState('');
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const [noExactMatch, setNoExactMatch] = useState(false);

  const resetSearch = () => {
    setSearchQuery('');
    setHighlightIndex(-1);
    setNoExactMatch(false);
  };

  const closePicker = () => {
    resetSearch();
    setOpen(false);
  };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        closePicker();
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closePicker();
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open ]);

  useEffect(() => {
    if (!open) resetSearch();
  }, [open ]);

  const selected = options.find((o) => o.value === value);
  const label = selected ? selected.label : value;

  // The list the user actually sees: the full dataset filtered by the
  // search query in real time (case-insensitive, partial, trimmed,
  // de-duplicated). With no query it is the full list. The query itself
  // is never added to this list.
  const visibleOptions = searchable
    ? filterSearchOptions(options, searchQuery)
    : options;
  optionRefs.current.length = visibleOptions.length;

  // Keep a keyboard-highlighted row in view while arrowing through the
  // filtered list.
  useEffect(() => {
    if (highlightIndex >= 0) {
      optionRefs.current[highlightIndex]?.scrollIntoView({ block: 'nearest' });
    }
  }, [highlightIndex]);

  const selectOption = (opt: ThemedSelectOption) => {
    if (opt.disabled) return;
    onChange(opt.value);
    closePicker();
    triggerRef.current?.focus();
  };

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setNoExactMatch(false);
      setHighlightIndex((i) =>
        visibleOptions.length === 0
          ? -1
          : Math.min(i + 1, visibleOptions.length - 1),
      );
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setNoExactMatch(false);
      setHighlightIndex((i) => Math.max(i - 1, -1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      // Arrow-highlighted result first; otherwise only an exact match
      // (full name, case-insensitive, trimmed) may be selected. A
      // partial query with no exact match selects nothing, stays open,
      // and shows the hint below — arbitrary text is never accepted.
      const highlighted =
        highlightIndex >= 0 ? visibleOptions[highlightIndex] : undefined;
      if (highlighted && !highlighted.disabled) {
        selectOption(highlighted);
        return;
      }
      const exact = findExactMatch(options, searchQuery);
      if (exact && !exact.disabled) {
        selectOption(exact);
        return;
      }
      setNoExactMatch(true);
    } else if (e.key === 'Escape') {
      closePicker();
      triggerRef.current?.focus();
    }
  };

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
        ref={triggerRef}
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
            <div className="sticky top-0 bg-white px-2 pt-1 pb-2 border-b border-[#E7E3DB]">
              <input
                autoFocus
                type="text"
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setHighlightIndex(-1);
                  setNoExactMatch(false);
                }}
                onKeyDown={handleSearchKeyDown}
                placeholder="Search…"
                aria-label={`${ariaLabel} search`}
                className="w-full text-xs bg-white border border-[#E2DFD8] rounded-lg px-3 py-2 text-[#1E2320] focus:border-[#1E3F35] focus:ring-1 focus:ring-[#1E3F35] outline-none"
              />
              {noExactMatch && (
                <p className="text-[11px] text-rose-600 mt-1">
                  No exact match — pick a result from the list below.
                </p>
              )}
            </div>
          )}
          {searchable &&
            searchQuery.trim() &&
            visibleOptions.length === 0 && (
              <p className="px-3 py-2 text-xs text-[#5F635D]">
                No results found
              </p>
            )}
          {visibleOptions.map((opt, index) => {
            const isSelected = opt.value === value;
            const isHighlighted = searchable && highlightIndex === index;
            return (
              <button
                key={opt.value}
                ref={(el) => {
                  optionRefs.current[index] = el;
                }}
                type="button"
                disabled={opt.disabled}
                onMouseEnter={() => {
                  if (searchable) setHighlightIndex(index);
                }}
                onClick={() => selectOption(opt)}
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
                      : isHighlighted
                        ? 'bg-[#F4F1EA] text-[#1E2320]'
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
