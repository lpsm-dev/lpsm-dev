#!/usr/bin/env node
// Buckets my commit timestamps by time of day and writes data/commits.json.
// scripts/render.mjs turns that file into the `$ commits` README section.
// Ported from lpsm-dev/productive-box, which published the same chart to a Gist.
// Run: `GH_TOKEN=... TIMEZONE=America/Sao_Paulo node scripts/commits.mjs`
import {writeFileSync} from 'node:fs';

const root = new URL('..', import.meta.url).pathname;
const token = process.env.GH_TOKEN;
const timezone = process.env.TIMEZONE || 'America/Sao_Paulo';
const BRANCHES = ['main', 'master'];
const BUCKETS = [
  {key: 'morning', range: '6h-12h', from: 6, to: 12},
  {key: 'daytime', range: '12h-18h', from: 12, to: 18},
  {key: 'evening', range: '18h-24h', from: 18, to: 24},
  {key: 'night', range: '0h-6h', from: 0, to: 6},
];

if (!token) {
  console.error('GH_TOKEN is required: a token with the `repo` scope.');
  process.exit(1);
}

async function graphql(query) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {authorization: `bearer ${token}`, 'content-type': 'application/json'},
    body: JSON.stringify({query}),
  });
  if (!res.ok) throw new Error(`github graphql: ${res.status} ${res.statusText}`);
  const body = await res.json();
  if (body.errors) throw new Error(`github graphql: ${body.errors.map((e) => e.message).join('; ')}`);
  return body.data;
}

// ---------- queries ----------
const viewerQuery = `
  query {
    viewer {
      login
      id
    }
  }
`;

const contributedReposQuery = (login) => `
  query {
    user(login: "${login}") {
      repositoriesContributedTo(last: 100, includeUserRepositories: true) {
        nodes {
          isFork
          name
          owner {
            login
          }
        }
      }
    }
  }
`;

const commitDatesQuery = (id, owner, name, branch) => `
  query {
    repository(owner: "${owner}", name: "${name}") {
      ref(qualifiedName: "${branch}") {
        target {
          ... on Commit {
            history(first: 100, author: {id: "${id}"}) {
              nodes {
                committedDate
              }
            }
          }
        }
      }
    }
  }
`;

// ---------- collection ----------
async function fetchRepos(login) {
  const data = await graphql(contributedReposQuery(login));
  return data.user.repositoriesContributedTo.nodes
    .filter((repo) => !repo.isFork)
    .map((repo) => ({name: repo.name, owner: repo.owner.login}));
}

async function fetchDates(id, {owner, name}) {
  for (const branch of BRANCHES) {
    const data = await graphql(commitDatesQuery(id, owner, name, branch)).catch((error) => {
      console.error(`skipping ${owner}/${name}@${branch}: ${error.message}`);
      return null;
    });
    const nodes = data?.repository?.ref?.target?.history?.nodes ?? [];
    if (nodes.length) return nodes.map((node) => node.committedDate);
  }
  return [];
}

function localHour(committedDate) {
  const time = new Date(committedDate).toLocaleTimeString('en-US', {hour12: false, timeZone: timezone});
  return Number(time.split(':')[0]) % 24;
}

function bucketize(dates) {
  const counts = new Map(BUCKETS.map((bucket) => [bucket.key, 0]));
  for (const date of dates) {
    const hour = localHour(date);
    const bucket = BUCKETS.find((b) => hour >= b.from && hour < b.to);
    if (bucket) counts.set(bucket.key, counts.get(bucket.key) + 1);
  }
  return BUCKETS.map(({key, range}) => ({key, range, commits: counts.get(key)}));
}

const {login, id} = (await graphql(viewerQuery)).viewer;
const repos = await fetchRepos(login);
console.log(`collecting commit timestamps from ${repos.length} repositories as ${login}`);

const dates = (await Promise.all(repos.map((repo) => fetchDates(id, repo)))).flat();
const buckets = bucketize(dates);
const commits = {
  timezone,
  generated: new Date().toISOString().slice(0, 10),
  total: dates.length,
  buckets,
};

writeFileSync(root + 'data/commits.json', JSON.stringify(commits, null, 2) + '\n');
console.log(`wrote data/commits.json: ${dates.length} commits across ${buckets.length} buckets`);
