'use client';

import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useId, useMemo, useRef, useState } from 'react';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { cn } from '@/lib/cn';
import { DURATION, EASE } from '@/lib/motion';

/**
 * Picking tags for a document.
 *
 * Follows the ARIA combobox pattern with a listbox popup: the input is the
 * combobox, the suggestions are a listbox, and the active option is pointed at
 * with `aria-activedescendant` rather than by moving focus. Focus staying in the
 * input is what lets someone keep typing to narrow the list while the arrow keys
 * walk it — moving DOM focus into the list, which is the common shortcut, breaks
 * that and is why so many tag pickers cannot be used without a mouse.
 *
 * The vocabulary is company-wide and small (the API returns it unpaginated), so
 * filtering is a client-side `includes` over an array already in memory. If a
 * company ever has enough tags for that to matter, this grows a debounce and a
 * query parameter — not a different interaction model.
 *
 * `allowCreate` is gated by the caller on `tags.manage`: a Member may tag freely
 * from the vocabulary but must not quietly fork it into near-duplicates.
 */
export interface TagOption {
  id: string;
  name: string;
  /** A design-token name, never a colour literal. Matches BadgeTone. */
  color?: string | null;
}

export interface TagInputLabels {
  /** Interpolated with `{name}` — e.g. "Remove {name}". */
  remove: string;
  /** Interpolated with `{name}` — e.g. 'Create tag "{name}"'. */
  create: string;
  /** Shown when the query matches nothing and creating is not offered. */
  empty: string;
  /** Announced when the selection is at `max`. */
  full: string;
}

const toneOf = (color?: string | null): BadgeTone =>
  color === 'accent' || color === 'success' || color === 'warning' || color === 'danger'
    ? color
    : 'neutral';

