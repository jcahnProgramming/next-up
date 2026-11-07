import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// The MCP server reads whatever database getDb() opens (core/config.js: DATA_DIR). Point it at a scratch folder
// BEFORE anything imports config, never at data/. node:test runs each file in its own process, so this is ours alone.
const dir = mkdtempSync(join(tmpdir(), 'nu-mcp-read-'));
process.env.DATA_DIR = dir;
process.env.DB_FILE = 'next-up.db';
const { runMigrations } = await import('../core/migrations.js');
const { coreMigrations } = await import('../core/schema.js');
const { startApp } = await import('./helpers.js');
const { initPlatform } = await import('../core/platform.js');
const { closeDb, getDb } = await import('../core/db.js');
const { createMcpApp } = await import('../mcp/app.js');

const TOKEN = 'test-token-0123456789abcdef';
const PW = 'raid night 8pm';
const DAY = 24 * 60 * 60 * 1000;

let file; // the web app's own connection to the database file
let web; // the web app, writing to the file through its own connection, as the next-up container does
let mcp; // the MCP server on the same file, opened the way mcp/index.js opens it
let client;
const seen = []; // every text any tool answered, for the "never says a code it wasn't given" check

const ids = {};

before(async () => {
  file = new Database(join(dir, 'next-up.db'));
  file.pragma('journal_mode = WAL');
  file.pragma('foreign_keys = ON');
  const log = console.log;
  console.log = () => {};
  try {
    runMigrations(file, 'core', coreMigrations);
    initPlatform({ readOnly: true });
  } finally {
    console.log = log;
  }
  web = await startApp({ db: () => file });
  web.clock.t = Date.now(); // the MCP measures deletions against the real clock

  const make = async (code, password) => (await web.request('/api/boards', { method: 'POST', body: { code, password, actor: 'Path' } })).cookie;
  const card = async (code, cookie, body) =>
    (await web.request(`/api/boards/${code}/cards`, { method: 'POST', body: { actor: 'Path', ...body }, cookie })).body.card;

  // An open board: Up Next has two cards, Now Playing one, Played none.
  const open = await make('pnc-raids');
  const dune = await card('pnc-raids', open, { title: 'Dune', logo: 'dune-awakening', lane: 'up_next', goLive: '2026-10-24', serverInfo: 'EU-West 3 · https://example.com/dune' });
  const valheim = await card('pnc-raids', open, { title: 'Valheim', lane: 'up_next' });
  const wow = await card('pnc-raids', open, { title: 'World of Warcraft', lane: 'now_playing' });
  const gone = await card('pnc-raids', open, { title: 'Palworld', lane: 'up_next' });
  for (const name of ['Path', 'Bunzato', 'Kaelis']) {
    await web.request(`/api/boards/pnc-raids/cards/${dune.id}/players`, { method: 'POST', body: { name, actor: name }, cookie: open });
  }
  await web.request(`/api/boards/pnc-raids/cards/${gone.id}`, { method: 'DELETE', body: { version: gone.version, actor: 'Bunzato' }, cookie: open });
  await web.request(`/api/boards/pnc-raids/cards/${valheim.id}/move`, { method: 'POST', body: { lane: 'up_next', index: 0, actor: 'Kaelis' }, cookie: open });
  Object.assign(ids, { dune: dune.id, valheim: valheim.id, wow: wow.id, gone: gone.id });

  // Two cards whose titles differ only in case, on a second open board.
  const twins = await make('other-crew');
  ids.twinA = (await card('other-crew', twins, { title: 'Rust', lane: 'up_next' })).id;
  ids.twinB = (await card('other-crew', twins, { title: 'RUST', lane: 'played' })).id;
  ids.numbered = (await card('other-crew', twins, { title: '1942', lane: 'played' })).id;

  // A password board with everything a leak could show.
  const vault = await make('locked-vault', PW);
  ids.secret = (await card('locked-vault', vault, { title: 'Secret Game', logo: 'secret-logo', lane: 'up_next', goLive: '2027-01-02', serverInfo: 'hidden.example.net' })).id;
  await web.request(`/api/boards/locked-vault/cards/${ids.secret}/players`, { method: 'POST', body: { name: 'Hidden Player' }, cookie: vault });

  // A board being deleted, and one past its 24 hours that the sweep hasn't reached yet.
  const deleting = await make('going-soon');
  await web.request('/api/boards/going-soon/deletion', { method: 'POST', body: { confirm: 'going-soon', actor: 'Path' }, cookie: deleting });
  const expired = await make('long-gone');
  web.clock.t = Date.now() - 2 * DAY;
  await web.request('/api/boards/long-gone/deletion', { method: 'POST', body: { confirm: 'long-gone' }, cookie: expired });
  web.clock.t = Date.now();

  mcp = createMcpApp({ token: () => TOKEN }).listen(0, '127.0.0.1');
  await new Promise((resolve) => mcp.once('listening', resolve));
  client = new Client({ name: 'test', version: '0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcp.address().port}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
    }),
  );
});

