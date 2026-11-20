import { extractAppearanceSection } from '../characterPersona.js';

// 「## 你的外观」可编辑正文：去掉标题行与后续其他章节；没有正文时返回 ''。
export function editableAppearanceBody(basePrompt) {
  const section = extractAppearanceSection(basePrompt);
  const nl = section.indexOf('\n');
  if (nl < 0) return '';
  const rest = section.slice(nl + 1);
  const next = rest.search(/(?:^|\n)##\s/);
  return (next < 0 ? rest : rest.slice(0, next)).trim();
}
