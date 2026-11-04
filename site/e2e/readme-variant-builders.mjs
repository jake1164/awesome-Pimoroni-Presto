// README variants for e2e/readme-variants.mjs. Every builder takes README text and returns the changed text, or
// `{ skip: reason }` when the change does not apply to that README (a single-category catalog cannot lose a category and
// still have one). Nothing here names a category: categories and projects are found by reading the README itself, so any
// valid README works. Pure functions, no I/O, so tests/readme-variants.test.mjs can run them on many READMEs quickly.

export const startMarker = '<!-- catalog:start -->';
export const endMarker = '<!-- catalog:end -->';

export function splitReadme(text) {
  const from = text.indexOf(startMarker) + startMarker.length;
  const to = text.indexOf(endMarker);
  return { before: text.slice(0, from), body: text.slice(from, to).split(/\r?\n/), after: text.slice(to) };
}
export const joinReadme = ({ before, body, after }) => `${before}${body.join('\n')}${after}`;
export const isProject = (line) => /^- \[[^\]]+\]\(https?:\/\//.test(line);
export const isHeading = (line) => /^### /.test(line);
const headingName = (line) => line.replace(/^###\s+/, '').trim();

// `change` gets the catalog's lines and returns the new lines, or `{ skip }` (passed through unchanged).
const withBody = (change) => (text) => {
  const parts = splitReadme(text);
  const body = change(parts.body);
  return Array.isArray(body) ? joinReadme({ ...parts, body }) : body;
};

/** Every category of the catalog body in order: `{ name, start, end, projects }`, `end` exclusive. */
export function categoriesOf(lines) {
  const found = [];
  lines.forEach((line, index) => {
    if (isHeading(line)) found.push({ name: headingName(line), start: index, end: lines.length, projects: 0 });
  });
  found.forEach((category, index) => {
    if (index + 1 < found.length) category.end = found[index + 1].start;
    category.projects = lines.slice(category.start, category.end).filter(isProject).length;
  });
  return found;
}

/** Removes a whole category: its heading and everything up to the next heading. */
export const dropCategory = (lines, category) => [...lines.slice(0, category.start), ...lines.slice(category.end)];

/** README text without the category called `name`, or null when there is none. For tests that need a specific category gone. */
export function withoutCategory(text, name) {
  const parts = splitReadme(text);
  const category = categoriesOf(parts.body).find((item) => item.name === name);
  return category ? joinReadme({ ...parts, body: dropCategory(parts.body, category) }) : null;
}

export const variants = {
  'unchanged README': (text) => text,

  'clocks removed (every project that mentions a clock)': withBody((lines) => lines.filter((line) => !(isProject(line) && /clock/i.test(line)))),

  // The last category that has projects, provided another one keeps the catalog from becoming empty.
  'a whole category disappears': withBody((lines) => {
    const populated = categoriesOf(lines).filter((category) => category.projects > 0);
    if (populated.length < 2) return { skip: 'needs two categories with projects' };
    return dropCategory(lines, populated.at(-1));
  }),

  // The first category with projects takes the name All, so the catalog's own "All" chip must not collide with it.
  'a category named All': withBody((lines) => {
    const all = categoriesOf(lines);
    if (all.some((category) => category.name.toLowerCase() === 'all')) return lines; // the README already has one
    const target = all.find((category) => category.projects > 0) ?? all[0];
    if (!target) return { skip: 'the README has no category' };
    return lines.map((line, index) => (index === target.start ? '### All' : line));
  }),

  'no NEW or RECENT badges': withBody((lines) => lines.map((line) => line.replace(/\s*!\[(NEW|RECENT)\]\([^)]*\)/g, ''))),

  'a project added to the README only': withBody((lines) => {
    const first = lines.findIndex(isHeading);
    if (first < 0) return { skip: 'the README has no category' };
    return [...lines.slice(0, first + 1), '', '- [Brand New Presto Thing](https://example.org/brand-new-presto-thing) — Added only in the README. ![NEW](badges/new.svg)', ...lines.slice(first + 1)];
  }),

  'every description shares a word': withBody((lines) => lines.map((line) => {
    if (!isProject(line)) return line;
    // The separator after the link, never a dash inside the title.
    const [, link, rest] = line.match(/^(- \[.*?\]\(https?:\/\/[^)\s]*\))\s*(?:[—–-]\s+)?(.*)$/);
    return `${link} — Everywhere.${rest ? ` ${rest}` : ''}`;
  })),

  'one category, one project': withBody((lines) => {
    const first = categoriesOf(lines).find((category) => category.projects > 0);
    if (!first) return { skip: 'the README has no project' };
    const project = lines.findIndex((line, index) => index > first.start && isProject(line));
    return ['', lines[first.start], '', lines[project], ''];
  }),
};
