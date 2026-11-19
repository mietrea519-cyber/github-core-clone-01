// A GitHub-compatible git forge in one Node process: git smart HTTP
// (upload-pack v2/v0, receive-pack v0), REST v3, GraphQL v4 and MCP,
// all served from one in-memory store. Node standard library only.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

const JSON_TYPE = 'application/json; charset=utf-8';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const VIEWER = { id: 1000, login: 'adaiversen', name: 'ada iversen', email: 'adaiversen@example.invalid', type: 'User' };
const START = Date.now();

function nowIso(): string { return new Date().toISOString(); }
function sha1hex(data: Buffer): string { return createHash('sha1').update(data).digest('hex'); }

// ---------------------------------------------------------------------------
// Git object store (content-addressed, shared by every repository)
// ---------------------------------------------------------------------------

interface GitObject { t: string; d: Buffer }
const objects = new Map<string, GitObject>();

function writeObject(t: string, d: Buffer): string {
  const head = Buffer.from(`${t} ${d.length}\0`, 'utf8');
  const sha = sha1hex(Buffer.concat([head, d]));
  if (!objects.has(sha)) objects.set(sha, { t, d });
  return sha;
}
function readObject(sha: string): GitObject | undefined { return objects.get(sha); }

interface TreeEntry { mode: string; name: string; sha: string }
function parseTree(sha: string): TreeEntry[] {
  const obj = readObject(sha);
  if (!obj || obj.t !== 'tree') return [];
  const out: TreeEntry[] = [];
  let i = 0;
  while (i < obj.d.length) {
    const sp = obj.d.indexOf(0x20, i);
    const mode = obj.d.toString('utf8', i, sp);
    const nul = obj.d.indexOf(0x00, sp);
    const name = obj.d.toString('utf8', sp + 1, nul);
    const entrySha = obj.d.toString('hex', nul + 1, nul + 21);
    out.push({ mode, name, sha: entrySha });
    i = nul + 21;
  }
  return out;
}
function writeTree(entries: TreeEntry[]): string {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.sha, 'hex'));
  }
  return writeObject('tree', Buffer.concat(parts));
}
/** Flatten a tree into path -> entry, recursing into subtrees. */
function flattenTree(treeSha: string, prefix = '', out = new Map<string, { mode: string; sha: string }>()): Map<string, { mode: string; sha: string }> {
  for (const e of parseTree(treeSha)) {
    if (e.mode === '40000') flattenTree(e.sha, `${prefix}${e.name}/`, out);
    else out.set(`${prefix}${e.name}`, { mode: e.mode, sha: e.sha });
  }
  return out;
}
/** Rebuild a tree from a flat path map. */
function treeFromFlat(flat: Map<string, { mode: string; sha: string }>): string {
  interface Node { files: Map<string, { mode: string; sha: string }>; dirs: Map<string, Node> }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, ent] of flat) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node.dirs.has(parts[i])) node.dirs.set(parts[i], { files: new Map(), dirs: new Map() });
      node = node.dirs.get(parts[i])!;
    }
    node.files.set(parts[parts.length - 1], ent);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, ent] of node.files) entries.push({ mode: ent.mode, name, sha: ent.sha });
    for (const [name, sub] of node.dirs) entries.push({ mode: '40000', name, sha: build(sub) });
    return writeTree(entries);
  };
  return build(root);
}

interface CommitInfo { tree: string; parents: string[]; author: string; committer: string; message: string }
function parseCommit(sha: string): CommitInfo | undefined {
  const obj = readObject(sha);
  if (!obj || obj.t !== 'commit') return undefined;
  const text = obj.d.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const info: CommitInfo = { tree: '', parents: [], author: '', committer: '', message: split === -1 ? '' : text.slice(split + 2) };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) info.tree = line.slice(5);
    else if (line.startsWith('parent ')) info.parents.push(line.slice(7));
    else if (line.startsWith('author ')) info.author = line.slice(7);
    else if (line.startsWith('committer ')) info.committer = line.slice(10);
  }
  return info;
}
function ident(ts?: number): string {
  const when = ts ?? Math.floor(Date.now() / 1000);
  return `${VIEWER.name} <${VIEWER.email}> ${when} +0000`;
}
function writeCommit(tree: string, parents: string[], message: string, ts?: number): string {
  const id = ident(ts);
  let text = `tree ${tree}\n`;
  for (const p of parents) text += `parent ${p}\n`;
  text += `author ${id}\ncommitter ${id}\n\n${message}`;
  return writeObject('commit', Buffer.from(text, 'utf8'));
}
/** All commits reachable from a tip, newest first (BFS by insertion). */
function reachableCommits(tip: string): Set<string> {
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length) {
    const cur = queue.pop()!;
    if (!cur || seen.has(cur)) continue;
    const c = parseCommit(cur);
    if (!c) continue;
    seen.add(cur);
    queue.push(...c.parents);
  }
  return seen;
}
function isAncestor(anc: string, tip: string): boolean {
  if (anc === tip) return true;
  return reachableCommits(tip).has(anc);
}
function mergeBase(a: string, b: string): string | undefined {
  const fromA = reachableCommits(a);
  const queue = [b];
  const seen = new Set<string>();
  while (queue.length) {
    const cur = queue.shift()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    if (fromA.has(cur)) return cur;
    const c = parseCommit(cur);
    if (c) queue.push(...c.parents);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Repository store
// ---------------------------------------------------------------------------

interface Label { name: string; color: string; description: string }
interface IssueRec {
  number: number; title: string; body: string; state: 'open' | 'closed';
  labels: string[]; created_at: string; updated_at: string; isPull: boolean;
  comments: { id: number; body: string; created_at: string; user: typeof VIEWER }[];
}
interface PullRec {
  number: number; title: string; body: string; state: 'open' | 'closed';
  head: string; base: string; merged: boolean; merged_at: string | null; merge_commit_sha: string | null;
  created_at: string; updated_at: string;
}
interface Repo {
  id: number; name: string; owner: string; isPrivate: boolean; description: string;
  defaultBranch: string; created_at: string; updated_at: string;
  refs: Map<string, string>; labels: Label[]; issues: IssueRec[]; pulls: PullRec[];
  nextNumber: number; nextCommentId: number;
}
const repos = new Map<string, Repo>();
let nextRepoId = 5000;
function repoKey(owner: string, name: string): string { return `${owner}/${name}`; }
function findRepo(owner: string, name: string): Repo | undefined {
  const r = repos.get(repoKey(owner, name));
  if (!r || r.owner !== VIEWER.login) return undefined;
  return r;
}
function repoJson(r: Repo): Record<string, unknown> {
  return {
    id: r.id, name: r.name, full_name: `${r.owner}/${r.name}`,
    owner: { login: r.owner, id: VIEWER.id, type: 'User' },
    private: r.isPrivate, description: r.description, fork: false,
    html_url: `/${r.owner}/${r.name}`, clone_url: `/${r.owner}/${r.name}.git`,
    default_branch: r.defaultBranch, created_at: r.created_at, updated_at: r.updated_at,
    pushed_at: r.updated_at, size: 1, stargazers_count: 0, watchers_count: 0, forks_count: 0,
    open_issues_count: r.issues.filter((i) => i.state === 'open').length,
    has_issues: true, has_projects: true, has_wiki: true, has_pages: false,
    archived: false, disabled: false, visibility: r.isPrivate ? 'private' : 'public',
  };
}
function branchTip(r: Repo, branch: string): string | undefined { return r.refs.get(`refs/heads/${branch}`); }
function tipTree(r: Repo, branch: string): string | undefined {
  const tip = branchTip(r, branch);
  if (!tip) return undefined;
  return parseCommit(tip)?.tree;
}
/** Commit a flat file map onto a branch; returns the new commit sha. */
function commitFlat(r: Repo, branch: string, flat: Map<string, { mode: string; sha: string }>, message: string): string {
  const tree = treeFromFlat(flat);
  const parent = branchTip(r, branch);
  const sha = writeCommit(tree, parent ? [parent] : [], message);
  r.refs.set(`refs/heads/${branch}`, sha);
  r.updated_at = nowIso();
  return sha;
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

function requestId(): string { return randomBytes(8).toString('hex'); }
function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId(), 'x-github-media-type': 'github.v3',
    ...headers,
  });
  res.end(text);
}
function sendRaw(res: ServerResponse, status: number, data: Buffer, contentType: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': data.length, 'x-github-request-id': requestId(), ...headers });
  res.end(data);
}
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function authed(req: IncomingMessage): boolean {
  if (TOKEN === '') return true;
  return req.headers.authorization === `Bearer ${TOKEN}`;
}
function notFound(res: ServerResponse): void { sendJson(res, 404, { message: 'Not Found', documentation_url: '' }); }
function badRequest(res: ServerResponse, message = 'Problems parsing JSON'): void { sendJson(res, 400, { message }); }

interface Ctx { req: IncomingMessage; res: ServerResponse; url: URL; body: Buffer }
async function parseJsonBody(ctx: Ctx): Promise<Record<string, unknown> | null> {
  if (ctx.body.length === 0) return {};
  try {
    const value = JSON.parse(ctx.body.toString('utf8')) as unknown;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
    return value as Record<string, unknown>;
  } catch {
    badRequest(ctx.res);
    return null;
  }
}
function str(v: unknown, fallback = ''): string { return typeof v === 'string' ? v : fallback; }
function pageParams(url: URL): { page: number; perPage: number } {
  const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, parseInt(url.searchParams.get('per_page') ?? '30', 10) || 30));
  return { page, perPage };
}
function paginate<T>(ctx: Ctx, items: T[]): T[] {
  const { page, perPage } = pageParams(ctx.url);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  if (page < totalPages) {
    const next = new URL(ctx.url.toString());
    next.searchParams.set('page', String(page + 1));
    next.searchParams.set('per_page', String(perPage));
    const last = new URL(ctx.url.toString());
    last.searchParams.set('page', String(totalPages));
    last.searchParams.set('per_page', String(perPage));
    ctx.res.setHeader('link', `<${next.pathname}${next.search}>; rel="next", <${last.pathname}${last.search}>; rel="last"`);
  }
  return items.slice((page - 1) * perPage, page * perPage);
}

// ---------------------------------------------------------------------------
// REST v3: repositories and contents
// ---------------------------------------------------------------------------

async function createRepo(ctx: Ctx): Promise<void> {
  const body = await parseJsonBody(ctx);
  if (!body) return;
  const name = str(body.name);
  if (name === '') { sendJson(ctx.res, 422, { message: 'Validation Failed', errors: [{ resource: 'Repository', field: 'name', code: 'missing_field' }] }); return; }
  if (repos.has(repoKey(VIEWER.login, name))) { sendJson(ctx.res, 422, { message: 'Validation Failed', errors: [{ resource: 'Repository', field: 'name', code: 'custom', message: 'name already exists on this account' }] }); return; }
  const repo: Repo = {
    id: nextRepoId++, name, owner: VIEWER.login,
    isPrivate: body.private === true, description: str(body.description),
    defaultBranch: str(body.default_branch, 'main') || 'main',
    created_at: nowIso(), updated_at: nowIso(),
    refs: new Map(), labels: [], issues: [], pulls: [], nextNumber: 1, nextCommentId: 1,
  };
  repos.set(repoKey(repo.owner, name), repo);
  sendJson(ctx.res, 201, repoJson(repo));
}

