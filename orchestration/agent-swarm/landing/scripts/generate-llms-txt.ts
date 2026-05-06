/**
 * Generates two kinds of markdown artefacts at build time:
 *
 *   1. The legacy llms.txt convention (see llmstxt.org):
 *      - public/llms.txt       — short summary
 *      - public/llms-full.txt  — long-form content
 *
 *   2. Per-route markdown for acceptmarkdown.com content negotiation:
 *      - public/md/index.md
 *      - public/md/pricing.md
 *      - public/md/blog.md
 *      - public/md/blog/<slug>.md  (one per blog post)
 *      - public/md/examples.md
 *      - public/md/examples/<slug>.md
 *
 * The middleware at src/middleware.ts rewrites canonical URLs to the
 * matching /md/<slug>.md file when the request prefers text/markdown.
 *
 * Usage: bun run landing/scripts/generate-llms-txt.ts
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const COMPONENTS_DIR = join(import.meta.dirname, "../src/components");
const APP_DIR = join(import.meta.dirname, "../src/app");
const PUBLIC_DIR = join(import.meta.dirname, "../public");
const MD_DIR = join(PUBLIC_DIR, "md");

const SITE_URL = "https://agent-swarm.dev";

function readSrc(path: string): string {
  return readFileSync(path, "utf-8");
}

function readComponent(name: string): string {
  return readSrc(join(COMPONENTS_DIR, `${name}.tsx`));
}

function readPage(route: string): string {
  return readSrc(join(APP_DIR, route, "page.tsx"));
}

function writeMd(relativePath: string, body: string): void {
  const out = join(MD_DIR, relativePath);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, body, "utf-8");
}

// ── Extract data from components ──────────────────────────────────────────

function extractFeatures(): Array<{ title: string; description: string; tag: string }> {
  // features.tsx: { num: "01", tag: "orchestration", title: "...", desc: "...", diagram: "..." }
  const src = readComponent("features");
  const features: Array<{ title: string; description: string; tag: string }> = [];

  const blockRe =
    /num:\s*"\d+",\s*tag:\s*"([^"]+)",\s*title:\s*"((?:[^"\\]|\\.)+)",\s*desc:\s*\n?\s*"((?:[^"\\]|\\.)+)"/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(src))) {
    features.push({
      tag: m[1],
      title: m[2].replace(/\\"/g, '"'),
      description: m[3].replace(/\\"/g, '"'),
    });
  }
  return features;
}

function extractHowItWorks(): Array<{ number: string; title: string; description: string; badge: string }> {
  // how-it-works.tsx: { n: "01", eyebrow: "install", title: "...", desc: "...", code/chips: ... }
  const src = readComponent("how-it-works");
  const steps: Array<{ number: string; title: string; description: string; badge: string }> = [];

  const blockRe =
    /n:\s*"(\d+)",\s*eyebrow:\s*"([^"]+)",\s*title:\s*"((?:[^"\\]|\\.)+)",\s*desc:\s*\n?\s*"((?:[^"\\]|\\.)+)"/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(src))) {
    steps.push({
      number: m[1],
      badge: m[2],
      title: m[3].replace(/\\"/g, '"'),
      description: m[4].replace(/\\"/g, '"'),
    });
  }
  return steps;
}

function extractPricing(): {
  platformPrice: number;
  workerPrice: number;
  tiers: Array<{ name: string; tagline: string; price: string; per: string; rider?: string; features: string[] }>;
  faqs: Array<{ question: string; answer: string }>;
} {
  // Tiers come from pricing-tiers.tsx — TIERS array.
  const tiersSrc = readComponent("pricing-tiers");
  const tiers: Array<{ name: string; tagline: string; price: string; per: string; rider?: string; features: string[] }> = [];

  const tiersArrMatch = tiersSrc.match(/const TIERS:\s*Tier\[\]\s*=\s*\[([\s\S]*?)\n\];/);
  if (tiersArrMatch) {
    const tierBlockRe =
      /\{\s*name:\s*"([^"]+)",\s*tagline:\s*"([^"]+)",\s*price:\s*"([^"]+)",\s*per:\s*"([^"]+)",(?:\s*rider:\s*"([^"]+)",)?\s*features:\s*\[([\s\S]*?)\],/g;
    let m: RegExpExecArray | null;
    while ((m = tierBlockRe.exec(tiersArrMatch[1]))) {
      const features = Array.from(m[6].matchAll(/"((?:[^"\\]|\\.)+)"/g)).map((mm) =>
        mm[1].replace(/\\"/g, '"'),
      );
      tiers.push({
        name: m[1],
        tagline: m[2],
        price: m[3],
        per: m[4],
        rider: m[5],
        features,
      });
    }
  }

  // Numeric prices for legacy llms.txt + JSON-LD-like payload.
  const platformTier = tiers.find((t) => /cloud/i.test(t.name));
  const platformPrice = platformTier ? Number.parseInt(platformTier.price.replace(/[^\d]/g, ""), 10) || 9 : 9;
  // Worker price comes from the rider on the Cloud tier ("plus €29 / mo per worker").
  const riderMatch = platformTier?.rider?.match(/(\d+)/);
  const workerPrice = riderMatch ? Number.parseInt(riderMatch[1], 10) : 29;

  // FAQs come from pricing-faq.tsx — FAQS array.
  const faqSrc = readComponent("pricing-faq");
  const faqs: Array<{ question: string; answer: string }> = [];
  const faqArrMatch = faqSrc.match(/const FAQS:\s*Faq\[\]\s*=\s*\[([\s\S]*?)\n\];/);
  if (faqArrMatch) {
    const faqRe = /question:\s*"((?:[^"\\]|\\.)+)",\s*answer:\s*\n?\s*"((?:[^"\\]|\\.)+)"/g;
    let fm: RegExpExecArray | null;
    while ((fm = faqRe.exec(faqArrMatch[1]))) {
      faqs.push({
        question: fm[1].replace(/\\"/g, '"'),
        answer: fm[2].replace(/\\"/g, '"'),
      });
    }
  }

  return { platformPrice, workerPrice, tiers, faqs };
}

interface BlogPost {
  slug: string;
  title: string;
  description: string;
  date: string;
  readTime: string;
  tags: string[];
}

function stitchString(raw: string): string {
  return raw
    .split(/"\s*\+\s*"/)
    .join("")
    .replace(/^"/, "")
    .replace(/"$/, "")
    .trim();
}

function extractBlogPosts(): BlogPost[] {
  const src = readPage("blog");
  const posts: BlogPost[] = [];
  const postRe = /\{\s*slug:\s*"([^"]+)",\s*title:\s*((?:"[^"]*"\s*\+?\s*)+),\s*description:\s*((?:"[^"]*"\s*\+?\s*)+),\s*date:\s*"([^"]+)",\s*readTime:\s*"([^"]+)",\s*tags:\s*\[([^\]]*)\][\s,]*\}/g;
  let m: RegExpExecArray | null;
  while ((m = postRe.exec(src))) {
    const tags = Array.from(m[6].matchAll(/"([^"]+)"/g)).map((mm) => mm[1]);
    posts.push({
      slug: m[1],
      title: stitchString(m[2]),
      description: stitchString(m[3]),
      date: m[4],
      readTime: m[5],
      tags,
    });
  }
  return posts;
}

interface ExampleEntry {
  slug: string;
  title: string;
  description: string;
  tags: string[];
}

function extractExamples(): ExampleEntry[] {
  const src = readPage("examples");
  const examples: ExampleEntry[] = [];
  const exRe = /\{\s*slug:\s*"([^"]+)",\s*title:\s*"([^"]+)",\s*description:\s*"((?:[^"\\]|\\.)*)",\s*tags:\s*\[([^\]]*)\]/g;
  let m: RegExpExecArray | null;
  while ((m = exRe.exec(src))) {
    const tags = Array.from(m[4].matchAll(/"([^"]+)"/g)).map((mm) => mm[1]);
    examples.push({
      slug: m[1],
      title: m[2],
      description: m[3].replace(/\\"/g, '"'),
      tags,
    });
  }
  return examples;
}

interface PageMetadata {
  title?: string;
  description?: string;
  keywords?: string[];
  publishedTime?: string;
}

function extractPageMetadata(route: string): PageMetadata {
  const src = readPage(route);
  const meta: PageMetadata = {};

  const grab = (key: string): string | undefined => {
    const re = new RegExp(`${key}:\\s*((?:"[^"]*"(?:\\s*\\+\\s*"[^"]*")*))`);
    const m = src.match(re);
    if (!m) return undefined;
    return stitchString(m[1]);
  };

  meta.title = grab("title");
  meta.description = grab("description");

  const kwMatch = src.match(/keywords:\s*\[([\s\S]*?)\]/);
  if (kwMatch) {
    meta.keywords = Array.from(kwMatch[1].matchAll(/"([^"]+)"/g)).map((m) => m[1]);
  }

  const ptMatch = src.match(/publishedTime:\s*"([^"]+)"/);
  if (ptMatch) meta.publishedTime = ptMatch[1];

  return meta;
}

// ── Generate markdown ─────────────────────────────────────────────────────

function generateLlmsTxt(features: ReturnType<typeof extractFeatures>, steps: ReturnType<typeof extractHowItWorks>): string {
  return `# Agent Swarm

> Intelligence that compounds. Every single day.

Open-source multi-agent orchestration for Claude Code, Codex, Devin, and other coding agents. A lead delegates. Workers ship in Docker. Memory persists across every task.

- [GitHub](https://github.com/desplega-ai/agent-swarm)
- [Documentation](https://docs.agent-swarm.dev)
- [Cloud](https://cloud.agent-swarm.dev)
- [Templates](https://templates.agent-swarm.dev)
- [Pricing](/pricing)
- [Blog](/blog)

## Features

${features.map((f) => `- **${f.title}** (${f.tag}): ${f.description}`).join("\n")}

## How It Works

${steps.map((s) => `${s.number}. **${s.title}** — ${s.description}`).join("\n")}

## Links

- Website: ${SITE_URL}
- GitHub: https://github.com/desplega-ai/agent-swarm
- Docs: https://docs.agent-swarm.dev
- Cloud: https://cloud.agent-swarm.dev
- Templates: https://templates.agent-swarm.dev
- Built by: https://desplega.sh
`;
}

function generateLlmsFullTxt(
  features: ReturnType<typeof extractFeatures>,
  steps: ReturnType<typeof extractHowItWorks>,
  pricing: ReturnType<typeof extractPricing>,
): string {
  const { tiers, faqs } = pricing;
  return `# Agent Swarm

> Intelligence that compounds. Every single day.

Open Source · MCP-Powered · TypeScript · Multi-model (Claude Code, Codex, Devin, OpenCode, BYOM)

A lead delegates. Workers ship in Docker. Memory persists across every task — so tomorrow's swarm is sharper than today's. Self-host free under MIT, or run on Cloud.

- [GitHub](https://github.com/desplega-ai/agent-swarm)
- [Documentation](https://docs.agent-swarm.dev)
- [Cloud](https://cloud.agent-swarm.dev)
- [Templates](https://templates.agent-swarm.dev)
- [Pricing](/pricing)
- [Blog](/blog)

## Features

The mechanics behind the swarm.

${features.map((f) => `### ${f.title}\n\n*${f.tag}*\n\n${f.description}`).join("\n\n")}

## How It Works

From zero to compounding in an afternoon. No DAGs, no definition language — just \`docker compose up\`, then talk to it where you already work.

${steps.map((s) => `### ${s.number}. ${s.title}\n\n${s.description}\n\n*${s.badge}*`).join("\n\n")}

## Pricing

Pay for the workers, not the seats.

${tiers
  .map(
    (t) =>
      `### ${t.name} — ${t.price} ${t.per}\n\n*${t.tagline}*${t.rider ? `\n\n_+ ${t.rider}_` : ""}\n\n${t.features.map((f) => `- ${f}`).join("\n")}`,
  )
  .join("\n\n")}

All Cloud plans include a 7-day free trial. Self-hosted is [free and MIT-licensed](https://docs.agent-swarm.dev/docs/getting-started).

## FAQ

${faqs.map((f) => `**${f.question}**\n\n${f.answer}`).join("\n\n")}

## Get Started

Start your 7-day free trial on [Agent Swarm Cloud](https://cloud.agent-swarm.dev), or [self-host](https://docs.agent-swarm.dev/docs/getting-started) the open-source version for free.

## Links

- Website: ${SITE_URL}
- GitHub: https://github.com/desplega-ai/agent-swarm
- Docs: https://docs.agent-swarm.dev
- Cloud: https://cloud.agent-swarm.dev
- Templates: https://templates.agent-swarm.dev
- Built by [desplega.sh](https://desplega.sh)
- MIT License
`;
}

function generatePricingMd(pricing: ReturnType<typeof extractPricing>): string {
  const { tiers, faqs } = pricing;
  return `# Pricing — Agent Swarm Cloud

> Pay for the workers, not the seats. €9/mo platform + €29/mo per worker. 7-day free trial. Self-host free under MIT.

Canonical URL: ${SITE_URL}/pricing

${tiers
  .map(
    (t) =>
      `## ${t.name} — ${t.price} ${t.per}\n\n*${t.tagline}*${t.rider ? `\n\n_+ ${t.rider}_` : ""}\n\n${t.features.map((f) => `- ${f}`).join("\n")}`,
  )
  .join("\n\n")}

All Cloud plans include a 7-day free trial. Self-hosted is [free and MIT-licensed](https://docs.agent-swarm.dev/docs/getting-started).

## FAQ

${faqs.map((f) => `**${f.question}**\n\n${f.answer}`).join("\n\n")}
`;
}

function generateBlogIndexMd(posts: BlogPost[]): string {
  return `# Blog — Agent Swarm

> Notes from inside the swarm. Technical deep dives, post-mortems, and architecture notes.

Canonical URL: ${SITE_URL}/blog

${posts
  .map(
    (p) =>
      `## [${p.title}](${SITE_URL}/blog/${p.slug})\n\n*${p.date} · ${p.readTime}*\n\n${p.description}\n\nTags: ${p.tags.map((t) => `\`${t}\``).join(", ")}\n`,
  )
  .join("\n")}
`;
}

function generateBlogPostMd(post: BlogPost, meta: PageMetadata): string {
  const canonical = `${SITE_URL}/blog/${post.slug}`;
  const titleLine = meta.title ?? post.title;
  const descriptionLine = meta.description ?? post.description;
  const keywordsLine = meta.keywords?.length
    ? `\nKeywords: ${meta.keywords.map((k) => `\`${k}\``).join(", ")}\n`
    : "";
  const publishedLine = meta.publishedTime ? `Published: ${meta.publishedTime}\n` : "";
  return `# ${titleLine}

> ${descriptionLine}

${publishedLine}Read time: ${post.readTime}
Tags: ${post.tags.map((t) => `\`${t}\``).join(", ")}
${keywordsLine}
Canonical URL: ${canonical}

---

This post is rendered as React components on the canonical URL. For the full
content with code blocks, diagrams, and inline links, fetch the HTML at
[${canonical}](${canonical}) (send \`Accept: text/html\`).

A short summary, plus the listed metadata above, is provided here so AI agents
performing content negotiation can index the article without parsing the React
tree.
`;
}

function generateExamplesIndexMd(examples: ExampleEntry[]): string {
  return `# Examples — Real Agent Swarm Sessions

> Real session transcripts showing autonomous AI agent coordination in action.

Canonical URL: ${SITE_URL}/examples

${examples
  .map(
    (e) =>
      `## [${e.title}](${SITE_URL}/examples/${e.slug})\n\n${e.description}\n\nTags: ${e.tags.map((t) => `\`${t}\``).join(", ")}\n`,
  )
  .join("\n")}
`;
}

function generateExampleMd(example: ExampleEntry, meta: PageMetadata): string {
  const canonical = `${SITE_URL}/examples/${example.slug}`;
  const titleLine = meta.title ?? example.title;
  const descriptionLine = meta.description ?? example.description;
  const keywordsLine = meta.keywords?.length
    ? `\nKeywords: ${meta.keywords.map((k) => `\`${k}\``).join(", ")}\n`
    : "";
  return `# ${titleLine}

> ${descriptionLine}

Tags: ${example.tags.map((t) => `\`${t}\``).join(", ")}
${keywordsLine}
Canonical URL: ${canonical}

---

This example is rendered as React components on the canonical URL. For the full
walkthrough with screenshots and embedded media, fetch the HTML at
[${canonical}](${canonical}) (send \`Accept: text/html\`).
`;
}

// ── Main ──────────────────────────────────────────────────────────────────

const features = extractFeatures();
if (features.length === 0) throw new Error("extractFeatures() returned nothing — check features.tsx structure");

const steps = extractHowItWorks();
if (steps.length === 0) throw new Error("extractHowItWorks() returned nothing — check how-it-works.tsx structure");

const pricing = extractPricing();
if (pricing.tiers.length === 0) throw new Error("extractPricing() returned no tiers — check pricing-tiers.tsx structure");
if (pricing.faqs.length === 0) throw new Error("extractPricing() returned no FAQs — check pricing-faq.tsx structure");

const blogPosts = extractBlogPosts();
if (blogPosts.length === 0) throw new Error("extractBlogPosts() returned nothing — check blog/page.tsx structure");

const examples = extractExamples();
if (examples.length === 0) throw new Error("extractExamples() returned nothing — check examples/page.tsx structure");

const llmsTxt = generateLlmsTxt(features, steps);
const llmsFullTxt = generateLlmsFullTxt(features, steps, pricing);

writeFileSync(join(PUBLIC_DIR, "llms.txt"), llmsTxt, "utf-8");
writeFileSync(join(PUBLIC_DIR, "llms-full.txt"), llmsFullTxt, "utf-8");
console.log(`✓ Generated llms.txt (${llmsTxt.length} bytes)`);
console.log(`✓ Generated llms-full.txt (${llmsFullTxt.length} bytes)`);

// Per-route markdown for acceptmarkdown.com content negotiation
mkdirSync(MD_DIR, { recursive: true });

writeMd("index.md", llmsFullTxt);
console.log(`✓ Generated md/index.md`);

writeMd("pricing.md", generatePricingMd(pricing));
console.log(`✓ Generated md/pricing.md`);

writeMd("blog.md", generateBlogIndexMd(blogPosts));
console.log(`✓ Generated md/blog.md`);

for (const post of blogPosts) {
  const meta = extractPageMetadata(`blog/${post.slug}`);
  writeMd(`blog/${post.slug}.md`, generateBlogPostMd(post, meta));
}
console.log(`✓ Generated md/blog/<slug>.md (${blogPosts.length} posts)`);

writeMd("examples.md", generateExamplesIndexMd(examples));
console.log(`✓ Generated md/examples.md`);

for (const example of examples) {
  const meta = extractPageMetadata(`examples/${example.slug}`);
  writeMd(`examples/${example.slug}.md`, generateExampleMd(example, meta));
}
console.log(`✓ Generated md/examples/<slug>.md (${examples.length} examples)`);