export function TagInput({
  options,
  value,
  onChange,
  label,
  labels,
  placeholder,
  hint,
  disabled = false,
  allowCreate = false,
  onCreate,
  max,
  className,
}: {
  options: readonly TagOption[];
  /** Selected tag ids. Controlled — this component keeps no selection of its own. */
  value: readonly string[];
  onChange: (ids: string[]) => void;
  label: string;
  labels: TagInputLabels;
  placeholder?: string;
  hint?: string;
  disabled?: boolean;
  allowCreate?: boolean;
  /** Creates a tag and returns it, so it can be selected in the same gesture. */
  onCreate?: (name: string) => Promise<TagOption | null>;
  /** Mirrors the API's cap of 20 tags per document. */
  max?: number;
  className?: string;
}) {
  const baseId = useId();
  const listId = `${baseId}-list`;
  const inputId = `${baseId}-input`;
  const hintId = `${baseId}-hint`;

  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [creating, setCreating] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const reduced = useReducedMotion();

  const byId = useMemo(() => new Map(options.map((option) => [option.id, option])), [options]);

  /**
   * Selection order is the caller's, not the vocabulary's — the chips should
   * stay where they were put rather than reshuffling as one is removed.
   */
  const selected = value
    .map((id) => byId.get(id))
    .filter((option): option is TagOption => !!option);

  const full = max !== undefined && value.length >= max;

  const needle = query.trim().toLocaleLowerCase();

  const matches = useMemo(
    () =>
      options.filter(
        (option) =>
          !value.includes(option.id) &&
          (needle === '' || option.name.toLocaleLowerCase().includes(needle)),
      ),
    [options, value, needle],
  );

  // Offered only when the typed name is not already in the vocabulary — a
  // "create" row next to an identical existing tag invites the duplicate it is
  // supposed to prevent.
  const canCreate =
    allowCreate &&
    !!onCreate &&
    !full &&
    query.trim().length > 0 &&
    !options.some((option) => option.name.toLocaleLowerCase() === needle);

  const rowCount = matches.length + (canCreate ? 1 : 0);

  const reveal = () => {
    if (!disabled) {
      setOpen(true);
      setActive(0);
    }
  };

  const select = (option: TagOption) => {
    if (full || value.includes(option.id)) {
      return;
    }

    onChange([...value, option.id]);
    setQuery('');
    setActive(0);
    inputRef.current?.focus();
  };

  const deselect = (id: string) => {
    onChange(value.filter((entry) => entry !== id));
    inputRef.current?.focus();
  };

  const create = async () => {
    if (!onCreate || creating) {
      return;
    }

    setCreating(true);

    try {
      const created = await onCreate(query.trim());

      if (created) {
        // Appended through onChange rather than by calling select(), which
        // reads `value` from the render that started this await and would drop
        // a tag chosen while the request was in flight.
        onChange([...value, created.id]);
        setQuery('');
        setActive(0);
      }
    } finally {
      setCreating(false);
    }
  };

  const commit = (index: number) => {
    if (canCreate && index === rowCount - 1) {
      void create();
      return;
    }

    const option = matches[index];

    if (option) {
      select(option);
    }
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        event.preventDefault();

        if (!open) {
          reveal();
          return;
        }

        if (rowCount === 0) {
          return;
        }

        const step = event.key === 'ArrowDown' ? 1 : -1;
        // Wraps, matching the Tabs strip: the end of a list is not a wall.
        setActive((current) => (current + step + rowCount) % rowCount);
        return;
      }

      case 'Home':
      case 'End': {
        if (!open || rowCount === 0) {
          return;
        }

        event.preventDefault();
        setActive(event.key === 'Home' ? 0 : rowCount - 1);
        return;
      }

      case 'Enter': {
        if (!open || rowCount === 0) {
          return;
        }

        // Only swallowed when there is something to choose, so the surrounding
        // form still submits on Enter when the list is closed.
        event.preventDefault();
        commit(active);
        return;
      }

      case 'Escape': {
        if (open) {
          event.preventDefault();
          setOpen(false);
        }
        return;
      }

      case 'Backspace': {
        /**
         * Removes the last chip only when the caret has nothing left to delete.
         * Guarding on the empty query is what stops a mistyped character taking
         * a tag with it.
         */
        if (query === '' && selected.length > 0) {
          event.preventDefault();
          deselect(selected[selected.length - 1].id);
        }
        return;
      }

      default:
    }
  };

  const activeId = open && rowCount > 0 ? `${baseId}-option-${active}` : undefined;

  return (
    <div className={cn('w-full', className)}>
      <label htmlFor={inputId} className="text-text-muted mb-1.5 block text-xs font-medium">
        {label}
      </label>

      {/*
        Clicking anywhere in the box focuses the input, which is what a field
        made of chips has to do to feel like one field rather than a row of
        buttons with a text box after them.
      */}
      <div
        onClick={() => inputRef.current?.focus()}
        className={cn(
          'border-border bg-surface-inset flex flex-wrap items-center gap-1.5 rounded-lg border',
          'min-h-11 px-2 py-1.5',
          'transition-[border-color,box-shadow,background-color] duration-fast ease-out-quint',
          'has-[:focus]:border-accent has-[:focus]:bg-surface has-[:focus]:shadow-[0_0_0_3px_var(--color-accent-subtle)]',
          disabled && 'pointer-events-none opacity-60',
        )}
      >
        <AnimatePresence initial={false} mode="popLayout">
          {selected.map((option) => (
            <motion.span
              key={option.id}
              layout={!reduced}
              initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.9 }}
              transition={{ duration: DURATION.fast, ease: EASE.outQuint }}
            >
              <Badge
                tone={toneOf(option.color)}
                onRemove={() => deselect(option.id)}
                removeLabel={labels.remove.replace('{name}', option.name)}
              >
                {option.name}
              </Badge>
            </motion.span>
          ))}
        </AnimatePresence>

        <input
          ref={inputRef}
          id={inputId}
          type="text"
          role="combobox"
          autoComplete="off"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeId}
          aria-describedby={hint ? hintId : undefined}
          disabled={disabled || full}
          value={query}
          placeholder={full ? labels.full : placeholder}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
            setOpen(true);
          }}
          onFocus={reveal}
          // Closed on blur rather than on an outside click: focus is what the
          // list follows, and a click on an option refocuses the input before
          // this can strand it open.
          onBlur={() => setOpen(false)}
          onKeyDown={onKeyDown}
          className="text-text placeholder:text-text-subtle min-w-32 flex-1 bg-transparent px-1 py-0.5 text-sm outline-none"
        />
      </div>

      {hint ? (
        <p id={hintId} className="text-text-subtle mt-1.5 text-xs">
          {hint}
        </p>
      ) : null}

      <div className="relative">
        <AnimatePresence>
          {open ? (
            <motion.ul
              id={listId}
              role="listbox"
              aria-label={label}
              initial={reduced ? { opacity: 0 } : { opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: DURATION.fast, ease: EASE.outQuint }}
              className={cn(
                'border-border bg-surface-raised absolute inset-x-0 top-1 z-30',
                'max-h-56 overflow-y-auto rounded-lg border py-1 shadow-lg',
              )}
            >
              {matches.map((option, index) => (
                <li
                  key={option.id}
                  id={`${baseId}-option-${index}`}
                  role="option"
                  aria-selected={index === active}
                  // onMouseDown, not onClick: a click fires after blur, by which
                  // point the list has closed and the row is gone.
                  onMouseDown={(event) => {
                    event.preventDefault();
                    select(option);
                  }}
                  onMouseEnter={() => setActive(index)}
                  className={cn(
                    'flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm',
                    index === active && 'bg-surface-inset',
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn('size-2 shrink-0 rounded-full', DOT[toneOf(option.color)])}
                  />
                  <span className="truncate">{option.name}</span>
                </li>
              ))}

              {canCreate ? (
                <li
                  id={`${baseId}-option-${rowCount - 1}`}
                  role="option"
                  aria-selected={active === rowCount - 1}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    void create();
                  }}
                  onMouseEnter={() => setActive(rowCount - 1)}
                  className={cn(
                    'text-accent flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm',
                    active === rowCount - 1 && 'bg-surface-inset',
                    creating && 'opacity-60',
                  )}
                >
                  <svg viewBox="0 0 12 12" className="size-3 shrink-0" aria-hidden="true">
                    <path
                      d="M6 2v8M2 6h8"
                      stroke="currentColor"
                      strokeWidth="1.75"
                      strokeLinecap="round"
                    />
                  </svg>
                  <span className="truncate">{labels.create.replace('{name}', query.trim())}</span>
                </li>
              ) : null}

              {rowCount === 0 ? (
                <li className="text-text-subtle px-3 py-2 text-xs">{labels.empty}</li>
              ) : null}
            </motion.ul>
          ) : null}
        </AnimatePresence>
      </div>
    </div>
  );
}

const DOT: Record<BadgeTone, string> = {
  neutral: 'bg-text-subtle',
  accent: 'bg-accent',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
};
