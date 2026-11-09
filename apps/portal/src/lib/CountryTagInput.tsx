import { useId, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { theme } from '../theme.js';
import { countryName, countryOptions } from './CountryField.js';

/**
 * Countries as tags, picked from a searchable menu of names. The value is
 * ISO-3166 alpha-2 codes in the order picked. A code that isn't on the list
 * (saved before the picker) still shows, by name if the browser knows it,
 * and can be removed.
 */
export function CountryTagInput({
  value,
  onChange,
  max,
  label,
  placeholder = 'Search countries',
}: {
  value: string[];
  onChange: (codes: string[]) => void;
  max?: number;
  /** The accessible name of the search box. */
  label: string;
  placeholder?: string;
}) {
  const options = useMemo(() => countryOptions(), []);
  const names = useMemo(() => new Map(options.map((o) => [o.code, o.name])), [options]);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();

  const full = max != null && value.length >= max;
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const free = options.filter((o) => !value.includes(o.code));
    if (!needle) return free;
    // An exact code first ("us", "gb"), then names that start with the
    // search, then names that contain it.
    const rank = (o: { code: string; name: string }) => {
      const name = o.name.toLowerCase();
      if (o.code.toLowerCase() === needle) return 0;
      if (name.startsWith(needle)) return 1;
      if (name.includes(needle)) return 2;
      return 3;
    };
    return free
      .map((o) => ({ o, r: rank(o) }))
      .filter((x) => x.r < 3)
      .sort((a, b) => a.r - b.r)
      .map((x) => x.o);
  }, [options, query, value]);
  const showList = open && !full;
  const activeIndex = Math.min(active, Math.max(0, matches.length - 1));

  const pick = (code: string) => {
    const next = [...value, code];
    onChange(next);
    setQuery('');
    setActive(0);
    if (max != null && next.length >= max) setOpen(false);
  };
  const remove = (code: string) => onChange(value.filter((c) => c !== code));

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!showList) return setOpen(true);
      const step = e.key === 'ArrowDown' ? 1 : -1;
      const next = Math.min(Math.max(activeIndex + step, 0), matches.length - 1);
      setActive(next);
      document.getElementById(`${listId}-${next}`)?.scrollIntoView?.({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      // Never submits a surrounding form.
      e.preventDefault();
      if (showList && matches[activeIndex]) pick(matches[activeIndex].code);
    } else if (e.key === 'Escape') {
      if (showList) {
        e.preventDefault();
        setOpen(false);
      }
    } else if (e.key === 'Backspace' && query === '' && value.length > 0) {
      remove(value[value.length - 1]!);
    }
  };

  return (
    <div style={{ position: 'relative' }}>
      <div
        onMouseDown={(e) => {
          // A click on the box itself (not a tag) searches.
          if (e.target === e.currentTarget) {
            e.preventDefault();
            input.current?.focus();
            setOpen(true);
          }
        }}
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 6,
          minHeight: 42,
          padding: '5px 8px',
          background: theme.surface2,
          border: `1px solid ${theme.border}`,
          borderRadius: theme.radiusSm,
          outline: focused ? `2px solid ${theme.accent}` : 'none',
          outlineOffset: 1,
          cursor: full ? 'default' : 'text',
        }}
      >
        {value.map((code) => {
          const name = names.get(code) ?? countryName(code);
          return (
            <span
              key={code}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                padding: '3px 4px 3px 10px',
                borderRadius: 14,
                border: `1px solid ${theme.accent}`,
                background: theme.accentA22,
                color: theme.accentText,
                fontSize: 12,
                fontWeight: 500,
                whiteSpace: 'nowrap',
              }}
            >
              {name}
              <button
                type="button"
                aria-label={`Remove ${name}`}
                onClick={() => remove(code)}
                style={{
                  display: 'inline-flex',
                  padding: 2,
                  background: 'none',
                  border: 'none',
                  borderRadius: '50%',
                  color: 'inherit',
                  cursor: 'pointer',
                }}
              >
                <X size={12} aria-hidden="true" />
              </button>
            </span>
          );
        })}
        {/* Stays when full, read-only, so Backspace still removes the last tag. */}
        <input
          ref={input}
          role="combobox"
          aria-label={label}
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={showList && matches[activeIndex] ? `${listId}-${activeIndex}` : undefined}
          autoComplete="off"
          readOnly={full}
          value={query}
          placeholder={value.length === 0 ? placeholder : ''}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
            setOpen(true);
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            setOpen(false);
          }}
          onClick={() => setOpen(true)}
          onKeyDown={onKeyDown}
          style={{
            flex: '1 0 120px',
            minWidth: 0,
            padding: '5px 2px',
            fontSize: 14,
            background: 'transparent',
            border: 'none',
            outline: 'none',
            color: theme.text,
            fontFamily: theme.fontSans,
          }}
        />
      </div>
      {showList && (
        <ul
          id={listId}
          role="listbox"
          aria-label={label}
          className="op-scroll-hover"
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            right: 0,
            zIndex: 30,
            maxHeight: 240,
            overflowY: 'auto',
            margin: 0,
            padding: 4,
            listStyle: 'none',
            background: theme.surface,
            border: `1px solid ${theme.border}`,
            borderRadius: theme.radiusSm,
            boxShadow: theme.shadowPopover,
          }}
        >
          {matches.map((o, i) => (
            <li
              key={o.code}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === activeIndex}
              // Keeps focus in the search box, so the list stays open.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(o.code)}
              onMouseEnter={() => setActive(i)}
              style={{
                padding: '7px 10px',
                borderRadius: 4,
                fontSize: 13,
                color: theme.text,
                background: i === activeIndex ? theme.surface2 : 'transparent',
                cursor: 'pointer',
              }}
            >
              {o.name}
            </li>
          ))}
          {matches.length === 0 && (
            <li style={{ padding: '7px 10px', fontSize: 13, color: theme.textMuted }}>No country matches.</li>
          )}
        </ul>
      )}
    </div>
  );
}
