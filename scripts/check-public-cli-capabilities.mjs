import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { COMMANDS, API_COMMANDS } from '../packages/cli/src/catalog.mjs';
import { getCommandCatalog } from '../packages/skill-runtime/src/cli.mjs';
import { commandFields, parseArguments } from '../packages/cli/src/parser.mjs';
import { helpDocument } from '../packages/cli/src/main.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const failures = [];
const fail = message => failures.push(message);
const text = value => typeof value === 'string' && value.trim().length > 0;
const sameSet = (left, right) => left.length === right.length && left.every(value => right.includes(value));
const publicCommands = new Map(COMMANDS.map(command => [command.name, command]));
const surfaces = { daily: 'cfkanban', admin: 'cfkanban-admin', deploy: 'cfkanban-deploy' };
const sourceCache = new Map();
async function source(relative) {
  if (!text(relative) || path.isAbsolute(relative) || path.relative(root, path.resolve(root, relative)).startsWith('..')) throw new Error(`Unsafe source reference: ${relative}`);
  if (!sourceCache.has(relative)) sourceCache.set(relative, await readFile(path.join(root, relative), 'utf8'));
  return sourceCache.get(relative);
}
function index(rows, key, expected, label) {
  const result = new Map();
  if (!Array.isArray(rows)) { fail(`${label}: expected an array`); return result; }
  for (const row of rows) {
    const id = row?.[key];
    if (!text(id)) { fail(`${label}: empty ${key}`); continue; }
    if (result.has(id)) fail(`${label}: duplicate ${id}`);
    if (!expected.has(id)) fail(`${label}: unknown ${id}`);
    result.set(id, row);
  }
  for (const id of expected.keys()) if (!result.has(id)) fail(`${label}: unclassified ${id}`);
  return result;
}
async function evidence(rows, label, required = true) {
  if (!Array.isArray(rows) || (required && rows.length === 0)) { fail(`${label}: missing source evidence`); return; }
  const seen = new Set();
  for (const row of rows) {
    if (!text(row?.file) || !text(row?.contains)) { fail(`${label}: empty evidence`); continue; }
    const key = `${row.file}:${row.contains}`;
    if (seen.has(key)) fail(`${label}: duplicate source evidence ${row.file}`);
    seen.add(key);
    try { if (!(await source(row.file)).includes(row.contains)) fail(`${label}: source evidence drifted (${row.file}: ${row.contains})`); }
    catch (error) { fail(`${label}: ${error.message}`); }
  }
}
const browserOperations = {
  one_time_browser_transport: ['getInvitationBootstrap', 'getWebLaunchPage', 'redeemWebLaunch'],
  cookie_session: ['getWebSession', 'revokeWebSession', 'renewWebSession'],
  webauthn: ['createPasskeyRegistrationOptions', 'registerPasskey', 'createWebAuthenticationOptions', 'verifyWebAuthentication'],
};
async function coverage(row, label, { operation, helper, workflow = false } = {}) {
  const value = row?.coverage;
  if (!value || !Array.isArray(value.commands)) { fail(`${label}: empty coverage`); return; }
  if (new Set(value.commands).size !== value.commands.length) fail(`${label}: duplicate command references`);
  for (const name of value.commands) if (!publicCommands.has(name)) fail(`${label}: unknown public command ${name}`);
  if (value.kind === 'gap') { fail(`${label}: unresolved capability gap (${value.reason ?? 'no route'})`); return; }
  if (!['api', 'helper', 'composition', 'operation_catalog', 'browser'].includes(value.kind)) { fail(`${label}: unknown coverage kind ${value.kind}`); return; }
  if (value.kind !== 'browser' && value.commands.length === 0) fail(`${label}: empty command coverage`);
  if (value.kind === 'api') {
    if (!operation || value.commands.some(name => publicCommands.get(name)?.operation !== operation)) fail(`${label}: public API route does not match operation`);
  } else if (value.kind === 'helper') {
    if (!helper || value.commands.some(name => name === 'connection list' || publicCommands.get(name)?.helper !== helper)) fail(`${label}: public helper route does not match Skill command`);
  } else if (value.kind === 'operation_catalog') {
    if (helper !== 'api request' || !sameSet(value.commands, API_COMMANDS.map(command => command.name))) fail(`${label}: generic Skill API replacement must cover the entire public operation catalog`);
    if (!text(value.note)) fail(`${label}: missing replacement semantics`);
  } else if (value.kind === 'composition') {
    if (!text(value.note)) fail(`${label}: missing composition semantics`);
    if (!workflow) {
      await evidence(value.evidence, label);
      if (helper) {
        const symbol = { 'state init': 'initializeStateRoot', 'web launch': 'createBrowserLaunchAndDeliver', 'migrations reconcile': 'reconcileMigrationState' }[helper];
        if (!value.evidence?.some(item => (symbol && item.contains.includes(symbol)) || ['helper', 'dispatchImpl'].some(call => item.contains.includes(`${call}('${helper}'`) || item.contains.includes(`${call}("${helper}"`)))) fail(`${label}: composition evidence does not invoke the Skill helper or its shared implementation`);
      }
    }
  } else if (value.kind === 'browser') {
    if (!text(value.reason) || !text(value.alternative)) fail(`${label}: browser exception requires a concrete reason and usable alternative`);
    if (operation && !browserOperations[value.transport]?.includes(operation)) fail(`${label}: operation is not an approved ${value.transport} transport exception`);
    if (helper) fail(`${label}: a missing Skill helper cannot be disguised as a browser exception`);
    if (workflow && (row.id !== 'host-mcp-configuration' || value.transport !== 'host_configuration')) fail(`${label}: unknown host workflow exception`);
    if (!workflow) await evidence(value.evidence, label);
  }
}