function getRepo(ctx: Ctx, owner: string, name: string): void {
  const r = findRepo(owner, name);
  if (!r) { notFound(ctx.res); return; }
  sendJson(ctx.res, 200, repoJson(r));
}

async function patchRepo(ctx: Ctx, owner: string, name: string): Promise<void> {
  const r = findRepo(owner, name);
  if (!r) { notFound(ctx.res); return; }
  const body = await parseJsonBody(ctx);
  if (!body) return;
  if (typeof body.description === 'string') r.description = body.description;
  if (typeof body.private === 'boolean') r.isPrivate = body.private;
  if (typeof body.default_branch === 'string' && body.default_branch !== '') r.defaultBranch = body.default_branch;
  if (typeof body.name === 'string' && body.name !== '' && body.name !== r.name) {
    repos.delete(repoKey(r.owner, r.name));
    r.name = body.name;
    repos.set(repoKey(r.owner, r.name), r);
  }
  r.updated_at = nowIso();
  sendJson(ctx.res, 200, repoJson(r));
}

function deleteRepo(ctx: Ctx, owner: string, name: string): void {
  const r = findRepo(owner, name);
  if (!r) { notFound(ctx.res); return; }
  repos.delete(repoKey(owner, name));
  ctx.res.writeHead(204, { 'x-github-request-id': requestId() });
  ctx.res.end();
}

function listUserRepos(ctx: Ctx): void {
  const mine = [...repos.values()].filter((r) => r.owner === VIEWER.login).sort((a, b) => a.id - b.id);
  sendJson(ctx.res, 200, paginate(ctx, mine).map(repoJson));
}

function commitJson(sha: string): Record<string, unknown> {
  const c = parseCommit(sha);
  const m = c?.author.match(/^(.*) <(.*)> (\d+) /);
  return {
    sha,
    commit: {
      tree: { sha: c?.tree ?? '' },
      message: c?.message ?? '',
      author: { name: m?.[1] ?? '', email: m?.[2] ?? '', date: new Date(Number(m?.[3] ?? 0) * 1000).toISOString() },
      committer: { name: m?.[1] ?? '', email: m?.[2] ?? '', date: new Date(Number(m?.[3] ?? 0) * 1000).toISOString() },
    },
    parents: (c?.parents ?? []).map((p) => ({ sha: p })),
    author: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    committer: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
  };
}

function resolveRef(r: Repo, ref: string): string | undefined {
  if (/^[0-9a-f]{40}$/.test(ref) && readObject(ref)?.t === 'commit') return ref;
  return branchTip(r, ref) ?? r.refs.get(ref.startsWith('refs/') ? ref : `refs/heads/${ref}`);
}

async function putContent(ctx: Ctx, owner: string, name: string, path: string): Promise<void> {
  const r = findRepo(owner, name);
  if (!r) { notFound(ctx.res); return; }
  const body = await parseJsonBody(ctx);
  if (!body) return;
  const message = str(body.message);
  const contentB64 = str(body.content);
  if (message === '' || contentB64 === '') { sendJson(ctx.res, 422, { message: 'Validation Failed' }); return; }
  const branch = str(body.branch, r.defaultBranch) || r.defaultBranch;
  const tree = tipTree(r, branch);
  const flat = tree ? flattenTree(tree) : new Map<string, { mode: string; sha: string }>();
  const existing = flat.get(path);
  const givenSha = str(body.sha);
  if (existing && givenSha === '') { sendJson(ctx.res, 422, { message: 'Validation Failed', errors: [{ resource: 'Content', field: 'sha', code: 'missing_field' }] }); return; }
  if (existing && givenSha !== '' && givenSha !== existing.sha) { sendJson(ctx.res, 409, { message: `${path} does not match ${givenSha}` }); return; }
  if (!existing && givenSha !== '') { sendJson(ctx.res, 422, { message: 'Validation Failed' }); return; }
  const data = Buffer.from(contentB64, 'base64');
  const blobSha = writeObject('blob', data);
  flat.set(path, { mode: '100644', sha: blobSha });
  const commitSha = commitFlat(r, branch, flat, message);
  const fileName = path.split('/').pop() ?? path;
  sendJson(ctx.res, existing ? 200 : 201, {
    content: { name: fileName, path, sha: blobSha, size: data.length, type: 'file' },
    commit: { sha: commitSha },
  });
}

function getContent(ctx: Ctx, owner: string, name: string, path: string): void {
  const r = findRepo(owner, name);
  if (!r) { notFound(ctx.res); return; }
  const ref = ctx.url.searchParams.get('ref') ?? r.defaultBranch;
  const tip = resolveRef(r, ref);
  const tree = tip ? parseCommit(tip)?.tree : undefined;
  if (!tree) { notFound(ctx.res); return; }
  const flat = flattenTree(tree);
  if (path === '') {
    const entries = [...flat.entries()].map(([p, e]) => ({ name: p.split('/').pop() ?? p, path: p, sha: e.sha, size: readObject(e.sha)?.d.length ?? 0, type: 'file' }));
    sendJson(ctx.res, 200, entries);
    return;
  }
  const ent = flat.get(path);
  if (ent) {
    const data = readObject(ent.sha)?.d ?? Buffer.alloc(0);
    sendJson(ctx.res, 200, {
      name: path.split('/').pop() ?? path, path, sha: ent.sha, size: data.length, type: 'file',
      content: data.toString('base64'), encoding: 'base64',
    });
    return;
  }
  const prefix = `${path}/`;
  const children = new Map<string, { name: string; path: string; sha: string; size: number; type: string }>();
  for (const [p, e] of flat) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    const first = rest.split('/')[0];
    if (rest.includes('/')) {
      if (!children.has(first)) children.set(first, { name: first, path: `${path}/${first}`, sha: '', size: 0, type: 'dir' });
    } else {
      children.set(first, { name: first, path: p, sha: e.sha, size: readObject(e.sha)?.d.length ?? 0, type: 'file' });
    }
  }
  if (children.size > 0) { sendJson(ctx.res, 200, [...children.values()]); return; }
  notFound(ctx.res);
}

async function deleteContent(ctx: Ctx, owner: string, name: string, path: string): Promise<void> {
  const r = findRepo(owner, name);
  if (!r) { notFound(ctx.res); return; }
  const body = await parseJsonBody(ctx);
  if (!body) return;
  const branch = str(body.branch, r.defaultBranch) || r.defaultBranch;
  const tree = tipTree(r, branch);
  const flat = tree ? flattenTree(tree) : new Map<string, { mode: string; sha: string }>();
  if (!flat.has(path)) { notFound(ctx.res); return; }
  flat.delete(path);
  const commitSha = commitFlat(r, branch, flat, str(body.message, `Delete ${path}`));
  sendJson(ctx.res, 200, { content: null, commit: { sha: commitSha } });
}

function listBranches(ctx: Ctx, owner: string, name: string): void {
  const r = findRepo(owner, name);
  if (!r) { notFound(ctx.res); return; }
  const out = [...r.refs.entries()]
    .filter(([ref]) => ref.startsWith('refs/heads/'))
    .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false }));
  sendJson(ctx.res, 200, paginate(ctx, out));
}

function getBranch(ctx: Ctx, owner: string, name: string, branch: string): void {
  const r = findRepo(owner, name);
  if (!r) { notFound(ctx.res); return; }
  const tip = branchTip(r, branch);
  if (!tip) { notFound(ctx.res); return; }
  sendJson(ctx.res, 200, { name: branch, commit: commitJson(tip), protected: false });
}

function listCommits(ctx: Ctx, owner: string, name: string): void {
  const r = findRepo(owner, name);
  if (!r) { notFound(ctx.res); return; }
  const shaParam = ctx.url.searchParams.get('sha') ?? r.defaultBranch;
  const tip = resolveRef(r, shaParam);
  if (!tip) { sendJson(ctx.res, 200, []); return; }
  const order: string[] = [];
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length) {
    const cur = queue.shift()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    order.push(cur);
    const c = parseCommit(cur);
    if (c) queue.push(...c.parents);
  }
  sendJson(ctx.res, 200, paginate(ctx, order).map(commitJson));
}

// ---------------------------------------------------------------------------
// REST v3: labels, issues, comments, pull requests
// ---------------------------------------------------------------------------

function labelJson(l: Label): Record<string, unknown> {
  return { name: l.name, color: l.color, description: l.description, default: false };
}
function issueJson(r: Repo, i: IssueRec): Record<string, unknown> {
  return {
    id: 9000 + i.number, number: i.number, title: i.title, body: i.body, state: i.state,
    labels: i.labels.map((n) => { const l = r.labels.find((x) => x.name === n); return l ? labelJson(l) : { name: n, color: 'ededed', description: '' }; }),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    comments: i.comments.length, created_at: i.created_at, updated_at: i.updated_at,
    closed_at: i.state === 'closed' ? i.updated_at : null,
  };
}
function pullJson(r: Repo, p: PullRec): Record<string, unknown> {
  const headTip = branchTip(r, p.head);
  const baseTip = branchTip(r, p.base);
  return {
    id: 7000 + p.number, number: p.number, title: p.title, body: p.body, state: p.state,
    merged: p.merged, merged_at: p.merged_at, merge_commit_sha: p.merge_commit_sha,
    head: { ref: p.head, sha: headTip ?? '', label: `${r.owner}:${p.head}` },
    base: { ref: p.base, sha: baseTip ?? '', label: `${r.owner}:${p.base}` },
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: p.created_at, updated_at: p.updated_at, closed_at: p.state === 'closed' ? p.updated_at : null,
    mergeable: null, draft: false,
  };
}

async function createLabel(ctx: Ctx, owner: string, name: string): Promise<void> {
  const r = findRepo(owner, name);
  if (!r) { notFound(ctx.res); return; }
  const body = await parseJsonBody(ctx);
  if (!body) return;
  const labelName = str(body.name);
  if (labelName === '') { sendJson(ctx.res, 422, { message: 'Validation Failed' }); return; }
  if (r.labels.some((l) => l.name === labelName)) { sendJson(ctx.res, 422, { message: 'Validation Failed', errors: [{ resource: 'Label', field: 'name', code: 'already_exists' }] }); return; }
  const label: Label = { name: labelName, color: str(body.color, 'ededed'), description: str(body.description) };
  r.labels.push(label);
  sendJson(ctx.res, 201, labelJson(label));
}

function listLabels(ctx: Ctx, owner: string, name: string): void {
  const r = findRepo(owner, name);
  if (!r) { notFound(ctx.res); return; }
  sendJson(ctx.res, 200, paginate(ctx, r.labels).map(labelJson));
}

