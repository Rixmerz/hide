// Replaces secret values in a byte stream with `[hide:NAME]`. A secret can
// arrive split across two chunks, so each flush holds back the last
// (longest secret - 1) characters until the next chunk or the end.

import { Transform } from 'node:stream';

// Each secret is masked as written, in the encodings a command is most likely
// to echo it in (base64 for Basic auth, URL-encoding for query strings), and
// line by line for multi-line values such as a PEM key read with `head`.
export function maskVariants(secrets) {
  const out = [];
  for (const [name, value] of Object.entries(secrets)) {
    if (!value) continue;
    const lines = value.split(/\r?\n/).filter((l) => l.length >= 16 && !l.startsWith('-----'));
    const forms = new Set([value, Buffer.from(value).toString('base64'), encodeURIComponent(value), ...(lines.length > 1 ? lines : [])]);
    for (const form of forms) if (form.length >= 4) out.push([form, `[hide:${name}]`]);
  }
  return out.sort((a, b) => b[0].length - a[0].length);
}

export function maskText(text, variants) {
  for (const [form, label] of variants) text = text.replaceAll(form, label);
  return text;
}

export function maskStream(variants) {
  const keep = Math.max(0, ...variants.map(([form]) => form.length)) - 1;
  let pending = '';
  return new Transform({
    decodeStrings: false,
    transform(chunk, _enc, done) {
      pending = maskText(pending + chunk.toString('utf8'), variants);
      // Never cut inside a label we just wrote: hold back from its start.
      let cut = Math.max(0, pending.length - keep);
      const open = pending.lastIndexOf('[hide:', cut);
      if (open !== -1 && pending.indexOf(']', open) >= cut) cut = open;
      this.push(pending.slice(0, cut));
      pending = pending.slice(cut);
      done();
    },
    flush(done) {
      this.push(maskText(pending, variants));
      done();
    },
  });
}