// Documentation examples are parsed only; no command, credential, network, file input or stdin is executed.
const placeholders = {
  'instance-uuid': '11111111-1111-4111-8111-111111111111',
  'project-uuid': '22222222-2222-4222-8222-222222222222',
  'operation-uuid': '33333333-3333-4333-8333-333333333333',
  'workspace-uuid': '44444444-4444-4444-8444-444444444444',
  'stable-key': 'offline-doc-example-key',
  file: '/offline-doc-fixture/input.md',
  'output-file': '/offline-doc-fixture/output.md',
  'plan-file': '/offline-doc-fixture/plan.json',
};
function tokenize(line) {
  const matches = line.match(/"(?:\\.|[^"\\])*"|'[^']*'|\S+/g) ?? [];
  return matches.map(value => value.startsWith('"') ? JSON.parse(value) : value.startsWith("'") ? value.slice(1, -1) : value);
}
function exampleLines(markdown) {
  const result = [];
  let fence = false;
  for (const [index, line] of markdown.split('\n').entries()) {
    if (/^\s*```/.test(line)) { fence = !fence; continue; }
    if (fence && /^\s*(?:cfkanban(?:\s|$)|node\s+\S*\/cli\/cfkanban\.mjs(?:\s|$))/.test(line)) result.push({ line: index + 1, text: line.trim() });
    if (!fence) for (const match of line.matchAll(/`(cfkanban(?:\s+[^`]+)?)`/g)) result.push({ line: index + 1, text: match[1] });
  }
  return result;
}
function fixtureValue(field) {
  if (field.schema?.format === 'uuid') return placeholders['instance-uuid'];
  if (field.schema?.enum) return field.schema.enum[0];
  if (field.schema?.type === 'integer' || field.schema?.type === 'number') return Math.max(1, field.schema.minimum ?? 0);
  if (field.schema?.type === 'boolean') return true;
  if (field.schema?.type === 'array') return [];
  if (field.schema?.type === 'object') return {};
  if (field.name === 'identifier' || field.name.endsWith('_identifier')) return 'CFK-123';
  return 'offline-doc-fixture';
}
async function parseExample(example, file) {
  const label = `${file}:${example.line}`;
  let tokens;
  try { tokens = tokenize(example.text); } catch { fail(`${label}: invalid quoted example`); return null; }
  if (tokens[0] === 'node') tokens = tokens.slice(2); else tokens = tokens.slice(1);
  const semanticTokens = tokens.map((value, index) => tokens[index - 1] === '--locale' ? '<locale>' : value);
  let invalidPlaceholder = false;
  tokens = tokens.map(value => value.replace(/<([^>]+)>/g, (_, name) => {
    if (!Object.hasOwn(placeholders, name)) { fail(`${label}: unknown placeholder <${name}>`); invalidPlaceholder = true; return 'unknown'; }
    return placeholders[name];
  }));
  if (invalidPlaceholder) return null;
  const words = tokens.slice(0, tokens.findIndex(value => value.startsWith('-')) < 0 ? tokens.length : tokens.findIndex(value => value.startsWith('-')));
  const command = publicCommands.get(words.join(' '));
  const fields = command ? commandFields(command) : {};
  const fixtureInput = Object.fromEntries(Object.values(fields).filter(field => field.required).map(field => [field.name, fixtureValue(field)]));
  try {
    const parsed = await parseArguments(tokens, { stdin: Readable.from(['offline-doc-fixture']), fileRead: async () => tokens.includes('--input-file') ? JSON.stringify(fixtureInput) : 'Offline documentation body' });
    if (parsed.help) {
      const prefix = parsed.prefix === 'howto' ? '' : parsed.prefix;
      const english = helpDocument(prefix, 'en');
      const chinese = helpDocument(prefix, 'zh-CN');
      if (english.commands.length === 0) fail(`${label}: unknown help path ${prefix}`);
      const semantics = document => ({ exact: document.exact, exit_codes: document.exit_codes, commands: document.commands.map(({ description, ...item }) => item) });
      if (JSON.stringify(semantics(english)) !== JSON.stringify(semantics(chinese))) fail(`${label}: bilingual help command/option semantics differ`);
    } else if (!parsed.version && !publicCommands.has(parsed.command?.name)) fail(`${label}: unknown parsed command`);
    return semanticTokens;
  } catch (error) { fail(`${label}: invalid public example (${error.code ?? error.message})`); return null; }
}
async function documentationExamples() {
  const directories = ['apps/docs/en/cli', 'apps/docs/zh-CN/cli'];
  const inventories = await Promise.all(directories.map(directory => readdir(path.join(root, directory))));
  const files = inventories.map(names => names.filter(name => name.endsWith('.md')).sort());
  if (!sameSet(files[0], files[1])) fail('CLI documentation: bilingual page inventories differ');
  let total = 0;
  for (const filename of new Set(files.flat())) {
    const pairs = [];
    for (const directory of directories) {
      const file = `${directory}/${filename}`;
      try {
        const examples = exampleLines(await source(file));
        const parsed = [];
        for (const example of examples) { parsed.push(await parseExample(example, file)); total++; }
        pairs.push(parsed);
      } catch (error) { fail(`${file}: ${error.message}`); pairs.push([]); }
    }
    if (JSON.stringify(pairs[0]) !== JSON.stringify(pairs[1])) fail(`${filename}: bilingual public command examples differ in command/option semantics`);
  }
  return total;
}

async function check() {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--matrix')) throw new Error('Usage: node scripts/check-public-cli-capabilities.mjs [--matrix PATH]');
  const matrix = JSON.parse(args.length ? await readFile(path.resolve(args[1]), 'utf8') : await source('docs/specs/public-cli-capabilities.json'));
  const contract = JSON.parse(await source('contracts/openapi.json'));
  if (matrix.schema_version !== 1) fail('Matrix schema_version must be 1');
  if (publicCommands.size !== COMMANDS.length) fail('Public catalog contains duplicate commands');
  const sourcePaths = { openapi: 'contracts/openapi.json', public_catalog: 'packages/cli/src/catalog.mjs', skill_catalog: 'packages/skill-runtime/src/cli.mjs' };
  if (JSON.stringify(matrix.sources) !== JSON.stringify(sourcePaths)) fail('Matrix source declarations drifted');
  const declaredSkills = index(matrix.skills, 'name', new Map(Object.values(surfaces).map(name => [name, true])), 'Matrix Skills');
  for (const [surface, name] of Object.entries(surfaces)) {
    const row = declaredSkills.get(name);
    if (row && (row.surface !== surface || row.entry !== `skills/${name}/SKILL.md`)) fail(`Matrix Skills: entry/surface drift for ${name}`);
    if (row) try { await source(row.entry); await source(row.reference); } catch (error) { fail(`Matrix Skills ${name}: ${error.message}`); }
  }
  if (!Array.isArray(matrix.limits) || !matrix.limits.some(value => value.includes('跨平台'))) fail('Matrix must retain its verification limits');
  const operations = new Map(Object.entries(contract.paths).flatMap(([apiPath, methods]) => Object.entries(methods).filter(([, operation]) => operation.operationId).map(([method, operation]) => [operation.operationId, { method: method.toUpperCase(), path: apiPath }])));
  const helperCommands = new Map(getCommandCatalog().commands.map(command => [command.name, command]));
  const publicRows = index(matrix.public_commands, 'command', publicCommands, 'Public commands');
  for (const [name, row] of publicRows) {
    const command = publicCommands.get(name);
    if (!command) continue;
    const route = name === 'connection list' ? { kind: 'mcp', tool: 'cfkanban_connection_inspect' } : command.operation ? { kind: 'api', operation: command.operation } : command.helper ? { kind: 'helper', command: command.helper } : { kind: 'workflow', workflow: command.workflow };
    if (JSON.stringify(row.route) !== JSON.stringify(route) || row.effect !== command.effect) fail(`Public commands: route/effect drift for ${name}`);
    if (command.operation) {
      const header = command.parameters.some(parameter => parameter.in === 'header' && parameter.name.toLowerCase() === 'idempotency-key');
      const supportsIdempotency = command.write_contract?.includes('idempotent') === true;
      if (header !== supportsIdempotency) fail(`Public commands: write contract/Idempotency-Key drift for ${name}`);
      if (Object.hasOwn(commandFields(command), 'idempotency-key') !== supportsIdempotency) fail(`Public commands: idempotency option drift for ${name}`);
    }
    if (name === 'connection list') await evidence(row.evidence, `Public command ${name}`);
  }
  for (const [id, row] of index(matrix.operations, 'operation', operations, 'OpenAPI operations')) {
    const operation = operations.get(id);
    if (operation && (row.method !== operation.method || row.path !== operation.path)) fail(`OpenAPI operations: method/path drift for ${id}`);
    await coverage(row, `OpenAPI ${id}`, { operation: id });
  }
  for (const [name, row] of index(matrix.skill_commands, 'command', helperCommands, 'Skill commands')) {
    const expectedSkills = Object.entries(surfaces).filter(([surface]) => getCommandCatalog({ surface }).commands.some(command => command.name === name)).map(([, skill]) => skill);
    if (!Array.isArray(row.skills) || !sameSet(row.skills, expectedSkills)) fail(`Skill commands: surface coverage drift for ${name}`);
    if (helperCommands.has(name) && row.effect !== helperCommands.get(name).effect) fail(`Skill commands: effect drift for ${name}`);
    await coverage(row, `Skill ${name}`, { helper: name });
  }
  for (const row of matrix.transport_constraints ?? []) {
    if (row.transport !== 'stdout_once' || !Array.isArray(row.skill_commands) || !sameSet(row.skill_commands, ['web launch', 'invite create'])) fail('Transport constraints: unknown one-time delivery exception');
    if (!Array.isArray(row.commands) || row.commands.length === 0 || row.commands.some(name => !publicCommands.has(name))) fail('Transport constraints: missing or unknown public alternative');
    if (!text(row.reason) || !text(row.alternative)) fail('Transport constraints: concrete reason and alternative required');
    await evidence(row.evidence, 'Transport stdout_once');
  }
  const workflowIds = new Set();
  const coveredSkills = new Set();
  if (!Array.isArray(matrix.skill_workflows) || matrix.skill_workflows.length === 0) fail('Skill workflows: empty coverage');
  for (const row of matrix.skill_workflows ?? []) {
    if (!text(row.id) || workflowIds.has(row.id)) fail(`Skill workflows: duplicate or empty ${row.id}`);
    workflowIds.add(row.id);
    if (!Object.values(surfaces).includes(row.skill)) fail(`Skill workflows: unknown Skill ${row.skill}`);
    coveredSkills.add(row.skill);
    try { if (!text(row.heading) || !(await source(row.reference)).includes(`## ${row.heading}`)) fail(`Skill workflows: reference heading drift for ${row.id}`); }
    catch (error) { fail(`Skill workflows ${row.id}: ${error.message}`); }
    await coverage(row, `Workflow ${row.id}`, { workflow: true });
  }
  if (!sameSet([...coveredSkills], Object.values(surfaces))) fail('Skill workflows: each of the three Skills needs explicit coverage');
  const examples = await documentationExamples();
  if (failures.length) {
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
  } else console.log(`Public CLI capabilities: ${publicRows.size} commands, ${operations.size} OpenAPI operations, ${helperCommands.size} Skill commands, ${workflowIds.size} workflows and ${examples} bilingual examples checked offline.`);
}
await check().catch(error => { console.error(`Public CLI capabilities check failed: ${error.message}`); process.exitCode = 1; });