async function createIssue(ctx: Ctx, owner: string, name: string): Promise<void> {
  const r = findRepo(owner, name);
  if (!r) { notFound(ctx.res); return; }
  const body = await parseJsonBody(ctx);
  if (!body) return;
  const labelNames = Array.isArray(body.labels) ? body.labels.filter((x): x is string => typeof x === 'string') : [];
  for (const ln of labelNames) {
    if (!r.labels.some((l) => l.name === ln)) {
      sendJson(ctx.res, 422, { message: 'Validation Failed', errors: [{ resource: 'Issue', field: 'labels', code: 'invalid', message: `label "${ln}" does not exist` }] });
      return;
    }
  }
  const issue: IssueRec = {
    number: r.nextNumber++, title: str(body.title), body: str(body.body), state: 'open',
    labels: labelNames, created_at: nowIso(), updated_at: nowIso(), isPull: false, comments: [],
  };
  r.issues.push(issue);
  sendJson(ctx.res, 201, issueJson(r, issue));
}

function listIssues(ctx: Ctx, owner: string, name: string): void {
  const r = findRepo(owner, name);
  if (!r) { notFound(ctx.res); return; }
  const state = ctx.url.searchParams.get('state') ?? 'open';
  let items = r.issues.filter((i) => !i.isPull);
  if (state === 'open') items = items.filter((i) => i.state === 'open');
  else if (state === 'closed') items = items.filter((i) => i.state === 'closed');
  sendJson(ctx.res, 200, paginate(ctx, items).map((i) => issueJson(r, i)));
}

function getIssue(ctx: Ctx, owner: string, name: string, num: number): void {
  const r = findRepo(owner, name);
  if (!r) { notFound(ctx.res); return; }
  const issue = r.issues.find((i) => i.number === num && !i.isPull);
  if (!issue) { notFound(ctx.res); return; }
  sendJson(ctx.res, 200, issueJson(r, issue));
}

async function patchIssue(ctx: Ctx, owner: string, name: string, num: number): Promise<void> {
  const r = findRepo(owner, name);
  if (!r) { notFound(ctx.res); return; }
  const issue = r.issues.find((i) => i.number === num && !i.isPull);
  if (!issue) { notFound(ctx.res); return; }
  const body = await parseJsonBody(ctx);
  if (!body) return;
  if (typeof body.title === 'string') issue.title = body.title;
  if (typeof body.body === 'string') issue.body = body.body;
  if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
  if (Array.isArray(body.labels)) {
    const names = body.labels.filter((x): x is string => typeof x === 'string');
    for (const ln of names) if (!r.labels.some((l) => l.name === ln)) { sendJson(ctx.res, 422, { message: 'Validation Failed' }); return; }
    issue.labels = names;
  }
  issue.updated_at = nowIso();
  sendJson(ctx.res, 200, issueJson(r, issue));
}

async function createComment(ctx: Ctx, owner: string, name: string, num: number): Promise<void> {
  const r = findRepo(owner, name);
  if (!r) { notFound(ctx.res); return; }
  const issue = r.issues.find((i) => i.number === num);
  if (!issue) { notFound(ctx.res); return; }
  const body = await parseJsonBody(ctx);
  if (!body) return;
  const comment = { id: r.nextCommentId++, body: str(body.body), created_at: nowIso(), user: VIEWER };
  issue.comments.push(comment);
  sendJson(ctx.res, 201, { id: comment.id, body: comment.body, created_at: comment.created_at, updated_at: comment.created_at, user: { login: VIEWER.login, id: VIEWER.id, type: 'User' } });
}

function listComments(ctx: Ctx, owner: string, name: string, num: number): void {
  const r = findRepo(owner, name);
  if (!r) { notFound(ctx.res); return; }
  const issue = r.issues.find((i) => i.number === num);
  if (!issue) { notFound(ctx.res); return; }
  sendJson(ctx.res, 200, paginate(ctx, issue.comments).map((c) => ({ id: c.id, body: c.body, created_at: c.created_at, updated_at: c.created_at, user: { login: VIEWER.login, id: VIEWER.id, type: 'User' } })));
}

async function createPull(ctx: Ctx, owner: string, name: string): Promise<void> {
  const r = findRepo(owner, name);
  if (!r) { notFound(ctx.res); return; }
  const body = await parseJsonBody(ctx);
  if (!body) return;
  const head = str(body.head).replace(`${r.owner}:`, '');
  const base = str(body.base, r.defaultBranch) || r.defaultBranch;
  if (!branchTip(r, head)) { sendJson(ctx.res, 422, { message: 'Validation Failed', errors: [{ resource: 'PullRequest', field: 'head', code: 'invalid' }] }); return; }
  if (!branchTip(r, base)) { sendJson(ctx.res, 422, { message: 'Validation Failed', errors: [{ resource: 'PullRequest', field: 'base', code: 'invalid' }] }); return; }
  const num = r.nextNumber++;
  const pull: PullRec = {
    number: num, title: str(body.title), body: str(body.body), state: 'open',
    head, base, merged: false, merged_at: null, merge_commit_sha: null,
    created_at: nowIso(), updated_at: nowIso(),
  };
  r.pulls.push(pull);
  r.issues.push({ number: num, title: pull.title, body: pull.body, state: 'open', labels: [], created_at: pull.created_at, updated_at: pull.updated_at, isPull: true, comments: [] });
  sendJson(ctx.res, 201, pullJson(r, pull));
}

function listPulls(ctx: Ctx, owner: string, name: string): void {
  const r = findRepo(owner, name);
  if (!r) { notFound(ctx.res); return; }
  const state = ctx.url.searchParams.get('state') ?? 'open';
  let items = r.pulls;
  if (state === 'open') items = items.filter((p) => p.state === 'open');
  else if (state === 'closed') items = items.filter((p) => p.state === 'closed');
  sendJson(ctx.res, 200, paginate(ctx, items).map((p) => pullJson(r, p)));
}

function getPull(ctx: Ctx, owner: string, name: string, num: number): void {
  const r = findRepo(owner, name);
  if (!r) { notFound(ctx.res); return; }
  const pull = r.pulls.find((p) => p.number === num);
  if (!pull) { notFound(ctx.res); return; }
  sendJson(ctx.res, 200, pullJson(r, pull));
}

/** Three-way tree merge; returns the merged flat map, or null on conflict. */
function mergeTrees(baseTree: string, headTree: string, ontoTree: string): Map<string, { mode: string; sha: string }> | null {
  const base = flattenTree(baseTree);
  const head = flattenTree(headTree);
  const onto = flattenTree(ontoTree);
  const out = new Map(onto);
  const paths = new Set([...base.keys(), ...head.keys(), ...onto.keys()]);
  for (const p of paths) {
    const b = base.get(p)?.sha;
    const h = head.get(p)?.sha;
    const o = onto.get(p)?.sha;
    if (h === b) continue; // head did not change it
    if (o === b) { // only head changed it
      if (h === undefined) out.delete(p);
      else out.set(p, head.get(p)!);
      continue;
    }
    if (h === o) continue; // both made the same change
    return null; // both changed it differently
  }
  return out;
}

