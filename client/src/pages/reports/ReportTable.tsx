import type { ReportDTO } from '@workpilot/shared';
import { formatDay } from '../../lib/format';

function cell(v: string | number | null | undefined, type: ReportDTO['columns'][number]['type']) {
  if (v === null || v === undefined || v === '') return <span className="muted">—</span>;
  if (type === 'percent') return `${v}%`;
  if (type === 'hours') return Number(v).toLocaleString('en-GB', { maximumFractionDigits: 2 });
  if (type === 'date' && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return formatDay(v.slice(0, 10));
  return String(v);
}

export function ReportTable({ report }: { report: ReportDTO }) {
  if (!report.rows.length) return <p className="muted">No data for this period.</p>;
  const numeric = (t: string) => ['number', 'hours', 'percent', 'money'].includes(t);
  return (
    <div className="table-wrap">
      <table className="table">
        <caption className="sr-only">{report.title}</caption>
        <thead>
          <tr>
            {report.columns.map((c) => (
              <th key={c.key} scope="col" className={numeric(c.type) ? 'num' : undefined}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {report.rows.map((r, i) => (
            <tr key={i}>
              {report.columns.map((c) => (
                <td key={c.key} className={numeric(c.type) ? 'num' : undefined}>
                  {cell(r[c.key], c.type)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {report.totals && (
          <tfoot>
            <tr>
              {report.columns.map((c, i) => (
                <td key={c.key} className={numeric(c.type) ? 'num' : undefined}>
                  {i === 0 ? <strong>Total</strong> : report.totals![c.key] !== undefined ? <strong>{cell(report.totals![c.key], c.type)}</strong> : null}
                </td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}
