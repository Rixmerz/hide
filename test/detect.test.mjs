import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { detectSecrets, looksRandom, preview, toVarName } from '../plugin/lib/detect.mjs';
import { fakes, filler } from './fixtures.mjs';

const EXPECTED = [
  ['anthropic', 'ANTHROPIC_API_KEY'],
  ['openaiProject', 'OPENAI_API_KEY'],
  ['openaiLegacy', 'OPENAI_API_KEY'],
  ['awsKeyId', 'AWS_ACCESS_KEY_ID'],
  ['github', 'GITHUB_TOKEN'],
  ['gitlab', 'GITLAB_TOKEN'],
  ['google', 'GOOGLE_API_KEY'],
  ['stripe', 'STRIPE_SECRET_KEY'],
  ['npm', 'NPM_TOKEN'],
  ['sonar', 'SONAR_TOKEN'],
  ['jwt', 'JWT_TOKEN'],
  ['privateKey', 'PRIVATE_KEY'],
  ['dbUrl', 'DATABASE_URL'],
];

for (const [fixture, name] of EXPECTED) {
  test(`detects ${fixture} and suggests ${name}`, () => {
    const found = detectSecrets(`please use ${fakes[fixture]} for this`);
    assert.equal(found.length, 1, JSON.stringify(found));
    assert.equal(found[0].value, fakes[fixture]);
    assert.equal(found[0].suggested, name);
  });
}

test('prefers the variable name written next to the value', () => {
  const [hit] = detectSecrets(`set MY_OPENAI_KEY=${fakes.openaiProject} in the env`);
  assert.equal(hit.value, fakes.openaiProject);
  assert.equal(hit.suggested, 'MY_OPENAI_KEY');
});

test('catches a generic assignment with a lowercase name', () => {
  const value = filler(20);
  const [hit] = detectSecrets(`db_password: "${value}"`);
  assert.equal(hit.value, value);
  assert.equal(hit.suggested, 'DB_PASSWORD');
});

test('a Bearer JWT is reported once, whole', () => {
  const found = detectSecrets(`curl -H "Authorization: Bearer ${fakes.jwt}"`);
  assert.deepEqual(found.map((f) => f.value), [fakes.jwt]);
});

test('ignores placeholders and variable references', () => {
  const text = 'API_KEY=changeme TOKEN=${GITHUB_TOKEN} SECRET=<your-secret> PASSWORD=xxxxxxxxxx KEY=$OPENAI_API_KEY';
  assert.deepEqual(detectSecrets(text), []);
});

test('plain prose is not a secret', () => {
  assert.deepEqual(detectSecrets('how do I rotate my api key without downtime? the password policy says 12 chars'), []);
});

test('reports several secrets in order of appearance', () => {
  const found = detectSecrets(`first ${fakes.github} then ${fakes.google}`);
  assert.deepEqual(found.map((f) => f.suggested), ['GITHUB_TOKEN', 'GOOGLE_API_KEY']);
});

test('preview never shows the whole value', () => {
  const p = preview(fakes.openaiProject);
  assert.ok(!p.includes(fakes.openaiProject.slice(6, -4)));
  assert.match(p, /\(\d+ chars\)$/);
});

test('toVarName normalizes free text', () => {
  assert.equal(toVarName('my-api key'), 'MY_API_KEY');
  assert.equal(toVarName('9lives'), '_9LIVES');
});

for (const [fixture, name] of EXPECTED.filter(([f]) => !['privateKey', 'dbUrl'].includes(f))) {
  test(`detects ${fixture} glued to the previous word`, () => {
    const found = detectSecrets(`esto es solo un prompt de prueba${fakes[fixture]} ese`);
    assert.equal(found.length, 1, JSON.stringify(found));
    assert.equal(found[0].value, fakes[fixture]);
    assert.equal(found[0].suggested, name);
  });
}

test('the reported case: a project key right after "prueba" on a wrapped line', () => {
  const prompt = `hola como estás puedes configurar esta variable para levantar el proyecto x (esto es solo un\n  prompt de prueba${fakes.openaiProject} ese prompt`;
  assert.deepEqual(detectSecrets(prompt).map((f) => f.value), [fakes.openaiProject]);
});

// Deterministic "random" token: a digest, built at runtime.
const RANDOM_TOKEN = createHash('sha256').update('hide-fixture-7').digest('base64url');

test('catches an unknown-format token that looks random', () => {
  assert.ok(looksRandom(RANDOM_TOKEN), RANDOM_TOKEN);
  const [hit] = detectSecrets(`the vendor gave me ${RANDOM_TOKEN} for staging`);
  assert.equal(hit.value, RANDOM_TOKEN);
  assert.equal(hit.kind, 'high-entropy');
});

test('the high-entropy fallback ignores hashes, ids, paths and identifiers', () => {
  const text = [
    createHash('sha1').update('x').digest('hex'),
    createHash('sha256').update('x').digest('hex'),
    randomUUID(),
    '/Users/me/projects/some-long-folder-name/src/components/UserProfileCard.tsx',
    'handleUserLoginWithTwoFactorVerificationCallback',
    'https://github.com/Rixmerz/hide/blob/main/plugin/lib/detect.mjs',
    'node_modules/@angular/core/fesm2022/core.mjs',
    'THIS_IS_A_VERY_LONG_CONSTANT_NAME_FOR_CONFIG_V2',
  ].join(' ');
  assert.deepEqual(detectSecrets(text), []);
});