async function mergePull(ctx: Ctx, owner: string, name: string, num: number): Promise<void> {
  const r = findRepo(owner, name);
  if (!r) { notFound(ctx.res); return; }
  const pull = r.pulls.find((p) => p.number === num);
  if (!pull) { notFound(ctx.res); return; }
  const body = await parseJsonBody(ctx);
  if (!body) return;
  if (pull.state === 'closed' && pull.merged) { sendJson(ctx.res, 200, { sha: pull.merge_commit_sha ?? '', merged: true, message: 'Pull Request successfully merged' }); return; }
  const headTip = branchTip(r, pull.head);
  const baseTipSha = branchTip(r, pull.base);
  if (!headTip || !baseTipSha) { sendJson(ctx.res, 405, { message: 'Pull Request is not mergeable' }); return; }
  const base0 = mergeBase(headTip, baseTipSha);
  const headTree = parseCommit(headTip)?.tree ?? '';
  const ontoTree = parseCommit(baseTipSha)?.tree ?? '';
  const baseTree = base0 ? parseCommit(base0)?.tree ?? '' : '';
  const mergedFlat = mergeTrees(baseTree, headTree, ontoTree);
  if (!mergedFlat) { sendJson(ctx.res, 405, { message: 'Pull Request is not mergeable', documentation_url: '' }); return; }
  const message = str(body.commit_message, `${pull.title} (#${pull.number})`);
  const tree = treeFromFlat(mergedFlat);
  const sha = writeCommit(tree, [baseTipSha], message);
  r.refs.set(`refs/heads/${pull.base}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.merged_at = nowIso();
  pull.merge_commit_sha = sha;
  pull.updated_at = nowIso();
  const issueRec = r.issues.find((i) => i.number === num);
  if (issueRec) { issueRec.state = 'closed'; issueRec.updated_at = nowIso(); }
  r.updated_at = nowIso();
  sendJson(ctx.res, 200, { sha, merged: true, message: 'Pull Request successfully merged' });
}

function pullFiles(ctx: Ctx, owner: string, name: string, num: number): void {
  const r = findRepo(owner, name);
  if (!r) { notFound(ctx.res); return; }
  const pull = r.pulls.find((p) => p.number === num);
  if (!pull) { notFound(ctx.res); return; }
  const headTip = branchTip(r, pull.head);
  const baseTipSha = branchTip(r, pull.base);
  if (!headTip || !baseTipSha) { sendJson(ctx.res, 200, []); return; }
  const base0 = mergeBase(headTip, baseTipSha);
  const baseFlat = base0 ? flattenTree(parseCommit(base0)?.tree ?? '') : new Map<string, { mode: string; sha: string }>();
  const headFlat = flattenTree(parseCommit(headTip)?.tree ?? '');
  const files: Record<string, unknown>[] = [];
  const paths = new Set([...baseFlat.keys(), ...headFlat.keys()]);
  for (const p of paths) {
    const b = baseFlat.get(p)?.sha;
    const h = headFlat.get(p)?.sha;
    if (b === h) continue;
    files.push({ filename: p, sha: h ?? b ?? '', status: b === undefined ? 'added' : h === undefined ? 'removed' : 'modified', additions: 0, deletions: 0, changes: 0 });
  }
  sendJson(ctx.res, 200, paginate(ctx, files));
}

// ---------------------------------------------------------------------------
// Git smart HTTP
// ---------------------------------------------------------------------------

const ZERO = '0'.repeat(40);
function pkt(data: string | Buffer): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const len = payload.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), payload]);
}
const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');
interface PktItem { kind: 'data' | 'flush' | 'delim'; data: Buffer }
function parsePkts(buf: Buffer, offset = 0): { items: PktItem[]; rest: number } {
  const items: PktItem[] = [];
  let i = offset;
  while (i + 4 <= buf.length) {
    const lenText = buf.toString('ascii', i, i + 4);
    if (!/^[0-9a-f]{4}$/.test(lenText)) break;
    const len = parseInt(lenText, 16);
    if (len === 0) { items.push({ kind: 'flush', data: Buffer.alloc(0) }); i += 4; break; }
    if (len === 1) { items.push({ kind: 'delim', data: Buffer.alloc(0) }); i += 4; continue; }
    if (len === 2) { i += 4; continue; }
    if (i + len > buf.length) break;
    items.push({ kind: 'data', data: buf.subarray(i + 4, i + len) });
    i += len;
  }
  return { items, rest: i };
}
function sideband(data: Buffer, band = 1): Buffer[] {
  const out: Buffer[] = [];
  for (let i = 0; i < data.length; i += 32000) {
    const chunk = data.subarray(i, i + 32000);
    out.push(pkt(Buffer.concat([Buffer.from([band]), chunk])));
  }
  if (data.length === 0) out.push(pkt(Buffer.from([band])));
  return out;
}

const OBJ_TYPES: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const TYPE_NAMES: Record<number, string> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** Collect every object reachable from the given commits, optionally bounded. */
function collectObjects(tips: string[], exclude: Set<string>, maxDepth = Infinity): Map<string, GitObject> {
  const out = new Map<string, GitObject>();
  const addTree = (treeSha: string): void => {
    if (out.has(treeSha) || exclude.has(treeSha)) return;
    const obj = readObject(treeSha);
    if (!obj) return;
    out.set(treeSha, obj);
    for (const e of parseTree(treeSha)) {
      if (exclude.has(e.sha) || out.has(e.sha)) continue;
      if (e.mode === '40000') addTree(e.sha);
      else { const b = readObject(e.sha); if (b) out.set(e.sha, b); }
    }
  };
  // BFS over commits so depth limits are honoured.
  const depth = new Map<string, number>();
  const queue: string[] = [];
  for (const t of tips) { if (!depth.has(t)) { depth.set(t, 0); queue.push(t); } }
  while (queue.length) {
    const cur = queue.shift()!;
    const d = depth.get(cur)!;
    if (d >= maxDepth) continue;
    if (exclude.has(cur) || out.has(cur)) continue;
    const obj = readObject(cur);
    if (!obj || obj.t !== 'commit') continue;
    out.set(cur, obj);
    const c = parseCommit(cur);
    if (!c) continue;
    addTree(c.tree);
    for (const p of c.parents) if (!depth.has(p)) { depth.set(p, d + 1); queue.push(p); }
  }
  return out;
}
function objectsReachableFrom(tips: string[]): Set<string> {
  const all = collectObjects(tips, new Set());
  return new Set(all.keys());
}
function buildPack(objs: Map<string, GitObject>): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objs.size, 8);
  parts.push(header);
  for (const obj of objs.values()) {
    const typeNum = OBJ_TYPES[obj.t];
    let size = obj.d.length;
    const bytes: number[] = [];
    let first = (typeNum << 4) | (size & 0x0f);
    size >>= 4;
    if (size > 0) first |= 0x80;
    bytes.push(first);
    while (size > 0) { let b = size & 0x7f; size >>= 7; if (size > 0) b |= 0x80; bytes.push(b); }
    parts.push(Buffer.from(bytes));
    parts.push(deflateSync(obj.d));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let i = 0;
  const readVarint = (): number => {
    let v = 0; let shift = 0;
    for (;;) { const b = delta[i++]; v |= (b & 0x7f) << shift; shift += 7; if (!(b & 0x80)) break; }
    return v;
  };
  readVarint(); // source size
  const targetSize = readVarint();
  const out: Buffer[] = [];
  while (i < delta.length) {
    const op = delta[i++];
    if (op & 0x80) {
      let off = 0; let len = 0;
      for (let bit = 0; bit < 4; bit++) if (op & (1 << bit)) off |= delta[i++] << (8 * bit);
      for (let bit = 0; bit < 3; bit++) if (op & (0x10 << bit)) len |= delta[i++] << (8 * bit);
      if (len === 0) len = 0x10000;
      out.push(base.subarray(off, off + len));
    } else if (op > 0) {
      out.push(delta.subarray(i, i + op));
      i += op;
    } else {
      throw new Error('bad delta opcode');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== targetSize) throw new Error('delta size mismatch');
  return result;
}
/** Parse a pack into the object store; returns the number of objects read. */
function receivePack(pack: Buffer): number {
  if (pack.length < 12 || pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a pack');
  const count = pack.readUInt32BE(8);
  let i = 12;
  const byOffset = new Map<number, string>();
  const deltas: { start: number; baseSha?: string; baseOff?: number; data: Buffer }[] = [];
  for (let n = 0; n < count; n++) {
    const start = i;
    let b = pack[i++];
    const typeNum = (b >> 4) & 0x07;
    let size = b & 0x0f;
    let shift = 4;
    while (b & 0x80) { b = pack[i++]; size |= (b & 0x7f) << shift; shift += 7; }
    let baseSha = '';
    let baseOff = 0;
    if (typeNum === 6) { // ofs-delta: offset back to the base entry's start
      let c = pack[i++];
      let off = c & 0x7f;
      while (c & 0x80) { c = pack[i++]; off = ((off + 1) << 7) | (c & 0x7f); }
      baseOff = start - off;
    } else if (typeNum === 7) { // ref-delta
      baseSha = pack.toString('hex', i, i + 20);
      i += 20;
    }
    const res = inflateSync(pack.subarray(i), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    i += res.engine.bytesWritten;
    if (typeNum === 6) deltas.push({ start, baseOff, data: res.buffer });
    else if (typeNum === 7) deltas.push({ start, baseSha, data: res.buffer });
    else {
      const t = TYPE_NAMES[typeNum];
      const sha = writeObject(t, res.buffer);
      byOffset.set(start, sha);
    }
  }
  let guard = 0;
  while (deltas.length && guard++ < 10000) {
    let progressed = false;
    for (let k = deltas.length - 1; k >= 0; k--) {
      const d = deltas[k];
      let baseObj: GitObject | undefined;
      if (d.baseSha) baseObj = readObject(d.baseSha);
      else { const s = byOffset.get(d.baseOff!); if (s) baseObj = readObject(s); }
      if (!baseObj) continue;
      const out = applyDelta(baseObj.d, d.data);
      const sha = writeObject(baseObj.t, out);
      byOffset.set(d.start, sha);
      deltas.splice(k, 1);
      progressed = true;
    }
    if (!progressed) break;
  }
  if (deltas.length) throw new Error('unresolved delta in pack');
  return count;
}

function sortedRefs(r: Repo): [string, string][] {
  return [...r.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}
function infoRefs(ctx: Ctx, owner: string, name: string, service: string): void {
  const r = findRepo(owner, name);
  if (!r) { notFound(ctx.res); return; }
  const isUpload = service === 'git-upload-pack';
  const headRef = `refs/heads/${r.defaultBranch}`;
  const headTip = r.refs.get(headRef);
  const protocol = ctx.req.headers['git-protocol'] ?? '';
  if (isUpload && /(^|,)version=2/.test(protocol)) {
    const lines = ['version 2\n', 'agent=forge/1.0\n', 'ls-refs=unborn\n', 'fetch=shallow wait-for-done\n', 'object-format=sha1\n'];
    sendRaw(ctx.res, 200, Buffer.concat([...lines.map((l) => pkt(l)), PKT_FLUSH]), 'application/x-git-upload-pack-advertisement');
    return;
  }
  const caps = isUpload ? 'side-band-64k ofs-delta agent=forge/1.0' : 'report-status delete-refs side-band-64k ofs-delta agent=forge/1.0';
  const parts: Buffer[] = [pkt(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(r);
  if (refs.length === 0) {
    parts.push(pkt(`${ZERO} capabilities^{}\0${caps}\n`));
  } else {
    let first = true;
    if (headTip) {
      parts.push(pkt(`${headTip} HEAD\0${caps}\n`));
      first = false;
    }
    for (const [ref, sha] of refs) {
      parts.push(pkt(first ? `${sha} ${ref}\0${caps}\n` : `${sha} ${ref}\n`));
      first = false;
    }
  }
  parts.push(PKT_FLUSH);
  sendRaw(ctx.res, 200, Buffer.concat(parts), `application/x-${service}-advertisement`);
}

function lsRefs(ctx: Ctx, r: Repo, args: string[]): void {
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const a of args) {
    if (a === 'symrefs') symrefs = true;
    else if (a === 'unborn') unborn = true;
    else if (a.startsWith('ref-prefix ')) prefixes.push(a.slice('ref-prefix '.length));
  }
  const match = (ref: string): boolean => prefixes.length === 0 || prefixes.some((p) => ref.startsWith(p));
  const headRef = `refs/heads/${r.defaultBranch}`;
  const headTip = r.refs.get(headRef);
  const lines: string[] = [];
  if (match('HEAD')) {
    if (headTip) lines.push(`${headTip} HEAD${symrefs ? ` symref-target:${headRef}` : ''}\n`);
    else if (unborn) lines.push(`unborn HEAD${symrefs ? ` symref-target:${headRef}` : ''}\n`);
  }
  for (const [ref, sha] of sortedRefs(r)) {
    if (match(ref)) lines.push(`${sha} ${ref}\n`);
  }
  sendRaw(ctx.res, 200, Buffer.concat([...lines.map((l) => pkt(l)), PKT_FLUSH]), 'application/x-git-upload-pack-result');
}

function fetchResponse(ctx: Ctx, r: Repo, args: string[], v2: boolean): void {
  const wants: string[] = [];
  const haves: string[] = [];
  let done = false;
  let deepen = Infinity;
  for (const a of args) {
    if (a.startsWith('want ')) wants.push(a.slice(5).trim());
    else if (a.startsWith('have ')) haves.push(a.slice(5).trim());
    else if (a === 'done') done = true;
    else if (a.startsWith('deepen ')) deepen = parseInt(a.slice(7), 10) || Infinity;
  }
  for (const w of wants) {
    if (!readObject(w)) {
      if (v2) sendRaw(ctx.res, 200, pkt(`ERR object not found: ${w}\n`), 'application/x-git-upload-pack-result');
      else sendRaw(ctx.res, 200, pkt(`ERR object not found: ${w}\n`), 'application/x-git-upload-pack-result');
      return;
    }
  }
  const common = haves.filter((h) => readObject(h)?.t === 'commit');
  if (v2 && !done) {
    const parts: Buffer[] = [pkt('acknowledgments\n')];
    if (common.length === 0) parts.push(pkt('NAK\n'));
    else { for (const c of common) parts.push(pkt(`ACK ${c}\n`)); parts.push(pkt('ready\n')); }
    parts.push(PKT_DELIM, PKT_FLUSH);
    sendRaw(ctx.res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
    return;
  }
  const exclude = objectsReachableFrom(common);
  const objs = collectObjects(wants.filter((w) => readObject(w)?.t === 'commit'), exclude, deepen);
  // Non-commit wants (a tree or blob fetched directly): include them as-is.
  for (const w of wants) {
    const o = readObject(w);
    if (o && o.t !== 'commit' && !objs.has(w)) objs.set(w, o);
  }
  const pack = buildPack(objs);
  if (v2) {
    const parts: Buffer[] = [];
    if (deepen !== Infinity) {
      const shallowLines: string[] = [];
      for (const [sha, obj] of objs) {
        if (obj.t !== 'commit') continue;
        const c = parseCommit(sha);
        if (c && c.parents.some((p) => !objs.has(p) && readObject(p))) shallowLines.push(`shallow ${sha}\n`);
      }
      if (shallowLines.length) {
        parts.push(pkt('shallow-info\n'), ...shallowLines.map((l) => pkt(l)), PKT_DELIM);
      }
    }
    parts.push(pkt('packfile\n'), ...sideband(pack, 1), PKT_FLUSH);
    sendRaw(ctx.res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
    return;
  }
  const parts: Buffer[] = [pkt('NAK\n'), ...sideband(pack, 1), PKT_FLUSH];
  sendRaw(ctx.res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

async function uploadPack(ctx: Ctx, owner: string, name: string): Promise<void> {
  const r = findRepo(owner, name);
  if (!r) { notFound(ctx.res); return; }
  const protocol = ctx.req.headers['git-protocol'] ?? '';
  const v2 = /(^|,)version=2/.test(protocol);
  const { items } = parsePkts(ctx.body);
  const lines = items.filter((i) => i.kind === 'data').map((i) => i.data.toString('utf8').replace(/\n$/, ''));
  if (v2) {
    const cmd = lines.find((l) => l.startsWith('command='));
    const delimIdx = lines.findIndex((l) => l === '');
    const args = lines.slice(1).filter((l) => l !== '');
    void delimIdx;
    if (cmd === 'command=ls-refs') { lsRefs(ctx, r, args); return; }
    if (cmd === 'command=fetch') { fetchResponse(ctx, r, args, true); return; }
    sendRaw(ctx.res, 200, pkt('ERR unknown command\n'), 'application/x-git-upload-pack-result');
    return;
  }
  // v0: want/have lines are the pkt data lines themselves.
  const args = lines.map((l) => l.split('\0')[0]);
  fetchResponse(ctx, r, args, false);
}

async function handleReceivePack(ctx: Ctx, owner: string, name: string): Promise<void> {
  const r = findRepo(owner, name);
  if (!r) { notFound(ctx.res); return; }
  const { items, rest } = parsePkts(ctx.body);
  interface Cmd { old: string; neu: string; ref: string }
  const cmds: Cmd[] = [];
  for (const item of items) {
    if (item.kind !== 'data') break;
    const line = item.data.toString('utf8').replace(/\n$/, '').split('\0')[0];
    const m = line.match(/^([0-9a-f]{40}) ([0-9a-f]{40}) (.+)$/);
    if (m) cmds.push({ old: m[1], neu: m[2], ref: m[3] });
  }
  const pack = ctx.body.subarray(rest);
  let unpackOk = true;
  let unpackMsg = 'ok';
  if (pack.length > 0) {
    try { receivePack(pack); } catch (e) { unpackOk = false; unpackMsg = e instanceof Error ? e.message : 'error'; }
  }
  const report: string[] = [`unpack ${unpackOk ? 'ok' : unpackMsg}\n`];
  for (const c of cmds) {
    if (!unpackOk) { report.push(`ng ${c.ref} unpack failed\n`); continue; }
    const current = r.refs.get(c.ref) ?? ZERO;
    if (current !== c.old) { report.push(`ng ${c.ref} expected ${c.old} but got ${current}\n`); continue; }
    if (c.neu === ZERO) { r.refs.delete(c.ref); report.push(`ok ${c.ref}\n`); continue; }
    const obj = readObject(c.neu);
    if (!obj || obj.t !== 'commit') { report.push(`ng ${c.ref} not a commit\n`); continue; }
    if (c.old !== ZERO && !isAncestor(c.old, c.neu)) { report.push(`ng ${c.ref} non-fast-forward\n`); continue; }
    r.refs.set(c.ref, c.neu);
    report.push(`ok ${c.ref}\n`);
  }
  if (cmds.length) r.updated_at = nowIso();
  const stream = Buffer.concat([...report.map((l) => pkt(l)), PKT_FLUSH]);
  sendRaw(ctx.res, 200, Buffer.concat([...sideband(stream, 1), PKT_FLUSH]), 'application/x-git-receive-pack-result');
}

// ---------------------------------------------------------------------------
// GraphQL v4 (the subset gh and github-mcp-server send)
// ---------------------------------------------------------------------------

type GqlValue = string | number | boolean | null | GqlValue[] | { [k: string]: GqlValue } | GqlVar;
interface GqlVar { __var: string }
interface GqlField { name: string; alias?: string; args: Record<string, GqlValue>; selection?: GqlField[]; fragmentType?: string }

function gqlTokenize(src: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (/\s|,/.test(c)) { i++; continue; }
    if (src.startsWith('...', i)) { tokens.push('...'); i += 3; continue; }
    if ('{}()[]:=!$@|&'.includes(c)) { tokens.push(c); i++; continue; }
    if (c === '"') {
      if (src.startsWith('"""', i)) {
        const end = src.indexOf('"""', i + 3);
        tokens.push(`"${src.slice(i + 3, end === -1 ? src.length : end)}"`);
        i = end === -1 ? src.length : end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\') { out += src[j + 1] === 'n' ? '\n' : src[j + 1] === 't' ? '\t' : src[j + 1]; j += 2; }
        else { out += src[j]; j++; }
      }
      tokens.push(`"${out}"`);
      i = j + 1;
      continue;
    }
    const m = src.slice(i).match(/^[A-Za-z0-9_.-]+/);
    if (m) { tokens.push(m[0]); i += m[0].length; continue; }
    i++;
  }
  return tokens;
}

class GqlParser {
  toks: string[]; pos = 0;
  constructor(src: string) { this.toks = gqlTokenize(src); }
  peek(): string { return this.toks[this.pos] ?? ''; }
  next(): string { return this.toks[this.pos++] ?? ''; }
  expect(t: string): void { if (this.next() !== t) throw new Error(`expected ${t}`); }
  parseDocument(): { op: string; selection: GqlField[] }[] {
    const ops: { op: string; selection: GqlField[] }[] = [];
    while (this.pos < this.toks.length) {
      let op = 'query';
      if (this.peek() === 'query' || this.peek() === 'mutation' || this.peek() === 'subscription') {
        op = this.next();
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(this.peek())) this.next(); // operation name
        if (this.peek() === '(') this.skipParens(); // variable definitions
        // directives
        while (this.peek() === '@') { this.next(); this.next(); if (this.peek() === '(') this.skipParens(); }
      }
      if (this.peek() === '{') ops.push({ op, selection: this.parseSelection() });
      else if (this.pos < this.toks.length) this.next();
    }
    return ops;
  }
  skipParens(): void {
    let depth = 0;
    do { const t = this.next(); if (t === '(') depth++; else if (t === ')') depth--; } while (depth > 0 && this.pos < this.toks.length);
  }
  parseSelection(): GqlField[] {
    this.expect('{');
    const fields: GqlField[] = [];
    while (this.peek() !== '}' && this.pos < this.toks.length) {
      if (this.peek() === '...') {
        this.next();
        if (this.peek() === 'on') {
          this.next();
          const type = this.next();
          const sub = this.parseSelection();
          fields.push({ name: '__fragment', args: {}, selection: sub, fragmentType: type });
        } else {
          this.next(); // named fragment spread: not used by the suite; skip
        }
        continue;
      }
      let name = this.next();
      let alias: string | undefined;
      if (this.peek() === ':') { this.next(); alias = name; name = this.next(); }
      const args: Record<string, GqlValue> = {};
      if (this.peek() === '(') {
        this.next();
        while (this.peek() !== ')' && this.pos < this.toks.length) {
          const argName = this.next();
          this.expect(':');
          args[argName] = this.parseValue();
        }
        this.expect(')');
      }
      while (this.peek() === '@') { this.next(); this.next(); if (this.peek() === '(') this.skipParens(); }
      let selection: GqlField[] | undefined;
      if (this.peek() === '{') selection = this.parseSelection();
      fields.push({ name, alias, args, selection });
    }
    this.expect('}');
    return fields;
  }
  parseValue(): GqlValue {
    const t = this.next();
    if (t === '$') return { __var: this.next() };
    if (t === '[') {
      const arr: GqlValue[] = [];
      while (this.peek() !== ']' && this.pos < this.toks.length) arr.push(this.parseValue());
      this.expect(']');
      return arr;
    }
    if (t === '{') {
      const obj: Record<string, GqlValue> = {};
      while (this.peek() !== '}' && this.pos < this.toks.length) {
        const k = this.next();
        this.expect(':');
        obj[k] = this.parseValue();
      }
      this.expect('}');
      return obj;
    }
    if (t.startsWith('"')) return t.slice(1, -1);
    if (t === 'true') return true;
    if (t === 'false') return false;
    if (t === 'null') return null;
    if (/^-?\d+$/.test(t)) return parseInt(t, 10);
    if (/^-?\d*\.\d+$/.test(t)) return parseFloat(t);
    return t; // enum
  }
}

function resolveValue(v: GqlValue, vars: Record<string, unknown>): unknown {
  if (v !== null && typeof v === 'object') {
    if (Array.isArray(v)) return v.map((x) => resolveValue(x, vars));
    if ('__var' in (v as Record<string, unknown>)) return vars[(v as GqlVar).__var];
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, GqlValue>)) out[k] = resolveValue(val, vars);
    return out;
  }
  return v;
}

const gid = (kind: string, key: string): string => Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
function ungid(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const idx = text.indexOf(':');
    if (idx < 0) return null;
    return { kind: text.slice(0, idx), key: text.slice(idx + 1) };
  } catch { return null; }
}

interface GqlObj { __type: string; [k: string]: unknown }
const gqlUser = (): GqlObj => ({ __type: 'User', id: gid('User', String(VIEWER.id)), login: VIEWER.login, name: VIEWER.name, email: VIEWER.email, databaseId: VIEWER.id });
function gqlRepo(r: Repo): GqlObj {
  return {
    __type: 'Repository', _repo: r, id: gid('Repository', String(r.id)), databaseId: r.id,
    name: r.name, nameWithOwner: `${r.owner}/${r.name}`, isPrivate: r.isPrivate, description: r.description,
    viewerPermission: 'ADMIN', hasIssuesEnabled: true, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
function gqlIssue(r: Repo, i: IssueRec): GqlObj {
  return {
    __type: 'Issue', _repo: r, _issue: i, id: gid('Issue', `${r.id}:${i.number}`), number: i.number,
    title: i.title, body: i.body, state: i.state.toUpperCase(), createdAt: i.created_at, updatedAt: i.updated_at,
    closedAt: i.state === 'closed' ? i.updated_at : null,
  };
}
function gqlPull(r: Repo, p: PullRec): GqlObj {
  return {
    __type: 'PullRequest', _repo: r, _pull: p, id: gid('PullRequest', `${r.id}:${p.number}`), number: p.number,
    title: p.title, body: p.body, state: p.state.toUpperCase(), merged: p.merged,
    headRefName: p.head, baseRefName: p.base, createdAt: p.created_at, updatedAt: p.updated_at,
    closedAt: p.state === 'closed' ? p.updated_at : null, isDraft: false, mergedAt: p.merged_at,
  };
}
function pullMergeable(r: Repo, p: PullRec): string {
  const headTip = branchTip(r, p.head);
  const baseTipSha = branchTip(r, p.base);
  if (!headTip || !baseTipSha) return 'UNKNOWN';
  const base0 = mergeBase(headTip, baseTipSha);
  const merged = mergeTrees(
    base0 ? parseCommit(base0)?.tree ?? '' : '',
    parseCommit(headTip)?.tree ?? '',
    parseCommit(baseTipSha)?.tree ?? '',
  );
  return merged ? 'MERGEABLE' : 'CONFLICTING';
}
function connection(items: GqlObj[], args: Record<string, unknown>, typeName: string): GqlObj {
  const first = typeof args.first === 'number' ? args.first : items.length;
  let start = 0;
  if (typeof args.after === 'string' && args.after !== '') {
    try {
      const decoded = Buffer.from(args.after, 'base64').toString('utf8');
      const idx = items.findIndex((it) => (it.id as string) === decoded);
      if (idx >= 0) start = idx + 1;
    } catch { /* ignore */ }
  }
  const slice = items.slice(start, start + first);
  const hasNext = start + first < items.length;
  const endCursor = slice.length ? Buffer.from(slice[slice.length - 1].id as string, 'utf8').toString('base64') : null;
  return {
    __type: typeName, _items: slice, _all: items,
    pageInfo: { __type: 'PageInfo', hasNextPage: hasNext, hasPreviousPage: start > 0, endCursor, startCursor: slice.length ? Buffer.from(slice[0].id as string, 'utf8').toString('base64') : null },
    totalCount: items.length,
  };
}

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'search', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'login', 'name', 'email', 'url', 'databaseId'],
  Actor: ['login', 'url'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'isPrivate', 'description', 'createdAt', 'updatedAt', 'url'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'author', 'labels', 'comments', 'createdAt', 'updatedAt', 'closedAt', 'repository'],
  PullRequest: ['id', 'number', 'title', 'state', 'body', 'headRefName', 'baseRefName', 'mergeable', 'merged', 'mergedAt', 'files', 'author', 'createdAt', 'updatedAt', 'closedAt', 'repository', 'isDraft', 'url'],
  Ref: ['name', 'prefix', 'target'],
  Label: ['id', 'name', 'color', 'description'],
  Comment: ['id', 'body', 'author', 'createdAt', 'updatedAt'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'endCursor', 'startCursor'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId', 'subject'],
  CommentEdge: ['node', 'cursor'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
};
const ENUM_TYPES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'DISCUSSION', 'REPOSITORY', 'USER'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  Permission: ['ADMIN', 'WRITE', 'READ', 'NONE'],
};

interface GqlError { message: string }
function gqlResolveField(obj: GqlObj | null, field: GqlField, vars: Record<string, unknown>, errors: GqlError[]): unknown {
  if (obj === null) return null;
  const type = obj.__type;
  const name = field.name;
  if (name === '__typename') return type;
  const args: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(field.args)) args[k] = resolveValue(v, vars);
  const repo = obj._repo as Repo | undefined;
  switch (type) {
    case 'Query': {
      if (name === 'viewer') return gqlUser();
      if (name === 'repository') {
        const r = findRepo(String(args.owner ?? ''), String(args.name ?? ''));
        return r ? gqlRepo(r) : null;
      }
      if (name === 'node') return gqlNode(String(args.id ?? ''));
      if (name === '__type') return gqlTypeInfo(String(args.name ?? ''));
      if (name === '__schema') return { __type: '__Schema' };
      break;
    }
    case 'Mutation': {
      if (name === 'createIssue') return gqlCreateIssue(args);
      if (name === 'closeIssue') return gqlCloseIssue(args);
      if (name === 'createPullRequest') return gqlCreatePull(args);
      if (name === 'mergePullRequest') return gqlMergePull(args);
      if (name === 'addComment') return gqlAddComment(args);
      break;
    }
    case 'Repository': {
      if (!repo) break;
      if (name === 'owner') return gqlUser();
      if (name === 'defaultBranchRef') {
        const tip = branchTip(repo, repo.defaultBranch);
        return tip ? { __type: 'Ref', name: repo.defaultBranch, prefix: 'refs/heads/' } : null;
      }
      if (name === 'issue') {
        const rec = repo.issues.find((i) => i.number === Number(args.number) && !i.isPull);
        return rec ? gqlIssue(repo, rec) : null;
      }
      if (name === 'issues') {
        let items = repo.issues.filter((i) => !i.isPull);
        const states = Array.isArray(args.states) ? (args.states as string[]) : null;
        if (states) items = items.filter((i) => states.includes(i.state.toUpperCase()));
        const orderBy = (args.orderBy ?? {}) as { field?: string; direction?: string };
        items = [...items].sort((a, b) => a.number - b.number);
        if (orderBy.direction !== 'ASC') items.reverse();
        return connection(items.map((i) => gqlIssue(repo, i)), args, 'IssueConnection');
      }
      if (name === 'pullRequest') {
        const rec = repo.pulls.find((p) => p.number === Number(args.number));
        return rec ? gqlPull(repo, rec) : null;
      }
      if (name === 'pullRequests') {
        let items = repo.pulls;
        const states = Array.isArray(args.states) ? (args.states as string[]) : null;
        if (states) items = items.filter((p) => states.includes(p.state.toUpperCase()));
        items = [...items].sort((a, b) => b.number - a.number);
        return connection(items.map((p) => gqlPull(repo, p)), args, 'PullRequestConnection');
      }
      break;
    }
    case 'Issue': {
      const rec = obj._issue as IssueRec | undefined;
      if (!rec || !repo) break;
      if (name === 'author') return gqlUser();
      if (name === 'repository') return gqlRepo(repo);
      if (name === 'labels') return connection(rec.labels.map((n) => ({ __type: 'Label', id: gid('Label', n), name: n, color: repo.labels.find((l) => l.name === n)?.color ?? 'ededed', description: repo.labels.find((l) => l.name === n)?.description ?? '' } as GqlObj)), args, 'LabelConnection');
      if (name === 'comments') return connection(rec.comments.map((c) => ({ __type: 'Comment', id: gid('Comment', `${repo.id}:${rec.number}:${c.id}`), body: c.body, createdAt: c.created_at, updatedAt: c.created_at } as GqlObj)), args, 'IssueCommentConnection');
      break;
    }
    case 'PullRequest': {
      const rec = obj._pull as PullRec | undefined;
      if (!rec || !repo) break;
      if (name === 'author') return gqlUser();
      if (name === 'repository') return gqlRepo(repo);
      if (name === 'mergeable') return pullMergeable(repo, rec);
      if (name === 'files') {
        const headTip = branchTip(repo, rec.head);
        const baseTipSha = branchTip(repo, rec.base);
        const files: GqlObj[] = [];
        if (headTip && baseTipSha) {
          const base0 = mergeBase(headTip, baseTipSha);
          const baseFlat = base0 ? flattenTree(parseCommit(base0)?.tree ?? '') : new Map<string, { mode: string; sha: string }>();
          const headFlat = flattenTree(parseCommit(headTip)?.tree ?? '');
          const paths = new Set([...baseFlat.keys(), ...headFlat.keys()]);
          for (const p of paths) {
            if (baseFlat.get(p)?.sha === headFlat.get(p)?.sha) continue;
            files.push({ __type: 'PullRequestChangedFile', path: p, additions: 0, deletions: 0, changeType: baseFlat.has(p) ? (headFlat.has(p) ? 'MODIFIED' : 'DELETED') : 'ADDED' });
          }
        }
        return connection(files, args, 'PullRequestChangedFileConnection');
      }
      break;
    }
    default: break;
  }
  if (name.endsWith('Connection') || type.endsWith('Connection')) { /* handled below */ }
  if (type.endsWith('Connection')) {
    if (name === 'nodes') return obj._items;
    if (name === 'pageInfo') return obj.pageInfo;
    if (name === 'totalCount') return obj.totalCount;
    if (name === 'edges') return (obj._items as GqlObj[]).map((n) => ({ __type: 'Edge', node: n, cursor: Buffer.from(n.id as string, 'utf8').toString('base64') }));
  }
  if (type === '__Type') {
    if (name === 'fields') return (obj._fields as string[]).map((f) => ({ __type: '__Field', name: f }));
    if (name === 'enumValues') return (obj._enums as string[] | undefined ?? []).map((f) => ({ __type: '__EnumValue', name: f }));
    if (name === 'name') return obj._name;
    if (name === 'kind') return obj._kind;
  }
  if (name in obj) return obj[name];
  const known = TYPE_FIELDS[type];
  if (known && !known.includes(name)) errors.push({ message: `Field '${name}' doesn't exist on type '${type}'` });
  else if (!known) errors.push({ message: `Field '${name}' doesn't exist on type '${type}'` });
  return null;
}
function gqlTypeInfo(name: string): GqlObj | null {
  if (ENUM_TYPES[name]) return { __type: '__Type', _name: name, _kind: 'ENUM', _enums: ENUM_TYPES[name], _fields: [] };
  if (TYPE_FIELDS[name]) return { __type: '__Type', _name: name, _kind: 'OBJECT', _fields: TYPE_FIELDS[name], _enums: [] };
  return null;
}
function gqlNode(id: string): GqlObj | null {
  const decoded = ungid(id);
  if (!decoded) return null;
  if (decoded.kind === 'Repository') {
    const r = [...repos.values()].find((x) => x.id === Number(decoded.key));
    return r ? gqlRepo(r) : null;
  }
  if (decoded.kind === 'Issue' || decoded.kind === 'PullRequest') {
    const [repoId, num] = decoded.key.split(':').map(Number);
    const r = [...repos.values()].find((x) => x.id === repoId);
    if (!r) return null;
    if (decoded.kind === 'Issue') { const rec = r.issues.find((i) => i.number === num && !i.isPull); return rec ? gqlIssue(r, rec) : null; }
    const rec = r.pulls.find((p) => p.number === num);
    return rec ? gqlPull(r, rec) : null;
  }
  if (decoded.kind === 'User') return gqlUser();
  return null;
}
function repoByGid(id: string): Repo | undefined {
  const decoded = ungid(id);
  if (!decoded || decoded.kind !== 'Repository') return undefined;
  return [...repos.values()].find((x) => x.id === Number(decoded.key) && x.owner === VIEWER.login);
}
function gqlCreateIssue(args: Record<string, unknown>): GqlObj | null {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const r = repoByGid(String(input.repositoryId ?? ''));
  if (!r) return null;
  const rec: IssueRec = {
    number: r.nextNumber++, title: String(input.title ?? ''), body: String(input.body ?? ''), state: 'open',
    labels: [], created_at: nowIso(), updated_at: nowIso(), isPull: false, comments: [],
  };
  r.issues.push(rec);
  return { __type: 'CreateIssuePayload', issue: gqlIssue(r, rec), clientMutationId: input.clientMutationId ?? null };
}
function gqlCloseIssue(args: Record<string, unknown>): GqlObj | null {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const node = gqlNode(String(input.issueId ?? ''));
  if (!node || node.__type !== 'Issue') return null;
  const rec = node._issue as IssueRec;
  rec.state = 'closed';
  rec.updated_at = nowIso();
  return { __type: 'CloseIssuePayload', issue: gqlIssue(node._repo as Repo, rec), clientMutationId: input.clientMutationId ?? null };
}
function gqlCreatePull(args: Record<string, unknown>): GqlObj | null {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const r = repoByGid(String(input.repositoryId ?? ''));
  if (!r) return null;
  const num = r.nextNumber++;
  const pull: PullRec = {
    number: num, title: String(input.title ?? ''), body: String(input.body ?? ''), state: 'open',
    head: String(input.headRefName ?? ''), base: String(input.baseRefName ?? r.defaultBranch),
    merged: false, merged_at: null, merge_commit_sha: null, created_at: nowIso(), updated_at: nowIso(),
  };
  r.pulls.push(pull);
  r.issues.push({ number: num, title: pull.title, body: pull.body, state: 'open', labels: [], created_at: pull.created_at, updated_at: pull.updated_at, isPull: true, comments: [] });
  return { __type: 'CreatePullRequestPayload', pullRequest: gqlPull(r, pull), clientMutationId: input.clientMutationId ?? null };
}
function gqlMergePull(args: Record<string, unknown>): GqlObj | null {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const node = gqlNode(String(input.pullRequestId ?? ''));
  if (!node || node.__type !== 'PullRequest') return null;
  const r = node._repo as Repo;
  const pull = node._pull as PullRec;
  const headTip = branchTip(r, pull.head);
  const baseTipSha = branchTip(r, pull.base);
  if (headTip && baseTipSha && pull.state === 'open') {
    const base0 = mergeBase(headTip, baseTipSha);
    const mergedFlat = mergeTrees(base0 ? parseCommit(base0)?.tree ?? '' : '', parseCommit(headTip)?.tree ?? '', parseCommit(baseTipSha)?.tree ?? '');
    if (mergedFlat) {
      const sha = writeCommit(treeFromFlat(mergedFlat), [baseTipSha], `${pull.title} (#${pull.number})`);
      r.refs.set(`refs/heads/${pull.base}`, sha);
      pull.state = 'closed';
      pull.merged = true;
      pull.merged_at = nowIso();
      pull.merge_commit_sha = sha;
      pull.updated_at = nowIso();
    }
  }
  return { __type: 'MergePullRequestPayload', pullRequest: gqlPull(r, pull), clientMutationId: input.clientMutationId ?? null };
}
function gqlAddComment(args: Record<string, unknown>): GqlObj | null {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const node = gqlNode(String(input.subjectId ?? ''));
  if (!node) return null;
  const r = node._repo as Repo | undefined;
  if (!r) return null;
  const rec = (node._issue as IssueRec | undefined) ?? r.issues.find((i) => i.number === (node._pull as PullRec | undefined)?.number);
  if (!rec) return null;
  const comment = { id: r.nextCommentId++, body: String(input.body ?? ''), created_at: nowIso(), user: VIEWER };
  rec.comments.push(comment);
  const gqlComment: GqlObj = { __type: 'Comment', id: gid('Comment', `${r.id}:${rec.number}:${comment.id}`), body: comment.body, createdAt: comment.created_at, updatedAt: comment.created_at };
  return { __type: 'AddCommentPayload', commentEdge: { __type: 'CommentEdge', node: gqlComment, cursor: '' }, clientMutationId: input.clientMutationId ?? null, subject: node };
}
function gqlExecuteSelection(obj: GqlObj | null, selection: GqlField[], vars: Record<string, unknown>, errors: GqlError[]): Record<string, unknown> | null {
  if (obj === null) return null;
  const out: Record<string, unknown> = {};
  for (const field of selection) {
    if (field.name === '__fragment') {
      if (field.fragmentType === obj.__type || field.fragmentType === 'Node') {
        const sub = gqlExecuteSelection(obj, field.selection ?? [], vars, errors);
        if (sub) Object.assign(out, sub);
      }
      continue;
    }
    const key = field.alias ?? field.name;
    const value = gqlResolveField(obj, field, vars, errors);
    out[key] = gqlShape(value, field, vars, errors);
  }
  return out;
}
function gqlShape(value: unknown, field: GqlField, vars: Record<string, unknown>, errors: GqlError[]): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((v) => gqlShape(v, field, vars, errors));
  if (typeof value === 'object' && (value as GqlObj).__type) {
    if (!field.selection) return (value as GqlObj).id ?? null;
    return gqlExecuteSelection(value as GqlObj, field.selection, vars, errors);
  }
  return value;
}
function gqlRun(query: string, vars: Record<string, unknown>): Record<string, unknown> {
  const errors: GqlError[] = [];
  let ops: { op: string; selection: GqlField[] }[] = [];
  try { ops = new GqlParser(query).parseDocument(); } catch (e) { return { errors: [{ message: e instanceof Error ? e.message : 'parse error' }] }; }
  const data: Record<string, unknown> = {};
  for (const op of ops) {
    const root: GqlObj = { __type: op.op === 'mutation' ? 'Mutation' : 'Query' };
    const part = gqlExecuteSelection(root, op.selection, vars, errors);
    if (part) Object.assign(data, part);
  }
  const out: Record<string, unknown> = { data };
  if (errors.length) out.errors = errors;
  return out;
}
async function handleGraphql(ctx: Ctx): Promise<void> {
  if (!authed(ctx.req)) { sendJson(ctx.res, 401, { message: 'Bad credentials' }); return; }
  let parsed: unknown;
  try { parsed = JSON.parse(ctx.body.toString('utf8')); } catch { badRequest(ctx.res); return; }
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) => {
      const e = (entry ?? {}) as Record<string, unknown>;
      return gqlRun(String(e.query ?? ''), (e.variables ?? {}) as Record<string, unknown>);
    });
    sendJson(ctx.res, 200, results);
    return;
  }
  const body = (parsed ?? {}) as Record<string, unknown>;
  const result = gqlRun(String(body.query ?? ''), (body.variables ?? {}) as Record<string, unknown>);
  sendJson(ctx.res, 200, result);
}