after(async () => {
  await client?.close();
  await new Promise((resolve) => (mcp ? mcp.close(() => resolve()) : resolve()));
  await web?.close();
  // Both connections must be closed before the folder is deleted: Windows refuses to delete a file that is open
  // (macOS and Linux allow it, which hid this).
  file?.close();
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

/** Calls a tool over MCP: { error } for an error answer, else the parsed JSON. Records the raw text. */
async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content.map((c) => c.text).join('\n');
  seen.push({ name, args, text });
  return result.isError ? { error: text } : JSON.parse(text);
}

describe('get_board', () => {
  test('lanes in board order, cards top to bottom, an empty lane empty', async () => {
    const board = await call('get_board', { code: 'PNC-Raids' });
    assert.equal(board.status, 'open');
    assert.equal(board.code, 'pnc-raids');
    assert.equal(board.deletion, null);
    assert.deepEqual(board.lanes.map((l) => [l.id, l.name]), [['up_next', 'Up Next'], ['now_playing', 'Now Playing'], ['played', 'Played']]);
    assert.deepEqual(board.lanes[0].cards, [
      { id: ids.valheim, title: 'Valheim', logo: null, goLive: null, playerCount: 0, position: 1 },
      { id: ids.dune, title: 'Dune', logo: 'dune-awakening', goLive: '2026-10-24', playerCount: 3, position: 2 },
    ]);
    assert.deepEqual(board.lanes[1].cards.map((c) => c.title), ['World of Warcraft']);
    assert.deepEqual(board.lanes[2].cards, []);
  });

  test('an unknown code is plainly not found; a malformed one says why without repeating it', async () => {
    assert.match((await call('get_board', { code: 'no-such-board' })).error, /no board with that code/);
    const bad = await call('get_board', { code: 'Bad Code!' });
    assert.match(bad.error, /letters, numbers and hyphens/);
    assert.doesNotMatch(bad.error, /Bad Code/);
  });

  test('a board being deleted says when it will be erased; one past its 24 hours is gone', async () => {
    const board = await call('get_board', { code: 'going-soon' });
    assert.equal(board.status, 'open');
    assert.equal(Date.parse(board.deletion.purgeAt) - Date.parse(board.deletion.scheduledAt), DAY);
    for (const name of ['get_board', 'get_history']) {
      assert.match((await call(name, { code: 'long-gone' })).error, /no board with that code/);
    }
  });
});

describe('get_card', () => {
  test('by id: everything on the card, players in sign-up order', async () => {
    const { status, card } = await call('get_card', { code: 'pnc-raids', card: ids.dune });
    assert.equal(status, 'open');
    assert.deepEqual(
      { ...card, players: card.players.map((p) => p.name), createdAt: typeof card.createdAt, updatedAt: typeof card.updatedAt },
      {
        id: ids.dune,
        title: 'Dune',
        logo: 'dune-awakening',
        lane: 'Up Next',
        position: 2,
        goLive: '2026-10-24',
        serverInfo: 'EU-West 3 · https://example.com/dune',
        players: ['Path', 'Bunzato', 'Kaelis'],
        createdAt: 'string',
        updatedAt: 'string',
      },
    );
  });

  test('by exact title, ignoring case', async () => {
    assert.equal((await call('get_card', { code: 'pnc-raids', card: 'world of WARCRAFT' })).card.id, ids.wow);
    assert.match((await call('get_card', { code: 'pnc-raids', card: 'World' })).error, /No card on this board has that title/);
  });

  test('a title that fits more than one card returns the choices, never a guess', async () => {
    const answer = await call('get_card', { code: 'other-crew', card: 'rust' });
    assert.deepEqual(answer, {
      status: 'ambiguous',
      choices: [
        { id: ids.twinB, title: 'RUST', lane: 'Played', position: 1 },
        { id: ids.twinA, title: 'Rust', lane: 'Up Next', position: 1 },
      ],
    });
  });

  test('a title made of digits is a title first, an id after', async () => {
    assert.equal((await call('get_card', { code: 'other-crew', card: '1942' })).card.id, ids.numbered);
    assert.equal((await call('get_card', { code: 'other-crew', card: String(ids.twinA) })).card.title, 'Rust');
  });

  test('a deleted card says so; another board’s card is no card at all', async () => {
    assert.match((await call('get_card', { code: 'pnc-raids', card: ids.gone })).error, /was deleted/);
    for (const card of [ids.secret, ids.twinA, String(ids.secret)]) {
      const answer = await call('get_card', { code: 'pnc-raids', card });
      assert.match(answer.error, /no card with that id on this board/, String(card));
      assert.doesNotMatch(answer.error, /Secret|Rust/);
    }
  });
});

describe('get_history', () => {
  test('newest first, worded as the History panel words it, with no payloads', async () => {
    const { status, changes, next } = await call('get_history', { code: 'pnc-raids' });
    assert.equal(status, 'open');
    assert.equal(next, null);
    assert.deepEqual(changes.map((c) => c.text), [
      'Kaelis moved Valheim · Up Next, 2nd → 1st',
      'Bunzato deleted Palworld',
      'Kaelis added player Kaelis to Dune',
      'Bunzato added player Bunzato to Dune',
      'Path added player Path to Dune',
      'Path added Palworld to Up Next',
      'Path added World of Warcraft to Now Playing',
      'Path added Valheim to Up Next',
      'Path added Dune to Up Next',
      'Path created the board',
    ]);
    for (const c of changes) {
      assert.deepEqual(Object.keys(c).sort(), ['actor', 'at', 'cardId', 'id', 'restoredBy', 'text', 'undoes']);
    }
    // The server info typed on a card is in card.created's payload; History never shows it, so neither does this.
    assert.ok(!seen.at(-1).text.includes('EU-West'));
  });

  test('pages with limit and before; at most 100 per answer', async () => {
    const first = await call('get_history', { code: 'pnc-raids', limit: 4 });
    assert.equal(first.changes.length, 4);
    const second = await call('get_history', { code: 'pnc-raids', limit: 4, before: first.next });
    assert.equal(second.changes[0].text, 'Path added player Path to Dune');
    const third = await call('get_history', { code: 'pnc-raids', limit: 4, before: second.next });
    assert.equal(third.changes.length, 2);
    assert.equal(third.next, null);

    assert.ok((await call('get_history', { code: 'pnc-raids', limit: 101 })).error);
    assert.match((await call('get_history', { code: 'pnc-raids', before: 'nonsense' })).error, /isn’t a cursor/);
  });

  test('a cursor from another board reads only this board', async () => {
    const other = await call('get_history', { code: 'other-crew', limit: 1 });
    const answer = await call('get_history', { code: 'pnc-raids', before: other.next });
    assert.ok(answer.changes.every((c) => !/Rust|1942/.test(c.text)));
  });
});

describe('password boards', () => {
  test('every tool, whatever it is asked, answers exactly { status: "locked" }', async () => {
    const asks = [
      ['get_board', { code: 'locked-vault' }],
      ['get_board', { code: 'LOCKED-VAULT' }],
      ['get_card', { code: 'locked-vault', card: ids.secret }],
      ['get_card', { code: 'locked-vault', card: 'Secret Game' }],
      ['get_card', { code: 'locked-vault', card: 'nothing by this name' }],
      ['get_card', { code: 'locked-vault', card: 999999 }],
      ['get_history', { code: 'locked-vault' }],
      ['get_history', { code: 'locked-vault', limit: 100 }],
      ['get_history', { code: 'locked-vault', before: '2026-01-01T00:00:00.000Z~1' }],
      ['get_history', { code: 'locked-vault', before: 'not a cursor' }],
    ];
    for (const [name, args] of asks) {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, undefined, `${name} ${JSON.stringify(args)}`);
      assert.deepEqual(JSON.parse(result.content[0].text), { status: 'locked' }, `${name} ${JSON.stringify(args)}`);
      seen.push({ name, args, text: result.content[0].text });
    }
  });

  test('no tool takes a password, a cookie or a token', async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ['get_board', 'get_card', 'get_history', 'get_version']);
    for (const tool of tools) {
      for (const key of Object.keys(tool.inputSchema.properties ?? {})) {
        assert.doesNotMatch(key, /pass|cookie|token|grant|secret|key/i, `${tool.name}.${key}`);
      }
      assert.match(tool.description, tool.name === 'get_version' ? /./ : /\{"status":"locked"\}/, tool.name);
    }
  });
});

