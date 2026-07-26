#!/usr/bin/env node
// Single source of truth -> generated surfaces.
// Reads data/profile.json (structured) and regenerates:
//   1. the marked sections of README.md (stack, pinned, certifications, interests)
//   2. data/profile.cli.json (flattened strings consumed by the npx lpsm-dev CLI)
// The `commits` section comes from data/commits.json, written by scripts/commits.mjs.
// Run: `node scripts/render.mjs`. CI runs it with --check to fail on drift.
import {existsSync, readFileSync, writeFileSync} from 'node:fs';

const root = new URL('..', import.meta.url).pathname;
const readJson = (path) => JSON.parse(readFileSync(root + path, 'utf8'));
const data = readJson('data/profile.json');
const commits = existsSync(root + 'data/commits.json') ? readJson('data/commits.json') : null;
const check = process.argv.includes('--check');

// ---------- README section renderers ----------
const renderInterests = () => `<samp>${data.en.interests.join(' · ')}</samp>`;

const renderStack = () =>
  ['<p>', ...data.stack.map((t) => `  <img alt="${t.name}" src="${t.badge}">`), '</p>'].join('\n');

const starBadge = (name) =>
  `![stars](https://img.shields.io/github/stars/lpsm-dev/${name}?style=flat-square&labelColor=black&color=white&label=%E2%98%85)`;

const renderPinned = () =>
  [
    '| repo | description | stars |',
    '| --- | --- | --- |',
    ...data.projects.map((p) => `| [${p.name}](${p.url}) | ${p.description} | ${starBadge(p.name)} |`),
    '',
    '[all repositories →](https://github.com/lpsm-dev?tab=repositories)',
  ].join('\n');

function renderCerts() {
  const c = data.certifications;
  const lines = [`<samp>${c.count} verified badges on [credly](${c.credly})</samp>`, ''];
  let i = 0;
  for (const size of c.rows) {
    const row = c.items.slice(i, i + size);
    i += size;
    const imgs = row.map(
      (b) => `  <a href="${b.badge}"><img alt="${b.name}" src="${b.image}" width="110"></a>`,
    );
    lines.push('<p align="center">', ...imgs, '</p>', '');
  }
  lines.pop();
  return lines.join('\n');
}

// Unicode eighth-blocks: one full block per 8 filled eighths, ░ for the remainder.
function bar(percent, size) {
  const syms = '░▏▎▍▌▋▊▉█';
  const eighths = Math.floor((size * 8 * percent) / 100);
  const full = Math.floor(eighths / 8);
  if (full >= size) return syms[8].repeat(size);
  const semi = eighths % 8;
  return (syms[8].repeat(full) + syms[semi]).padEnd(size, syms[0]);
}

function renderCommits() {
  const pad = Math.max(...commits.buckets.map((b) => b.key.length));
  const lines = commits.buckets.map((b) => {
    const percent = (b.commits / commits.total) * 100;
    return [
      b.key.padEnd(pad),
      b.range.padStart(7),
      `${String(b.commits).padStart(5)} commits`,
      bar(percent, 21),
      `${percent.toFixed(1).padStart(5)}%`,
    ].join('  ');
  });
  return [
    '```text',
    ...lines,
    '```',
    '',
    `<samp>${commits.total} commits · ${commits.timezone} · updated ${commits.generated}</samp>`,
  ].join('\n');
}

// ---------- CLI flattening ----------
const GROUPS = [
  ['languages', 'Languages'],
  ['cloud', 'Cloud'],
  ['containers', 'Containers'],
  ['iac', 'IaC'],
  ['cicd', 'CI/CD'],
  ['observability', 'Observability'],
  ['ai', 'AI'],
  ['frontend', 'Frontend'],
  ['os', 'OS'],
  ['tools', 'Tools'],
];
const stackPad = Math.max(...GROUPS.map(([, l]) => l.length)) + 2;
const flattenStack = () =>
  GROUPS.filter(([g]) => data.stack.some((t) => t.group === g)).map(([g, label]) => {
    const names = data.stack.filter((t) => t.group === g).map((t) => t.name).join(', ');
    return `${(label + ':').padEnd(stackPad)}${names}`;
  });

const projPad = Math.max(...data.projects.map((p) => p.name.length), 'more'.length);
const flattenProjects = (moreLabel) => [
  ...data.projects.map((p) => `${p.name.padEnd(projPad)} - ${p.url.replace(/^https:\/\//, '')}`),
  `${moreLabel.padEnd(projPad)} - github.com/lpsm-dev?tab=repositories`,
];

const flattenCerts = (lang) => [
  ...data.certifications.items.map((i) => i.name),
  `${data.certifications.count} ${data.certifications.note[lang]} - credly.com/users/lucca-matos`,
];

function buildCli() {
  const stack = flattenStack();
  const en = {
    whoami: data.en.whoami,
    now: data.en.now,
    languages: data.en.languages,
    stack,
    projects: flattenProjects('more'),
    certifications: flattenCerts('en'),
    interests: data.en.interests,
    contact: data.en.contact,
  };
  const pt = {
    whoami: data.pt.whoami,
    agora: data.pt.agora,
    linguagens: data.pt.linguagens,
    stack,
    projetos: flattenProjects('mais'),
    'certificações': flattenCerts('pt'),
    interesses: data.pt.interesses,
    contato: data.pt.contato,
  };
  return {en, pt};
}

// ---------- apply ----------
function replaceSection(md, key, content) {
  const re = new RegExp(`(<!-- gen:${key}:start -->\\n)[\\s\\S]*?(\\n<!-- gen:${key}:end -->)`);
  if (!re.test(md)) throw new Error(`marker not found for section: ${key}`);
  return md.replace(re, `$1${content}$2`);
}

let readme = readFileSync(root + 'README.md', 'utf8');
readme = replaceSection(readme, 'stack', renderStack());
readme = replaceSection(readme, 'pinned', renderPinned());
readme = replaceSection(readme, 'certifications', renderCerts());
readme = replaceSection(readme, 'interests', renderInterests());
if (commits?.total) readme = replaceSection(readme, 'commits', renderCommits());
const cli = JSON.stringify(buildCli(), null, 2) + '\n';

if (check) {
  const curReadme = readFileSync(root + 'README.md', 'utf8');
  const curCli = readFileSync(root + 'data/profile.cli.json', 'utf8');
  if (curReadme !== readme || curCli !== cli) {
    console.error('drift: README.md or data/profile.cli.json is out of sync with data/profile.json');
    console.error('run `node scripts/render.mjs` and commit the result.');
    process.exit(1);
  }
  console.log('render check passed: surfaces in sync with the source of truth');
} else {
  writeFileSync(root + 'README.md', readme);
  writeFileSync(root + 'data/profile.cli.json', cli);
  console.log('rendered README.md sections + data/profile.cli.json from data/profile.json');
}