// ---------------------------------------------------------------------------
// MCP (JSON-RPC 2.0 over streamable HTTP)
// ---------------------------------------------------------------------------

interface McpTool { name: string; description: string; inputSchema: Record<string, unknown> }
const MCP_TOOLS: McpTool[] = [
  { name: 'create_repo', description: 'Create a new repository for the authenticated user.', inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Repository name' }, private: { type: 'boolean' }, description: { type: 'string' } }, required: ['name'] } },
  { name: 'get_repo', description: 'Get a repository by owner and name.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' } }, required: ['owner', 'repo'] } },
  { name: 'create_issue', description: 'Create an issue in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } }, required: ['owner', 'repo', 'title'] } },
  { name: 'list_issues', description: 'List issues in a repository, optionally filtered by state.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string' } }, required: ['owner', 'repo'] } },
  { name: 'create_pull_request', description: 'Create a pull request from a head branch to a base branch.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' }, body: { type: 'string' } }, required: ['owner', 'repo', 'title', 'head', 'base'] } },
  { name: 'merge_pull_request', description: 'Merge a pull request (squash) into its base branch.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'number' } }, required: ['owner', 'repo', 'pull_number'] } },
];
const MCP_TOOLS_JSON = JSON.stringify({ tools: MCP_TOOLS });

