import React, { useState, useRef, useEffect } from 'react';
import { Calendar, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import {
  buildMonthGrid,
  formatDayLong,
  monthLabel,
  monthOf,
  toISODate,
} from '../../utils/date-range';
import { ThemedSelect } from '../ui/ThemedSelect';

// The Discover calendar ("Any Date" dropdown) as a date AND time picker
// for the Create Event form's Schedule & Location section. Same look:
// parchment-white trigger with a Deep Forest focus ring, a month calendar
// with S M T W T F S headers, a selected day in forest, today ringed,
// and unpickable days muted. Unlike the native datetime-local input it
// replaces, past days here are actually unclickable — not just blocked
// on submit — and the End picker's calendar also blocks every day before
// the Start date.
//
// Value format is the same datetime-local string the form already uses:
// local time, YYYY-MM-DDTHH:MM. `earliest` is the earliest allowed
// datetime: "now" for Start, the Start value for End. Days before the
// earliest day are disabled, and on the earliest day itself, hours and
// minutes before the earliest time are disabled in the time dropdowns.
// The existing submit validation stays as the backstop for typed or
// stale values.

interface DateTimePickerProps {
  value: string;
  onChange: (value: string) => void;
  earliest: string;
  ariaLabel: string;
  hasError?: boolean;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function splitDateTime(value: string): { date: string; time: string } {
  const [date = '', time = ''] = value.split('T');
  return { date, time };
}

function formatTimeLabel(time: string): string {
  const [h = '0', m = '00'] = time.split(':');
  const hour = Number(h);
  const suffix = hour >= 12 ? 'PM' : 'AM';
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${hour12}:${m} ${suffix}`;
}

function formatDateTimeLabel(value: string): string {
  if (!value) return 'Select date & time';
  const { date, time } = splitDateTime(value);
  if (!date) return 'Select date & time';
  return `${formatDayLong(date)}, ${formatTimeLabel(time || '00:00')}`;
}

export function DateTimePicker({
  value,
  onChange,
  earliest,
  ariaLabel,
  hasError,
}: DateTimePickerProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const { date: selectedDate, time: selectedTime } = splitDateTime(value);
  const { date: earliestDate, time: earliestTime } = splitDateTime(earliest);
  const [hour, minute] = (selectedTime || '18:00').split(':');
  const [earliestHour, earliestMinute] = (earliestTime || '00:00').split(':');

  const initialView = () => {
    const base = selectedDate || earliestDate || toISODate(new Date());
    return monthOf(base);
  };
  const [view, setView] = useState(initialView);

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

  const openPicker = () => {
    // Fresh view from the current value each time it opens, so a
    // half-navigated month from last time never lingers.
    setView(initialView());
    setOpen(true);
  };

  const shiftMonth = (delta: number) => {
    const d = new Date(view.year, view.month + delta, 1);
    setView({ year: d.getFullYear(), month: d.getMonth() });
  };

  const emit = (date: string, time: string) => {
    onChange(`${date}T${time}`);
  };

  // Keep a time at or after the earliest time when the day is the
  // earliest day; other days keep whatever time was picked.
  const snapTime = (date: string, time: string): string => {
    if (date === earliestDate && time < earliestTime) return earliestTime;
    return time;
  };

  const handleDayClick = (date: string) => {
    if (earliestDate && date < earliestDate) return;
    const m = monthOf(date);
    if (m.year !== view.year || m.month !== view.month) setView(m);
    emit(date, snapTime(date, selectedTime || '18:00'));
  };

  const handleHourChange = (nextHour: string) => {
    const date = selectedDate || earliestDate || toISODate(new Date());
    let nextMinute = minute;
    if (date === earliestDate && nextHour === earliestHour && nextMinute < earliestMinute) {
      nextMinute = earliestMinute;
    }
    emit(date, snapTime(date, `${nextHour}:${nextMinute}`));
  };

  const handleMinuteChange = (nextMinute: string) => {
    const date = selectedDate || earliestDate || toISODate(new Date());
    emit(date, snapTime(date, `${hour}:${nextMinute}`));
  };

  const today = toISODate(new Date());
  const days = buildMonthGrid(view.year, view.month);
  const onEarliestDay = selectedDate === earliestDate;

  const hourOptions = Array.from({ length: 24 }, (_, h) => {
    const v = pad(h);
    const suffix = h >= 12 ? 'PM' : 'AM';
    const hour12 = h % 12 === 0 ? 12 : h % 12;
    return {
      value: v,
      label: `${hour12} ${suffix}`,
      disabled: onEarliestDay && earliestDate ? v < earliestHour : false,
    };
  });
  const minuteOptions = Array.from({ length: 60 }, (_, m) => {
    const v = pad(m);
    return {
      value: v,
      label: v,
      disabled:
        onEarliestDay && earliestDate && hour === earliestHour
          ? v < earliestMinute
          : false,
    };
  });

  const hint = earliestDate
    ? selectedDate === earliestDate
      ? 'Times before the earliest allowed time are greyed out.'
      : 'Pick a day, then a time. Days before the earliest allowed day are greyed out.'
    : 'Pick a day, then a time.';

  return (
    <div ref={wrapRef} className="relative w-full">
      <button
        type="button"
        aria-label={ariaLabel}
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openPicker())}
        className={`inline-flex items-center justify-between gap-1.5 rounded-xl border bg-white text-[#1E2320] font-medium shadow-2xs transition-colors cursor-pointer w-full px-3 py-2.5 text-xs ${
          open
            ? 'border-[#1E3F35] ring-1 ring-[#1E3F35]'
            : hasError
              ? 'border-rose-500'
              : 'border-[#E2DFD8] hover:border-[#1E3F35]/50'
        }`}
      >
        <span className="inline-flex items-center gap-1.5 truncate">
          <Calendar className="w-3.5 h-3.5 shrink-0" />
          <span className="truncate">{formatDateTimeLabel(value)}</span>
        </span>
        <ChevronDown
          className={`w-3.5 h-3.5 shrink-0 text-[#5F635D] transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div className="absolute z-30 mt-2 left-0 w-[320px] max-w-[calc(100vw-2rem)] bg-white border border-[#E7E3DB] rounded-2xl shadow-lg p-4 space-y-3">
          {/* Month navigation */}
          <div className="flex items-center justify-between">
            <button
              type="button"
              aria-label="Previous month"
              onClick={() => shiftMonth(-1)}
              className="p-1.5 rounded-lg text-[#5F635D] hover:text-[#1E2320] hover:bg-[#F4F1EA] transition-colors cursor-pointer"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <p className="font-editorial text-sm font-bold text-[#1E2320]">
              {monthLabel(view.year, view.month)}
            </p>
            <button
              type="button"
              aria-label="Next month"
              onClick={() => shiftMonth(1)}
              className="p-1.5 rounded-lg text-[#5F635D] hover:text-[#1E2320] hover:bg-[#F4F1EA] transition-colors cursor-pointer"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>

          {/* Weekday header */}
          <div className="grid grid-cols-7 gap-1 text-center">
            {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (
              <span key={i} className="text-[11px] font-semibold text-[#8C887E]">
                {d}
              </span>
            ))}
          </div>

          {/* Days */}
          <div className="grid grid-cols-7 gap-1">
            {days.map((cell) => {
              const isSelected = selectedDate === cell.date;
              const isToday = cell.date === today;
              const isDisabled = earliestDate ? cell.date < earliestDate : false;
              return (
                <button
                  key={cell.date}
                  type="button"
                  aria-label={formatDayLong(cell.date)}
                  disabled={isDisabled}
                  onClick={() => handleDayClick(cell.date)}
                  className={`h-9 rounded-lg text-xs transition-colors ${
                    isSelected
                      ? 'bg-[#1E3F35] text-white font-semibold cursor-pointer'
                      : isDisabled
                        ? 'text-[#C9C4B8] opacity-50 cursor-not-allowed'
                        : cell.inMonth
                          ? 'text-[#1E2320] hover:bg-[#F4F1EA] cursor-pointer'
                          : 'text-[#C9C4B8] hover:bg-[#F4F1EA] cursor-pointer'
                  } ${isToday && !isSelected ? 'ring-1 ring-[#1E3F35]/40 font-semibold' : ''}`}
                >
                  {cell.day}
                </button>
              );
            })}
          </div>

          {/* Time */}
          <div className="grid grid-cols-2 gap-3 pt-1 border-t border-[#EBE7DF]">
            <div>
              <label className="block text-[11px] font-semibold text-[#5F635D] mb-1 mt-2">
                Hour
              </label>
              <ThemedSelect
                value={hour}
                options={hourOptions}
                onChange={handleHourChange}
                ariaLabel="Hour"
                size="form"
              />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-[#5F635D] mb-1 mt-2">
                Minute
              </label>
              <ThemedSelect
                value={minute}
                options={minuteOptions}
                onChange={handleMinuteChange}
                ariaLabel="Minute"
                size="form"
              />
            </div>
          </div>

          <p className="text-[11px] text-[#5F635D] leading-relaxed">{hint}</p>

          <div className="flex items-center justify-end pt-1 border-t border-[#EBE7DF]">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="px-4 py-2 text-xs font-semibold text-white bg-[#1E3F35] hover:bg-[#163028] rounded-lg transition-colors cursor-pointer"
            >
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
