// Fake secrets shaped like the real formats. They are assembled at runtime
// from an obviously fake filler so no literal in this repo looks like a real
// credential to a secret scanner.

const FILL = 'FAKE0fake1FAKE2fake3FAKE4fake5FAKE6fake7FAKE8fake9';

export function filler(length, alphabet = FILL) {
  return alphabet.repeat(Math.ceil(length / alphabet.length)).slice(0, length);
}

const upper = 'FAKE0FAKE1FAKE2FAKE3';
const hex = '0123456789abcdef';

export const fakes = {
  anthropic: ['sk', 'ant', 'api03', filler(90)].join('-'),
  openaiProject: ['sk', 'proj', filler(60)].join('-'),
  openaiLegacy: 'sk-' + filler(48),
  awsKeyId: 'AKIA' + filler(16, upper),
  github: 'ghp' + '_' + filler(36),
  gitlab: 'glpat' + '-' + filler(20),
  google: 'AIza' + filler(35),
  stripe: ['sk', 'test', filler(24)].join('_'),
  npm: 'npm' + '_' + filler(36),
  sonar: 'sqp' + '_' + filler(40, hex),
  jwt: ['eyJ' + filler(20), 'eyJ' + filler(30), filler(24)].join('.'),
  privateKey: ['-----BEGIN ' + 'PRIVATE KEY-----', filler(64), filler(64), '-----END ' + 'PRIVATE KEY-----'].join('\n'),
  dbUrl: 'postgres' + '://app:' + filler(16) + '@db.example.test:5432/app',
};
