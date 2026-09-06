// Parses pools.txt from the shared elektron-net-registry repo (see
// doc-elektron/guideline-pool-registry-reporting.md). Deliberately simple,
// one entry per line, no tokens or signatures: `"Type"; "Name"; "URL";`
// where Type is "PPLNS" or "SOLO". Malformed lines are skipped rather than
// failing the whole registry.

export interface RegistryPoolEntry {
  type: 'PPLNS' | 'SOLO';
  name: string;
  url: string;
}

const QUOTED_FIELD = /"((?:[^"\\]|\\.)*)"/g;

export function parsePoolsRegistry(text: string): RegistryPoolEntry[] {
  const entries: RegistryPoolEntry[] = [];
  for (const rawLine of (text ?? '').split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }
    const fields = [...line.matchAll(QUOTED_FIELD)].map(m => m[1].trim());
    if (fields.length !== 3) {
      continue;
    }
    const [type, name, url] = fields;
    if ((type !== 'PPLNS' && type !== 'SOLO') || name.length === 0 || url.length === 0) {
      continue;
    }
    entries.push({ type, name, url });
  }
  return entries;
}
