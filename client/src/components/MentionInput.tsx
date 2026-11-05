// A textarea that suggests people when the user types "@". Choosing someone inserts
// `@[Full Name](id)`, which the server turns into a mention (and a notification) only if that
// person can see the item. Keyboard: arrows to move, Enter/Tab to choose, Escape to close.

import { forwardRef, useId, useImperativeHandle, useMemo, useRef, useState, type KeyboardEvent, type TextareaHTMLAttributes } from 'react';
import type { PersonRef } from '@workpilot/shared';
import { cx } from './ui';

export interface MentionInputProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'> {
  value: string;
  onChange: (v: string) => void;
  people: PersonRef[];
  label: string;
  hideLabel?: boolean;
  error?: string;
  onSubmitShortcut?: () => void;
}

export const MentionInput = forwardRef<HTMLTextAreaElement, MentionInputProps>(function MentionInput(
  { value, onChange, people, label, hideLabel, error, onSubmitShortcut, className, onKeyDown, ...rest },
  ref,
) {
  const id = useId();
  const area = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(ref, () => area.current!);
  const [query, setQuery] = useState<{ text: string; start: number } | null>(null);
  const [active, setActive] = useState(0);

  const matches = useMemo(() => {
    if (!query) return [];
    const q = query.text.toLowerCase();
    return people.filter((p) => p.name.toLowerCase().includes(q)).slice(0, 6);
  }, [query, people]);

  const detect = (text: string, caret: number) => {
    const before = text.slice(0, caret);
    const m = /(^|\s)@([^\s@[\]()]{0,30})$/.exec(before);
    if (m) {
      setQuery({ text: m[2]!, start: caret - m[2]!.length - 1 });
      setActive(0);
    } else setQuery(null);
  };

  const choose = (p: PersonRef) => {
    if (!query || !area.current) return;
    const caret = area.current.selectionStart;
    const token = `@[${p.name}](${p.id}) `;
    const next = value.slice(0, query.start) + token + value.slice(caret);
    onChange(next);
    setQuery(null);
    window.requestAnimationFrame(() => {
      const pos = query.start + token.length;
      area.current?.setSelectionRange(pos, pos);
      area.current?.focus();
    });
  };

  const keyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (query && matches.length) {
      if (e.key === 'ArrowDown') return e.preventDefault(), setActive((a) => (a + 1) % matches.length);
      if (e.key === 'ArrowUp') return e.preventDefault(), setActive((a) => (a - 1 + matches.length) % matches.length);
      if (e.key === 'Enter' || e.key === 'Tab') return e.preventDefault(), choose(matches[active]!);
      if (e.key === 'Escape') return e.preventDefault(), setQuery(null);
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && onSubmitShortcut) {
      e.preventDefault();
      onSubmitShortcut();
    }
    onKeyDown?.(e);
  };

  const listId = `${id}-mentions`;
  return (
    <div className={cx('field', error && 'field-invalid', 'mention-field')}>
      <label htmlFor={id} className={hideLabel ? 'sr-only' : 'field-label'}>
        {label}
      </label>
      <textarea
        ref={area}
        id={id}
        className={cx('input', 'textarea', className)}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          detect(e.target.value, e.target.selectionStart);
        }}
        onKeyDown={keyDown}
        onBlur={() => window.setTimeout(() => setQuery(null), 150)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        aria-autocomplete="list"
        aria-controls={query && matches.length ? listId : undefined}
        aria-expanded={!!(query && matches.length)}
        aria-activedescendant={query && matches.length ? `${listId}-${active}` : undefined}
        role="combobox"
        {...rest}
      />
      {query && matches.length > 0 && (
        <ul id={listId} role="listbox" className="mention-list" aria-label="People to mention">
          {matches.map((p, i) => (
            <li
              key={p.id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className={cx('mention-option', i === active && 'mention-option-active')}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(p);
              }}
            >
              {p.name}
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p id={`${id}-error`} className="field-error">
          {error}
        </p>
      )}
    </div>
  );
});
