// DocCリリースノートをサーバー側で展開→要約JSONを吐き出す
import { DateTime } from 'luxon';
import { XMLParser } from 'fast-xml-parser';
import fetch from 'node-fetch';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const RSS = 'https://developer.apple.com/news/releases/rss/releases.rss';
const OUTDIR = 'docs/apple-releases';
const TARGET = /(iOS|iPadOS|macOS|Xcode)/; // 対象のみ
const MAX_ITEMS = 8; // 直近

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ensure = async (p) => fs.mkdir(p, { recursive: true });
const slugify = (s) => s
  .replace(/\s+/g, '-')
  .replace(/[^\w.-]/g, '')
  .toLowerCase();

const toJSTDate = (rfc822) =>
  DateTime.fromHTTP(rfc822, { zone: 'UTC' }).setZone('Asia/Tokyo').toFormat('yyyy-LL-dd');

const pickPlatform = (title) => {
  if (/^iOS\b/i.test(title)) return 'iOS';
  if (/^iPadOS\b/i.test(title)) return 'iPadOS';
  if (/^macOS\b/i.test(title)) return 'macOS';
  if (/^Xcode\b/i.test(title)) return 'Xcode';
  return 'Other';
};

const parseTitle = (t) => {
  // 例: "iOS 26.1 beta 4 (23B5073a)"
  const m = t.match(/^([^\s]+)\s+(.+?)\s+\(([^)]+)\)/);
  if (!m) return { version: '', build: '' };
  return { version: m[2], build: m[3] };
};

const extractSectionsFromText = (raw) => {
  // DocC本文の素朴な見出し分割（フォールバック用）
  const norm = raw.replace(/\r/g, '');
  const grab = (name) => {
    const re = new RegExp(`\\n${name}\\n([\\s\\S]*?)(\\n[A-Z][A-Za-z ]+\\n|$)`, 'i');
    const m = norm.match(re);
    return m ? m[1]
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean)
      .filter(s => s.length < 500) // ノイズ抑制
      : [];
  };
  return {
    sdkBuild: (norm.match(/SDK.*?\(([^)]+)\)/i) || [,''])[1] || '',
    newFeatures: grab('New Features'),
    changes: grab('Changes'),
    resolvedIssues: grab('Resolved Issues'),
    knownIssues: grab('Known Issues'),
    workarounds: grab('Workarounds'),
    deprecations: grab('Deprecations'),
    apiChanges: grab('API Changes'),
    requirements: grab('Requirements'),
    devImpact: [] // 後段（GPT側）でまとめてもらう前提
  };
};

const extractFromDocCJSON = (jsonText) => {
  // DocCの内部JSONからテキストを抽出（汎用・簡易）
  // 各ページで構造が違うため、見出しタイトル＋リスト項目を総当りでかき集める
  try {
    const j = JSON.parse(jsonText);
    const texts = [];

    const pushStr = (s) => { if (typeof s === 'string') texts.push(s); };
    const walk = (o) => {
      if (!o || typeof o !== 'object') return;
      for (const k of Object.keys(o)) {
        const v = o[k];
        if (typeof v === 'string') pushStr(v);
        else if (Array.isArray(v)) v.forEach(walk);
        else walk(v);
      }
    };
    walk(j);

    const raw = texts.join('\n');
    return extractSectionsFromText('\n' + raw + '\n');
  } catch {
    return null;
  }
};

(async () => {
  await ensure(OUTDIR);

  // RSS取得→対象抽出
  const rssText = await (await fetch(RSS)).text();
  const parser = new XMLParser({ ignoreAttributes: false });
  const rss = parser.parse(rssText);
  const items = (rss?.rss?.channel?.item || [])
    .filter(it => TARGET.test(it.title))
    .slice(0, MAX_ITEMS);

  const browser = await chromium.launch({ args: ['--disable-dev-shm-usage'] });
  const page = await browser.newPage();

  const outItems = [];

  for (const it of items) {
    const title = it.title;
    const link = it.link;
    const pub = toJSTDate(it.pubDate);
    const { version, build } = parseTitle(title);
    const platform = pickPlatform(title);
    const slug = slugify(title);

    // Releases個別ページ → 「View release notes」リンク解決
    await page.goto(link, { waitUntil: 'domcontentloaded' });
    const selector = 'a:has-text("View release notes")';
    const relEl = page.locator(selector).first();
    const hasRel = await relEl.count();
    if (!hasRel) continue;
    const href = await relEl.getAttribute('href');
    const notesUrl = new URL(href, link).toString();

    // DocCページ：ネットワークで内部JSONを収集
    const doccJSON = [];
    page.on('response', async (resp) => {
      try {
        const url = resp.url();
        if (url.includes('/data/documentation/') && url.endsWith('.json')) {
          const txt = await resp.text();
          if (txt && txt.length > 5000) { // 情報量の多いものを優先保存
            doccJSON.push({ url, txt, size: txt.length });
          }
        }
      } catch {}
    });

    await page.goto(notesUrl, { waitUntil: 'networkidle' });
    await sleep(300); // 取りこぼし防止

    // 本文テキスト（フォールバック）
    const rawText = await page.evaluate(() =>
      (document.querySelector('main')?.innerText || document.body.innerText || '')
    );

    // セクション抽出（内部JSONがあれば優先）
    let sections = null;
    if (doccJSON.length) {
      doccJSON.sort((a,b) => b.size - a.size);
      sections = extractFromDocCJSON(doccJSON[0].txt);
    }
    if (!sections) sections = extractSectionsFromText('\n' + rawText + '\n');

    // 個別ノートJSONを書き出し
    const notePath = path.join(OUTDIR, `${slug}.json`);
    await fs.writeFile(notePath, JSON.stringify({
      sourceUrl: notesUrl,
      sections
    }, null, 2));

    outItems.push({
      platform,
      title,
      version,
      build,
      releaseDateJST: pub,
      releasesUrl: link,
      notesUrl: `${'./'}${slug}.json`,
      slug
    });

    // イベントハンドラの重複防止
    page.removeAllListeners('response');
  }

  // latest.json を書き出し（notesUrlは相対→後段の公開URLに依存せず動く）
  const latest = {
    generatedAt: DateTime.now().setZone('Asia/Tokyo').toISO(),
    items: outItems
      .filter(it => it.platform !== 'Other')
      .filter(it => /(iOS|iPadOS|macOS|Xcode)/.test(it.platform))
  };
  await fs.writeFile(path.join(OUTDIR, 'latest.json'), JSON.stringify(latest, null, 2));

  await browser.close();
})();

