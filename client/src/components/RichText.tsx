// Renders user text safely: no HTML is ever interpreted. Mentions written as `@[Name](id)` are
// highlighted, web addresses become links (opened in a new tab without referrer access) and line
// breaks are kept.

import { Fragment, type ReactNode } from 'react';

const TOKEN = /@\[([^\]\n]{1,120})\]\(([0-9a-f-]{36})\)|(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/gi;

export function RichText({ text, className }: { text: string; className?: string }) {
  const lines = text.split('\n');
  return (
    <div className={className ?? 'rich-text'}>
      {lines.map((line, i) => (
        <Fragment key={i}>
          {renderLine(line)}
          {i < lines.length - 1 && <br />}
        </Fragment>
      ))}
    </div>
  );
}

function renderLine(line: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of line.matchAll(TOKEN)) {
    const at = m.index ?? 0;
    if (at > last) out.push(line.slice(last, at));
    if (m[1]) {
      out.push(
        <span key={at} className="mention">
          @{m[1]}
        </span>,
      );
    } else if (m[3]) {
      out.push(
        <a key={at} href={m[3]} target="_blank" rel="noopener noreferrer nofollow">
          {m[3]}
        </a>,
      );
    }
    last = at + m[0].length;
  }
  if (last < line.length) out.push(line.slice(last));
  return out;
}

/** Plain text for previews (mention markup becomes "@Name"). */
export const plain = (text: string) => text.replace(/@\[([^\]\n]{1,120})\]\([0-9a-f-]{36}\)/gi, '@$1');
