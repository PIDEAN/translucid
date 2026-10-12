export interface ParsedSegment {
  id: number;
  text: string;
}

const THINK_RE = /<think>[\s\S]*?(?:<\/think>|$)/g;
const SEG_RE = /<(\d+)>([\s\S]*?)<\/\1>/g;

/**
 * Incrementally extracts `<n>…</n>` segments from a streamed reply so each
 * translation can be rendered as soon as its closing tag arrives.
 * Batches are a few KB, so rescanning the buffer per chunk is cheap.
 */
export class SegmentStreamParser {
  private raw = '';
  private emitted = new Set<number>();

  push(chunk: string): ParsedSegment[] {
    this.raw += chunk;
    const clean = this.raw.replace(THINK_RE, '');
    const out: ParsedSegment[] = [];
    for (const m of clean.matchAll(SEG_RE)) {
      const id = Number(m[1]);
      if (this.emitted.has(id)) continue;
      this.emitted.add(id);
      out.push({ id, text: m[2]!.trim() });
    }
    return out;
  }

  /** Flush segments whose closing tag never arrived (truncated or sloppy output). */
  end(): ParsedSegment[] {
    const clean = this.raw.replace(THINK_RE, '');
    const out: ParsedSegment[] = [];
    const opens = [...clean.matchAll(/<(\d+)>/g)];
    opens.forEach((m, i) => {
      const id = Number(m[1]);
      if (this.emitted.has(id)) return;
      const start = m.index! + m[0].length;
      const next = opens[i + 1]?.index ?? clean.length;
      const text = clean.slice(start, next).replace(new RegExp(`</${id}>[\\s\\S]*$`), '').trim();
      if (!text) return;
      this.emitted.add(id);
      out.push({ id, text });
    });
    return out;
  }

  get rawText(): string {
    return this.raw;
  }
}
