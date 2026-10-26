/**
 * Splitting a document into retrievable passages.
 *
 * `chunkContent` cuts plain text into overlapping passages. `chunkDocument` adds the HEADING a
 * passage sits under and its position, so a search hit can show "the matching passage and its
 * source" rather than an anonymous slice of text.
 */

/** Approximate chunk size in characters (~500 tokens). */
export const DEFAULT_CHUNK_SIZE = 2000;
/** Overlap between consecutive chunks so we don't split mid-sentence. */
export const CHUNK_OVERLAP = 200;

/**
 * Split a long text into overlapping chunks of approximately `maxChunkSize`
 * characters. Tries to break at paragraph or sentence boundaries.
 */
export function chunkContent(
  content: string,
  maxChunkSize: number = DEFAULT_CHUNK_SIZE,
): string[] {
  if (!content || content.length === 0) return [];
  if (content.length <= maxChunkSize) return [content];

  const chunks: string[] = [];
  let start = 0;

  while (start < content.length) {
    let end = Math.min(start + maxChunkSize, content.length);

    // Try to break at a paragraph boundary
    if (end < content.length) {
      const paragraphBreak = content.lastIndexOf('\n\n', end);
      if (paragraphBreak > start + maxChunkSize * 0.5) {
        end = paragraphBreak + 2; // include the newlines
      } else {
        // Fall back to sentence boundary
        const sentenceBreak = content.lastIndexOf('. ', end);
        if (sentenceBreak > start + maxChunkSize * 0.5) {
          end = sentenceBreak + 2;
        }
      }
    }

    chunks.push(content.slice(start, end).trim());
    // The text is used up. Stepping back by the overlap here would emit its last
    // CHUNK_OVERLAP characters again as a chunk of their own.
    if (end >= content.length) break;

    // Advance with overlap so context isn't lost at boundaries
    const nextStart = end - CHUNK_OVERLAP;
    // Safety: ensure we always make forward progress past the previous start
    if (nextStart <= start) {
      start = end;
    } else {
      start = nextStart;
    }
  }

  return chunks.filter((c) => c.length > 0);
}

/** One passage of a document, as a store keeps it. */
export interface DocumentChunk {
  /** Position in the document, from 0. */
  ordinal: number;
  /** The nearest heading above the passage, or null when the document has none. */
  heading: string | null;
  text: string;
}

// A markdown heading. Convert Word headings, slide titles and sheet names to this shape before
// chunking, and every format arrives with its structure intact.
const HEADING_RE = /^#{1,6}\s+(.+?)\s*#*\s*$/;

/**
 * Cut a document into passages, each labelled with the heading it sits under.
 *
 * Sections are chunked separately so a passage never straddles two headings: a hit on
 * "Social value" should not open on the last paragraph of "Health and safety".
 */
export function chunkDocument(text: string, maxChunkSize: number = DEFAULT_CHUNK_SIZE): DocumentChunk[] {
  if (!text || !text.trim()) return [];
  const sections: Array<{ heading: string | null; body: string[] }> = [{ heading: null, body: [] }];
  for (const line of text.split(/\r?\n/)) {
    const heading = line.match(HEADING_RE);
    if (heading) {
      sections.push({ heading: heading[1].trim(), body: [] });
      continue;
    }
    sections[sections.length - 1].body.push(line);
  }

  const out: DocumentChunk[] = [];
  for (const section of sections) {
    const body = section.body.join('\n').trim();
    if (!body) continue;
    for (const piece of chunkContent(body, maxChunkSize)) {
      out.push({ ordinal: out.length, heading: section.heading, text: piece });
    }
  }
  return out;
}
