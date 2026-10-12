// Prompt playground: translate sample segments per scene against a real API
// and print latency, usage, validation results and the raw reply.
//
//   XT_API_KEY=sk-... pnpm try                  # all scenes, DeepSeek preset
//   XT_API_KEY=... pnpm try --provider glm --scene social
//   XT_API_KEY=... pnpm try --compare           # general vs scene expert side by side
//   XT_API_KEY=... pnpm try --provider anthropic --extra '{"output_config":{"effort":"medium"}}'
//   XT_API_KEY=... pnpm try --provider anthropic --sweep   # effort/thinking variants, summary table
import { buildBatchMessages } from '../src/prompt/assemble';
import { BUILTIN_EXPERTS } from '../src/prompt/experts/builtin';
import { findHits, parseGlossary } from '../src/prompt/glossary';
import { SegmentStreamParser } from '../src/background/stream-parser';
import { streamChat, type Usage } from '../src/background/providers';
import { validateTranslation } from '../src/background/validate';
import { PROVIDER_PRESETS } from '../src/shared/presets';
import { costOf, resolvedPrice } from '../src/shared/pricing';

const SAMPLES: Record<string, { title: string; segments: string[] }> = {
  tech: {
    title: 'Getting Started — Vite',
    segments: [
      'Getting Started',
      'Run <c1>npm create vite@latest</c1> and follow the prompts. Open <a2>Settings</a2> to change the default port.',
      'Each commit triggers a pull request preview, so reviewers can test the change before it lands on main.',
    ],
  },
  news: {
    title: 'Central bank holds rates steady',
    segments: [
      'Central bank holds rates as inflation cools',
      '"We are not yet where we need to be," the governor told reporters on Tuesday, according to a transcript.',
      'Consumer prices rose 2.4% in September from a year earlier, down from 2.9% in August.',
    ],
  },
  academic: {
    title: 'Sparse Attention for Long Documents',
    segments: [
      'Our results suggest that sparse attention may reduce memory by up to 40% (p < 0.05, n = 120), consistent with Smith et al. (2021).',
      'In the ablation study, removing the gating module degrades accuracy on all benchmarks [12].',
    ],
  },
  rigorous: {
    title: 'Terms of Service',
    segments: [
      'You shall not use the Services for any unlawful purpose, except as expressly permitted by these Terms.',
      'We may suspend your account at any time, provided that we notify you within 30 days, unless prohibited by law.',
    ],
  },
  social: {
    title: 'r/programming',
    segments: [
      'ngl this refactor is chef\'s kiss, OP really cooked',
      'lmao the build broke again, cope harder',
      '@lena_oak based take tbh',
    ],
  },
  fiction: {
    title: 'Chapter 3',
    segments: [
      '"You\'re late," Mira said, not looking up from the map.',
      'Kael shrugged. "The river was faster than I remembered. Or I was slower."',
    ],
  },
};

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const providerId = opt('provider') ?? 'deepseek';
const sceneFilter = opt('scene');
const compare = args.includes('--compare');
const sweep = args.includes('--sweep');
const glossary = parseGlossary(opt('glossary')?.replace(/;/g, '\n') ?? 'pull request => KEEP\ncommit => KEEP');

const preset = PROVIDER_PRESETS.find((p) => p.id === providerId);
if (!preset) throw new Error(`unknown provider ${providerId}`);
const provider = {
  ...preset,
  apiKey: process.env.XT_API_KEY ?? '',
  model: opt('model') ?? preset.model,
  baseURL: opt('base') ?? preset.baseURL,
  extraBody: { ...preset.extraBody, ...(opt('extra') ? JSON.parse(opt('extra')!) : {}) },
};
if (!provider.apiKey) {
  console.error('Set XT_API_KEY to your API key.');
  process.exit(1);
}

