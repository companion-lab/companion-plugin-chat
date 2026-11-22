// Generic inline-tag extraction for structured replies. Tag kinds come from
// the active reply contribution's schema (every non-"text" property — see
// ./reply.ts tagKinds); values pass through unresolved, since the reply
// owner (e.g. the avatar engine) is the one that interprets them.
//
// Ported from the host's app/src/net/structured.ts, which hardcoded the
// avatar's emotion/motion tags.

export type TagParse = {
  text: string;
  data: Record<string, unknown>;
};

function tagRegex(kind: string): RegExp {
  // Kind names are schema property keys, so this is a plain identifier —
  // no escaping needed inside the pattern.
  return new RegExp(`<<(${kind}):([^>]+)>>`, "gi");
}

export function stripStructuredTags(raw: string, kinds: string[]): string {
  let out = raw;
  for (const kind of kinds) out = out.replace(tagRegex(kind), "");
  return out;
}

// State machine for streaming tag extraction.
export class StructuredStream {
  private raw = "";
  private emittedText = "";
  // Only kinds a tag actually resolved for — getFinal() must not invent
  // defaults that would clobber the JSON parse in finalReplyResult.
  private fired: Record<string, string> = {};

  constructor(private kinds: string[]) {}

  push(raw: string): { tokens: string; data: Record<string, unknown> } {
    this.raw += raw;

    const data: Record<string, unknown> = {};
    for (const kind of this.kinds) {
      for (const m of this.raw.matchAll(tagRegex(kind))) {
        const v = (m[2] ?? "").trim();
        if (v && v !== this.fired[kind]) {
          this.fired[kind] = v;
          data[kind] = v;
        }
      }
    }

    const clean = stripStructuredTags(this.raw, this.kinds);
    // Hold back a trailing partial tag (a "<<" split across two chunks) so we
    // never speak half of one.
    const partial = clean.search(/<<?[^>]*$/);
    const speakable = partial >= 0 ? clean.slice(0, partial) : clean;

    let tokens = "";
    if (speakable.length > this.emittedText.length) {
      tokens = speakable.slice(this.emittedText.length);
      this.emittedText = speakable;
    }

    return { tokens, data };
  }

  getFinal(): Record<string, unknown> {
    return { ...this.fired };
  }
}

export function parseStructured(raw: string, kinds: string[]): TagParse {
  const data: Record<string, unknown> = {};
  for (const kind of kinds) {
    for (const m of raw.matchAll(tagRegex(kind))) {
      const v = (m[2] ?? "").trim();
      if (v) data[kind] = v;
    }
  }
  const text = stripStructuredTags(raw, kinds).trim();

  return { text, data };
}
