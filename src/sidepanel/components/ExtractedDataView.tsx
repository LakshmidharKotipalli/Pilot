import type { ExtractedData } from '../../shared/schemas';

export function ExtractedDataView({ items }: { items: ExtractedData[] }) {
  if (items.length === 0) return null;
  return (
    <section className="card" aria-labelledby="extracted-title">
      <h2 id="extracted-title">Extracted content</h2>
      {items.map((x, i) => (
        <div key={i} style={{ marginBottom: 8 }}>
          <div className="small muted">
            {x.format} from {x.targetId}
            {x.truncated ? ' (truncated)' : ''}
          </div>
          {x.format === 'text' && <pre>{x.text}</pre>}
          {x.format === 'table' && (
            <div style={{ overflowX: 'auto' }}>
              <table>
                <tbody>
                  {(x.rows ?? []).map((r, ri) => (
                    <tr key={ri}>
                      {r.map((c, ci) => (
                        <td key={ci}>{c}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {x.format === 'links' && (
            <ul className="plain">
              {(x.links ?? []).map((l, li) => (
                <li key={li}>
                  {l.text}
                  <div className="muted small mono">{l.href}</div>
                </li>
              ))}
            </ul>
          )}
          <button
            type="button"
            onClick={() =>
              void navigator.clipboard.writeText(
                x.text ?? x.rows?.map((r) => r.join('\t')).join('\n') ?? x.links?.map((l) => `${l.text}\t${l.href}`).join('\n') ?? '',
              )
            }
          >
            Copy
          </button>
        </div>
      ))}
    </section>
  );
}
