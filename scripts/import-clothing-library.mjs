import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));

export function clothingEntryKind(tag, subcategories = []) {
  if (subcategories.some(value => value.includes('动作')) || /^(?:grabbing|holding|adjusting|putting_on|taking_off|pulling_off|removing|unworn)_|_(?:lift|pull|hold|dangle|partially_removed)$/.test(tag)) return 'scene';
  return 'outfit';
}

// 九份文档的表头不同；只提取服装字段，不引入示例人物的身份或外观。
export function parseClothingMarkdown(markdown, category) {
  return markdown.split(/^## /m).slice(1).map(block => {
    const fields = new Map();
    for (const line of block.split('\n')) {
      const match = line.match(/^\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|/);
      if (match) fields.set(match[1].trim().toLowerCase(), match[2].trim());
    }
    const get = (...keys) => keys.map(key => fields.get(key)).find(Boolean) || '';
    const tag = get('tag', 'danbooru tag');
    const label = get('tag中文名', '中文名', '中文释义', '中文含义');
    const description = get('tag中文含义', '详细释义', '详细解释', '中文介绍') || label;
    const subcategory = get('tag所属的子类', '所属子类', '子类', '分类');
    if (!tag || !label || !/^[a-z0-9_()'\-]+$/.test(tag)) throw new Error(`${category} 存在无效条目：${block.slice(0, 100)}`);
    return { tag, label, description, category, subcategory };
  });
}

export async function importClothingLibrary(source) {
  const entries = new Map();
  const categories = [];
  for (const dir of (await readdir(source, { withFileTypes: true })).filter(dir => dir.isDirectory()).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))) {
    const directory = path.join(source, dir.name);
    const documents = (await readdir(directory)).filter(name => name.endsWith('.md'));
    if (documents.length !== 1) throw new Error(`${dir.name} 应有且只有一份 Markdown 语料`);
    const rows = parseClothingMarkdown(await readFile(path.join(directory, documents[0]), 'utf8'), dir.name);
    categories.push({ value: dir.name, label: dir.name, count: new Set(rows.map(row => row.tag)).size });
    for (const row of rows) {
      const existing = entries.get(row.tag);
      if (existing) {
        if (!existing.categories.includes(row.category)) existing.categories.push(row.category);
        if (row.subcategory && !existing.subcategories.includes(row.subcategory)) existing.subcategories.push(row.subcategory);
        continue;
      }
      entries.set(row.tag, { tag: row.tag, label: row.label, description: row.description, categories: [row.category], subcategories: row.subcategory ? [row.subcategory] : [] });
    }
  }
  const catalog = { version: 1, source: '文生图创作 / 0-语料 / 服装', categories, entries: [...entries.values()].map(entry => ({ ...entry, kind: clothingEntryKind(entry.tag, entry.subcategories) })) };
  const resourceDir = path.join(root, 'agent-core/resources');
  await mkdir(resourceDir, { recursive: true });
  await writeFile(path.join(resourceDir, 'clothing-library.json'), JSON.stringify(catalog, null, 2) + '\n');
  console.log(JSON.stringify({ tags: entries.size, categories }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('用法：node scripts/import-clothing-library.mjs <服装语料目录>');
  await importClothingLibrary(path.resolve(process.argv[2]));
}