async function translate(expertId: string, scene: string, p = provider) {
  const sample = SAMPLES[scene]!;
  const expert = BUILTIN_EXPERTS.find((e) => e.id === expertId)!;
  const hits = glossary.filter((g) => sample.segments.some((s) => findHits([g], s).length));
  const messages = buildBatchMessages({ expert, glossary: hits, title: sample.title, segments: sample.segments });
  const parser = new SegmentStreamParser();
  const t0 = performance.now();
  let ttft = 0;
  let usage: Usage | undefined;
  const out = new Map<number, string>();
  for await (const delta of streamChat(p, messages, undefined, (u) => (usage = u))) {
    ttft ||= performance.now() - t0;
    for (const s of parser.push(delta)) out.set(s.id, s.text);
  }
  for (const s of parser.end()) out.set(s.id, s.text);
  return { out, ttft, total: performance.now() - t0, usage, raw: parser.rawText, sample, hits };
}

const scenes = Object.keys(SAMPLES).filter((s) => !sceneFilter || s === sceneFilter);

if (sweep) {
  // Claude Haiku 5.5 knobs: thinking off is allowed up to effort high; adaptive lets the model decide.
  const variants: Record<string, Record<string, unknown>> = {
    'off·low': { thinking: { type: 'disabled' }, output_config: { effort: 'low' } },
    'off·medium': { thinking: { type: 'disabled' }, output_config: { effort: 'medium' } },
    'adaptive·low': { thinking: { type: 'adaptive' }, output_config: { effort: 'low' } },
    'adaptive·medium': { thinking: { type: 'adaptive' }, output_config: { effort: 'medium' } },
  };
  const price = resolvedPrice(provider);
  const rows: string[] = [];
  for (const [name, extra] of Object.entries(variants)) {
    const p = { ...provider, extraBody: { ...provider.extraBody, ...extra } };
    let ttft = 0, total = 0, out = 0, cost = 0, ok = 0, segs = 0, read = 0, write = 0;
    console.log(`\n━━ ${name} ━━`);
    for (const scene of scenes) {
      const r = await translate(scene, scene, p);
      ttft += r.ttft;
      total += r.total;
      if (r.usage) {
        out += r.usage.completionTokens;
        read += r.usage.cacheHitTokens;
        write += r.usage.cacheWriteTokens ?? 0;
        cost += costOf(r.usage, price);
      }
      r.sample.segments.forEach((src, i) => {
        const t = r.out.get(i + 1);
        const v = t === undefined ? { ok: false } : validateTranslation(src, t, findHits(r.hits, src));
        segs++;
        if (v.ok) ok++;
        console.log(`  ${v.ok ? '✓' : '✗'} ${t ?? '(missing)'}`);
      });
    }
    const k = scenes.length;
    rows.push(`${name.padEnd(16)} ttft ${String(Math.round(ttft / k)).padStart(5)}ms  total ${String(Math.round(total / k)).padStart(5)}ms  out ${String(out).padStart(5)} tok  cache r/w ${read}/${write}  ${ok}/${segs} ok  $${cost.toFixed(5)}`);
  }
  // Cost depends on run order: a variant that changes the cached prefix (e.g. thinking on/off) pays cache writes.
  console.log('\n━━ summary: ttft/total = avg per scene; out, cache, cost = sum over scenes ━━\n' + rows.join('\n'));
  process.exit(0);
}

for (const scene of scenes) {
  const runs = compare ? ['general', scene] : [scene];
  console.log(`\n━━ ${scene} ━━`);
  for (const expertId of runs) {
    const r = await translate(expertId, scene);
    const u = r.usage;
    console.log(
      `  [${expertId}] ttft ${Math.round(r.ttft)}ms · total ${Math.round(r.total)}ms` +
        (u ? ` · in ${u.promptTokens} (cache ${u.cacheHitTokens}${u.cacheWriteTokens ? `, write ${u.cacheWriteTokens}` : ''}) · out ${u.completionTokens}` : ''),
    );
    r.sample.segments.forEach((src, i) => {
      const t = r.out.get(i + 1);
      const v = t === undefined ? { ok: false, reason: 'missing' } : validateTranslation(src, t, findHits(r.hits, src));
      console.log(`   ${v.ok ? '✓' : `✗ ${'reason' in v ? v.reason : ''}`}  ${src}\n      → ${t ?? '(missing)'}`);
    });
    if (r.out.size !== r.sample.segments.length) console.log('   raw reply:\n' + r.raw);
  }
}
