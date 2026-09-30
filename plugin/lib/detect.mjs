// Finds secrets in free text. Each rule names the variable it suggests;
// `group` picks the capture group that holds the secret when the match
// carries context around it (a header, an assignment).

const RULES = [
  { kind: 'private-key', name: 'PRIVATE_KEY', re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]+?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/g },
  { kind: 'anthropic', name: 'ANTHROPIC_API_KEY', re: /\bsk-ant-(?:api|admin)\d{2}-[A-Za-z0-9_-]{80,}/g },
  { kind: 'openai', name: 'OPENAI_API_KEY', re: /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{40,}/g },
  { kind: 'openai', name: 'OPENAI_API_KEY', re: /\bsk-[A-Za-z0-9]{48}\b/g },
  { kind: 'aws-access-key-id', name: 'AWS_ACCESS_KEY_ID', re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { kind: 'github', name: 'GITHUB_TOKEN', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { kind: 'github', name: 'GITHUB_TOKEN', re: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/g },
  { kind: 'gitlab', name: 'GITLAB_TOKEN', re: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { kind: 'slack-webhook', name: 'SLACK_WEBHOOK_URL', re: /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/g },
  { kind: 'slack', name: 'SLACK_TOKEN', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { kind: 'google', name: 'GOOGLE_API_KEY', re: /\bAIza[0-9A-Za-z_-]{35}/g },
  { kind: 'stripe', name: 'STRIPE_SECRET_KEY', re: /\b[sr]k_(?:live|test)_[0-9A-Za-z]{24,}\b/g },
  { kind: 'npm', name: 'NPM_TOKEN', re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { kind: 'sonar', name: 'SONAR_TOKEN', re: /\bsq[pua]_[a-f0-9]{40}\b/g },
  { kind: 'huggingface', name: 'HF_TOKEN', re: /\bhf_[A-Za-z0-9]{34,}\b/g },
  { kind: 'groq', name: 'GROQ_API_KEY', re: /\bgsk_[A-Za-z0-9]{50,}\b/g },
  { kind: 'xai', name: 'XAI_API_KEY', re: /\bxai-[A-Za-z0-9]{70,}\b/g },
  { kind: 'jwt', name: 'JWT_TOKEN', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { kind: 'url-credentials', name: 'DATABASE_URL', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]{3,}@[^\s"'`<>]+/g },
  { kind: 'bearer', name: 'API_TOKEN', re: /\bBearer\s+([A-Za-z0-9._~+/-]{20,}=*)/g, group: 1 },
  {
    kind: 'assignment',
    re: /\b([A-Za-z][A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD))["']?\s*[=:]\s*["']?([^\s"'`,;]{8,})/gi,
    group: 2,
    nameGroup: 1,
  },
];

const PLACEHOLDER = /^(?:[x*.#-]+|changeme|placeholder|redacted|example|dummy|test|secret|password|(?:your|my)[-_].*|<.*>|\$.*|\{.*\}|%.*%|process\.env.*|os\.environ.*)$/i;

export function isPlaceholder(value) {
  return PLACEHOLDER.test(value) || new Set(value).size < 4;
}

// Returns [{ value, kind, suggested }] in order of first appearance, one entry
// per distinct value. A name written next to the value in the prompt
// (OPENAI_KEY=...) beats the rule's generic suggestion.
export function detectSecrets(text) {
  const found = new Map();
  for (const rule of RULES) {
    for (const m of text.matchAll(rule.re)) {
      const value = rule.group ? m[rule.group] : m[0];
      if (!value || isPlaceholder(value)) continue;
      const start = m.index + (rule.group ? m[0].indexOf(value) : 0);
      const named = rule.nameGroup ? toVarName(m[rule.nameGroup]) : null;
      const prev = found.get(value);
      if (prev) {
        if (named) prev.suggested = named;
        continue;
      }
      found.set(value, { value, kind: rule.kind, suggested: named ?? rule.name, start });
    }
  }
  const all = [...found.values()];
  // A generic rule can match a substring of a secret another rule already
  // caught whole (a Bearer JWT, a key inside a URL); keep the longest.
  const kept = all.filter(
    (a) => !all.some((b) => b !== a && b.value.length > a.value.length && b.value.includes(a.value)),
  );
  return kept.sort((a, b) => a.start - b.start).map(({ start, ...rest }) => rest);
}

export function toVarName(raw) {
  const name = raw.replaceAll(/[^A-Za-z0-9]+/g, '_').replaceAll(/^_+|_+$/g, '').toUpperCase();
  return /^[0-9]/.test(name) ? `_${name}` : name;
}

export const VAR_NAME = /^[A-Z_][A-Z0-9_]*$/;

export function preview(value) {
  const flat = value.replace(/\s+/g, ' ');
  if (flat.length <= 12) return `${flat.slice(0, 2)}…(${value.length} chars)`;
  return `${flat.slice(0, 6)}…${flat.slice(-4)} (${value.length} chars)`;
}

export function replaceAll(text, value, replacement) {
  return text.replaceAll(value, replacement);
}
