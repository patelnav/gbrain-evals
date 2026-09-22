/**
 * amara-life-v1 → gbrain pages.
 *
 * One page per corpus-manifest item, keyed by the manifest slug. Markdown
 * items (notes, meetings, docs) are passed through verbatim so gbrain parses
 * their frontmatter exactly as it would on a real import. JSONL and ICS
 * container items (emails, Slack messages, calendar events) are rendered as
 * small Markdown pages that keep every stored field a person would see:
 * subject, sender, recipients, timestamp, thread, channel, and body.
 *
 * The renderer is deterministic and reads only committed corpus files, so
 * two runs on the same commit ingest byte-identical pages.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

export const AMARA_LIFE_DIR = 'eval/data/amara-life-v1';
export const AMARA_LIFE_MANIFEST = `${AMARA_LIFE_DIR}/corpus-manifest.json`;

export type AmaraItemType = 'email' | 'slack' | 'calendar-event' | 'note' | 'meeting' | 'source';

export interface AmaraPage {
  slug: string;
  type: AmaraItemType;
  /** Corpus file the page was rendered from, relative to the repo root. */
  path: string;
  /** Markdown handed to gbrain's importFromContent. */
  content: string;
}

interface ManifestItem {
  slug: string;
  path: string;
  type: AmaraItemType;
}

interface Manifest {
  corpus_id: string;
  items: ManifestItem[];
}

interface EmailRecord {
  slug: string;
  ts: string;
  from: { name: string; email: string };
  to: Array<{ name: string; email: string }>;
  subject: string;
  thread_id: string;
  body_text: string;
}

interface SlackRecord {
  slug: string;
  ts: string;
  channel: string;
  user: { name: string; handle: string };
  thread_ts: string | null;
  text: string;
}

interface CalendarEvent {
  slug: string;
  summary: string;
  start: string;
  end: string;
  location?: string;
  attendees: string[];
}

function readJsonl<T>(path: string): T[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(line => line.trim())
    .map(line => JSON.parse(line) as T);
}

function person(p: { name: string; email: string }): string {
  return `${p.name} <${p.email}>`;
}

function renderEmail(e: EmailRecord): string {
  return [
    `# ${e.subject}`,
    '',
    `From: ${person(e.from)}`,
    `To: ${e.to.map(person).join(', ')}`,
    `Date: ${e.ts}`,
    `Thread: ${e.thread_id}`,
    '',
    e.body_text,
    '',
  ].join('\n');
}

function renderSlack(m: SlackRecord): string {
  return [
    `# ${m.channel} message from ${m.user.name}`,
    '',
    `Channel: ${m.channel}`,
    `From: ${m.user.name} (@${m.user.handle})`,
    `Date: ${m.ts}`,
    ...(m.thread_ts ? [`Thread started: ${m.thread_ts}`] : []),
    '',
    m.text,
    '',
  ].join('\n');
}

function renderCalendarEvent(ev: CalendarEvent): string {
  return [
    `# ${ev.summary}`,
    '',
    `Start: ${ev.start}`,
    `End: ${ev.end}`,
    ...(ev.location ? [`Location: ${ev.location}`] : []),
    `Attendees: ${ev.attendees.join(', ')}`,
    '',
  ].join('\n');
}

/** ICS basic-format UTC timestamp (20260414T010000Z) → ISO 8601. */
function icsTimeToIso(value: string): string {
  const d = value.slice(0, 8);
  const t = value.slice(9, 15);
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}Z`;
}

/**
 * Minimal RFC 5545 reader for the generator's calendar.ics: unfolded
 * `NAME;PARAMS:VALUE` content lines inside VEVENT blocks. Event slugs follow
 * the manifest convention `cal/<UID local part>`.
 */
function parseCalendar(path: string): CalendarEvent[] {
  const events: CalendarEvent[] = [];
  let current: Partial<CalendarEvent> & { attendees?: string[] } | null = null;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const rawLine = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (!rawLine) continue;
    if (rawLine.startsWith(' ') || rawLine.startsWith('\t')) {
      throw new Error(`${path}: folded ICS lines are not supported by this reader`);
    }
    const colon = rawLine.indexOf(':');
    if (colon < 0) continue;
    const head = rawLine.slice(0, colon);
    const value = rawLine.slice(colon + 1);
    const [name, ...params] = head.split(';');
    if (name === 'BEGIN' && value === 'VEVENT') {
      current = { attendees: [] };
    } else if (name === 'END' && value === 'VEVENT') {
      if (!current?.slug || !current.summary || !current.start || !current.end) {
        throw new Error(`${path}: incomplete VEVENT`);
      }
      events.push(current as CalendarEvent);
      current = null;
    } else if (current) {
      if (name === 'UID') current.slug = `cal/${value.split('@')[0]}`;
      else if (name === 'SUMMARY') current.summary = value;
      else if (name === 'DTSTART') current.start = icsTimeToIso(value);
      else if (name === 'DTEND') current.end = icsTimeToIso(value);
      else if (name === 'LOCATION') current.location = value;
      else if (name === 'ATTENDEE') {
        const cn = params.find(p => p.startsWith('CN='))?.slice(3);
        const email = value.startsWith('mailto:') ? value.slice('mailto:'.length) : value;
        current.attendees!.push(cn ? `${cn} <${email}>` : email);
      }
    }
  }
  return events;
}

/**
 * Load every manifest item as a gbrain page, in manifest order. Throws when
 * a manifest slug has no backing record or a container holds an unlisted one,
 * so the ingested corpus always equals the declared corpus.
 */
export function loadAmaraLifePages(root = AMARA_LIFE_DIR): AmaraPage[] {
  const manifest = JSON.parse(readFileSync(join(root, 'corpus-manifest.json'), 'utf8')) as Manifest;
  if (manifest.corpus_id !== 'amara-life-v1') {
    throw new Error(`${root}: expected corpus_id amara-life-v1, got ${manifest.corpus_id}`);
  }

  const rendered = new Map<string, string>();
  const containers = new Set<string>();
  for (const item of manifest.items) {
    if (containers.has(item.path)) continue;
    const file = join(root, item.path);
    if (item.type === 'email') {
      containers.add(item.path);
      for (const e of readJsonl<EmailRecord>(file)) rendered.set(e.slug, renderEmail(e));
    } else if (item.type === 'slack') {
      containers.add(item.path);
      for (const m of readJsonl<SlackRecord>(file)) rendered.set(m.slug, renderSlack(m));
    } else if (item.type === 'calendar-event') {
      containers.add(item.path);
      for (const ev of parseCalendar(file)) rendered.set(ev.slug, renderCalendarEvent(ev));
    } else {
      rendered.set(item.slug, readFileSync(file, 'utf8'));
    }
  }

  const pages = manifest.items.map((item): AmaraPage => {
    const content = rendered.get(item.slug);
    if (content === undefined) {
      throw new Error(`${root}: manifest slug ${item.slug} has no record in ${item.path}`);
    }
    return { slug: item.slug, type: item.type, path: join(root, item.path), content };
  });
  if (rendered.size !== pages.length) {
    const listed = new Set(pages.map(p => p.slug));
    const extra = [...rendered.keys()].filter(slug => !listed.has(slug));
    throw new Error(`${root}: container records missing from manifest: ${extra.slice(0, 5).join(', ')}`);
  }
  return pages;
}

/** Distinct corpus files backing the pages, for eval-pack input_refs. */
export function amaraLifeSourceFiles(pages: AmaraPage[]): string[] {
  return [...new Set(pages.map(p => p.path))].sort();
}