describe('the MCP never says a code it wasn’t given', () => {
  test('no answer or error, across every call above, names a board code other than the one asked about', async () => {
    const codes = ['pnc-raids', 'other-crew', 'locked-vault', 'going-soon', 'long-gone'];
    assert.ok(seen.length > 30);
    for (const { name, args, text } of seen) {
      for (const code of codes) {
        if (String(args.code).toLowerCase() === code) continue;
        assert.ok(!text.toLowerCase().includes(code), `${name} ${JSON.stringify(args)} mentioned ${code}`);
      }
    }
  });
});

describe('read-only', () => {
  test('the MCP’s own database connection refuses every write', () => {
    const db = getDb();
    assert.equal(db.pragma('query_only', { simple: true }), 1);
    const writes = [
      "INSERT INTO boards (code) VALUES ('mcp-made-this')",
      'UPDATE cards SET title = \'changed\'',
      'DELETE FROM players',
      "INSERT INTO events (board_id, type, actor, payload) VALUES (1, 'board.created', 'x', '{}')",
      'CREATE TABLE sneaky (id INTEGER)',
    ];
    for (const sql of writes) assert.throws(() => db.prepare(sql).run(), /readonly|read-only|query_only/i, sql);
    assert.equal(db.prepare("SELECT COUNT(*) FROM boards WHERE code = 'mcp-made-this'").pluck().get(), 0);
  });
});