function mcpResult(id: unknown, result: unknown): Record<string, unknown> { return { jsonrpc: '2.0', id, result }; }
function mcpError(id: unknown, code: number, message: string): Record<string, unknown> { return { jsonrpc: '2.0', id, error: { code, message } }; }
function mcpToolText(value: unknown, isError = false): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], isError };
}
function mcpCallTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const short = name.split('__').pop()?.toLowerCase() ?? name.toLowerCase();
  const owner = String(args.owner ?? VIEWER.login);
  const repoName = String(args.repo ?? args.name ?? '');
  switch (short) {
    case 'create_repo': {
      const repoNameArg = String(args.name ?? '');
      if (repoNameArg === '') return mcpToolText({ error: 'name is required' }, true);
      if (repos.has(repoKey(VIEWER.login, repoNameArg))) return mcpToolText({ error: 'name already exists' }, true);
      const repo: Repo = {
        id: nextRepoId++, name: repoNameArg, owner: VIEWER.login, isPrivate: args.private === true,
        description: String(args.description ?? ''), defaultBranch: 'main', created_at: nowIso(), updated_at: nowIso(),
        refs: new Map(), labels: [], issues: [], pulls: [], nextNumber: 1, nextCommentId: 1,
      };
      repos.set(repoKey(repo.owner, repoNameArg), repo);
      return mcpToolText(repoJson(repo));
    }
    case 'get_repo': {
      const r = findRepo(owner, repoName);
      if (!r) return mcpToolText({ error: 'repository not found' }, true);
      return mcpToolText(repoJson(r));
    }
    case 'create_issue': {
      const r = findRepo(owner, repoName);
      if (!r) return mcpToolText({ error: 'repository not found' }, true);
      if (typeof args.title !== 'string' || args.title === '') return mcpToolText({ error: 'title is required' }, true);
      const rec: IssueRec = { number: r.nextNumber++, title: args.title, body: String(args.body ?? ''), state: 'open', labels: [], created_at: nowIso(), updated_at: nowIso(), isPull: false, comments: [] };
      r.issues.push(rec);
      return mcpToolText(issueJson(r, rec));
    }
    case 'list_issues': {
      const r = findRepo(owner, repoName);
      if (!r) return mcpToolText({ error: 'repository not found' }, true);
      const state = String(args.state ?? 'open');
      let items = r.issues.filter((i) => !i.isPull);
      if (state === 'open') items = items.filter((i) => i.state === 'open');
      else if (state === 'closed') items = items.filter((i) => i.state === 'closed');
      return mcpToolText(items.map((i) => issueJson(r, i)));
    }
    case 'create_pull_request': {
      const r = findRepo(owner, repoName);
      if (!r) return mcpToolText({ error: 'repository not found' }, true);
      const head = String(args.head ?? '');
      const base = String(args.base ?? r.defaultBranch);
      if (!branchTip(r, head) || !branchTip(r, base)) return mcpToolText({ error: 'head or base branch not found' }, true);
      const num = r.nextNumber++;
      const pull: PullRec = { number: num, title: String(args.title ?? ''), body: String(args.body ?? ''), state: 'open', head, base, merged: false, merged_at: null, merge_commit_sha: null, created_at: nowIso(), updated_at: nowIso() };
      r.pulls.push(pull);
      r.issues.push({ number: num, title: pull.title, body: pull.body, state: 'open', labels: [], created_at: pull.created_at, updated_at: pull.updated_at, isPull: true, comments: [] });
      return mcpToolText(pullJson(r, pull));
    }
    case 'merge_pull_request': {
      const r = findRepo(owner, repoName);
      if (!r) return mcpToolText({ error: 'repository not found' }, true);
      const num = Number(args.pull_number ?? args.number ?? 0);
      const pull = r.pulls.find((p) => p.number === num);
      if (!pull) return mcpToolText({ error: 'pull request not found' }, true);
      const headTip = branchTip(r, pull.head);
      const baseTipSha = branchTip(r, pull.base);
      if (!headTip || !baseTipSha) return mcpToolText({ error: 'pull request is not mergeable' }, true);
      const base0 = mergeBase(headTip, baseTipSha);
      const mergedFlat = mergeTrees(base0 ? parseCommit(base0)?.tree ?? '' : '', parseCommit(headTip)?.tree ?? '', parseCommit(baseTipSha)?.tree ?? '');
      if (!mergedFlat) return mcpToolText({ error: 'pull request is not mergeable: conflicts' }, true);
      const sha = writeCommit(treeFromFlat(mergedFlat), [baseTipSha], `${pull.title} (#${pull.number})`);
      r.refs.set(`refs/heads/${pull.base}`, sha);
      pull.state = 'closed'; pull.merged = true; pull.merged_at = nowIso(); pull.merge_commit_sha = sha; pull.updated_at = nowIso();
      const rec = r.issues.find((i) => i.number === num);
      if (rec) { rec.state = 'closed'; rec.updated_at = nowIso(); }
      return mcpToolText({ ...pullJson(r, pull), sha });
    }
    default:
      return mcpToolText({ error: `unknown tool ${name}` }, true);
  }
}
function mcpHandleOne(msg: Record<string, unknown>): Record<string, unknown> | null {
  const method = String(msg.method ?? '');
  const id = msg.id;
  const params = (msg.params ?? {}) as Record<string, unknown>;
  if (method === 'server/discover') {
    return mcpResult(id, {
      protocolVersion: '2026-07-28',
      supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'],
      serverInfo: { name: 'forge', version: '1.0.0' },
      capabilities: { tools: {} },
    });
  }
  if (method === 'initialize') {
    return mcpResult(id, {
      protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25',
      serverInfo: { name: 'forge', version: '1.0.0' },
      capabilities: { tools: { listChanged: false } },
    });
  }
  if (method.startsWith('notifications/')) return null;
  if (method === 'ping') return mcpResult(id, {});
  if (method === 'tools/list') return mcpResult(id, JSON.parse(MCP_TOOLS_JSON) as unknown);
  if (method === 'tools/call') {
    const name = String(params.name ?? '');
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const known = MCP_TOOLS.some((t) => t.name === name || name.toLowerCase().endsWith(t.name));
    if (!known) return mcpError(id, -32602, `unknown tool: ${name}`);
    const tool = MCP_TOOLS.find((t) => name === t.name || name.toLowerCase().endsWith(t.name))!;
    const required = (tool.inputSchema.required as string[] | undefined) ?? [];
    for (const req of required) {
      if (args[req] === undefined || args[req] === '') return mcpResult(id, mcpToolText({ error: `missing required argument: ${req}` }, true));
    }
    return mcpResult(id, mcpCallTool(name, args));
  }
  return mcpError(id, -32601, `method not found: ${method}`);
}
async function handleMcp(ctx: Ctx): Promise<void> {
  if (!authed(ctx.req)) { sendJson(ctx.res, 401, { message: 'Bad credentials' }); return; }
  let parsed: unknown;
  try { parsed = JSON.parse(ctx.body.toString('utf8')); } catch {
    ctx.res.writeHead(400, { 'content-type': JSON_TYPE, 'x-github-request-id': requestId() });
    ctx.res.end(`${JSON.stringify(mcpError(null, -32700, 'Parse error'))}\n`);
    return;
  }
  ctx.res.setHeader('mcp-session-id', 'forge-session');
  if (Array.isArray(parsed)) {
    const results = parsed.map((m) => mcpHandleOne((m ?? {}) as Record<string, unknown>)).filter((x) => x !== null);
    sendJson(ctx.res, 200, results);
    return;
  }
  const msg = (parsed ?? {}) as Record<string, unknown>;
  const result = mcpHandleOne(msg);
  if (result === null) { ctx.res.writeHead(202, { 'x-github-request-id': requestId() }); ctx.res.end(); return; }
  sendJson(ctx.res, 200, result);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://entry');
      const body = await readBody(req);
      const ctx: Ctx = { req, res, url, body };
      const path = url.pathname;
      const method = req.method ?? 'GET';
      try {
        if (method === 'GET' && path === '/healthz') { sendJson(res, 200, { ok: true }); return; }
        if (!authed(req)) { sendJson(res, 401, { message: 'Bad credentials', documentation_url: '' }); return; }

        if (path === '/api/graphql' && method === 'POST') { await handleGraphql(ctx); return; }
        if (path === '/mcp') {
          if (method === 'POST') { await handleMcp(ctx); return; }
          sendJson(res, 405, { message: 'Method Not Allowed' });
          return;
        }

        if (path === '/api/v3' || path === '/api/v3/') {
          if (method === 'GET') {
            sendJson(res, 200, {
              current_user_url: '/api/v3/user', user_repositories_url: '/api/v3/user/repos',
              repository_url: '/api/v3/repos/{owner}/{repo}', issue_url: '/api/v3/repos/{owner}/{repo}/issues',
              rate_limit_url: '/api/v3/rate_limit',
            }, { 'x-oauth-scopes': 'repo, read:org' });
            return;
          }
          notFound(res); return;
        }
        if (path === '/api/v3/meta' && method === 'GET') {
          sendJson(res, 200, { installed_version: '3.0.0-forge', api_version: '2022-11-28' });
          return;
        }
        if (path === '/api/v3/user' && method === 'GET') {
          sendJson(res, 200, { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User' });
          return;
        }
        if (path === '/api/v3/user/repos') {
          if (method === 'GET') { listUserRepos(ctx); return; }
          if (method === 'POST') { await createRepo(ctx); return; }
          notFound(res); return;
        }

        const gitMatch = path.match(/^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/);
        if (gitMatch) {
          const [, owner, name, route] = gitMatch;
          if (route === 'info/refs' && method === 'GET') { infoRefs(ctx, owner, name, url.searchParams.get('service') ?? 'git-upload-pack'); return; }
          if (route === 'git-upload-pack' && method === 'POST') { await uploadPack(ctx, owner, name); return; }
          if (route === 'git-receive-pack' && method === 'POST') { await handleReceivePack(ctx, owner, name); return; }
          notFound(res); return;
        }

        const repoMatch = path.match(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)(\/.*)?$/);
        if (repoMatch) {
          const [, owner, name, rest] = repoMatch;
          const tail = rest ?? '';
          if (tail === '' || tail === '/') {
            if (method === 'GET') { getRepo(ctx, owner, name); return; }
            if (method === 'PATCH') { await patchRepo(ctx, owner, name); return; }
            if (method === 'DELETE') { deleteRepo(ctx, owner, name); return; }
            notFound(res); return;
          }
          const contentMatch = tail.match(/^\/contents(?:\/(.*))?$/);
          if (contentMatch) {
            const filePath = decodeURIComponent(contentMatch[1] ?? '');
            if (method === 'PUT') { await putContent(ctx, owner, name, filePath); return; }
            if (method === 'GET') { getContent(ctx, owner, name, filePath); return; }
            if (method === 'DELETE') { await deleteContent(ctx, owner, name, filePath); return; }
            notFound(res); return;
          }
          if (tail === '/labels') {
            if (method === 'GET') { listLabels(ctx, owner, name); return; }
            if (method === 'POST') { await createLabel(ctx, owner, name); return; }
            notFound(res); return;
          }
          if (tail === '/issues') {
            if (method === 'GET') { listIssues(ctx, owner, name); return; }
            if (method === 'POST') { await createIssue(ctx, owner, name); return; }
            notFound(res); return;
          }
          const issueMatch = tail.match(/^\/issues\/(\d+)$/);
          if (issueMatch) {
            const num = Number(issueMatch[1]);
            if (method === 'GET') { getIssue(ctx, owner, name, num); return; }
            if (method === 'PATCH') { await patchIssue(ctx, owner, name, num); return; }
            notFound(res); return;
          }
          const commentsMatch = tail.match(/^\/issues\/(\d+)\/comments$/);
          if (commentsMatch) {
            const num = Number(commentsMatch[1]);
            if (method === 'GET') { listComments(ctx, owner, name, num); return; }
            if (method === 'POST') { await createComment(ctx, owner, name, num); return; }
            notFound(res); return;
          }
          if (tail === '/pulls') {
            if (method === 'GET') { listPulls(ctx, owner, name); return; }
            if (method === 'POST') { await createPull(ctx, owner, name); return; }
            notFound(res); return;
          }
          const pullMatch = tail.match(/^\/pulls\/(\d+)$/);
          if (pullMatch) {
            if (method === 'GET') { getPull(ctx, owner, name, Number(pullMatch[1])); return; }
            notFound(res); return;
          }
          const mergeMatch = tail.match(/^\/pulls\/(\d+)\/merge$/);
          if (mergeMatch) {
            if (method === 'PUT') { await mergePull(ctx, owner, name, Number(mergeMatch[1])); return; }
            notFound(res); return;
          }
          const filesMatch = tail.match(/^\/pulls\/(\d+)\/files$/);
          if (filesMatch) {
            if (method === 'GET') { pullFiles(ctx, owner, name, Number(filesMatch[1])); return; }
            notFound(res); return;
          }
          if (tail === '/branches') {
            if (method === 'GET') { listBranches(ctx, owner, name); return; }
            notFound(res); return;
          }
          const branchMatch = tail.match(/^\/branches\/(.+)$/);
          if (branchMatch) {
            if (method === 'GET') { getBranch(ctx, owner, name, decodeURIComponent(branchMatch[1])); return; }
            notFound(res); return;
          }
          if (tail === '/commits') {
            if (method === 'GET') { listCommits(ctx, owner, name); return; }
            notFound(res); return;
          }
          const commitMatch = tail.match(/^\/commits\/([0-9a-f]{40})$/);
          if (commitMatch) {
            const r = findRepo(owner, name);
            if (!r || !readObject(commitMatch[1])) { notFound(res); return; }
            if (method === 'GET') { sendJson(res, 200, commitJson(commitMatch[1])); return; }
            notFound(res); return;
          }
          notFound(res); return;
        }

        notFound(res);
      } catch {
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
        else res.end();
      }
    })();
  });
}





