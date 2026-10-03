// State the hooks module (hooks/hide.tsx) keeps in the session. Only masked
// previews and names live here, never a secret's value: the values stay in
// the module's own memory until they reach the keychain.

export type HideCandidate = { preview: string; kind: string; suggested: string };

export type HideAsk = {
  candidates: HideCandidate[];
  // One entry per candidate answered so far: a variable name, or null for
  // "not a secret".
  names: (string | null)[];
  existing: string[];
  // A name the person must confirm before an existing secret is overwritten.
  confirm?: string;
  error?: string;
  isSaving?: boolean;
};

declare module 'claude-code' {
  interface PluginState {
    hide: { ask: HideAsk | null };
  }
}
