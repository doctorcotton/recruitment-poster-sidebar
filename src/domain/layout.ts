import type { TextBox } from "./types";

export interface TextLayout {
  lines: string[];
  fontSize: number;
  lineHeight: number;
  overflow: boolean;
}

export type MeasureText = (text: string, fontSize: number) => number;

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** 按字素切分，组合字符、肤色修饰和 ZWJ emoji 都保留为一个绘制单元。 */
export function splitGraphemes(text: string): string[] {
  return Array.from(graphemeSegmenter.segment(text), (part) => part.segment);
}

function splitParagraphs(text: string): string[][] {
  return text.replace(/\r\n?/g, "\n").split("\n").map(splitGraphemes);
}

function wrapParagraphs(
  paragraphs: string[][],
  width: number,
  fontSize: number,
  measure: MeasureText,
): string[] {
  const lines: string[] = [];
  for (const paragraph of paragraphs) {
    let line = "";
    for (const grapheme of paragraph) {
      const next = line + grapheme;
      if (line && measure(next, fontSize) > width) {
        lines.push(line);
        line = grapheme;
      } else {
        line = next;
      }
    }
    lines.push(line);
  }
  return lines;
}

/** 换行保留显式空行；超过整行宽度的单个字素交由溢出判定处理。 */
export function wrapText(
  text: string,
  width: number,
  fontSize: number,
  measure: MeasureText,
): string[] {
  return wrapParagraphs(splitParagraphs(text), width, fontSize, measure);
}

/** 预览和导出共享同一排版结果；最小字号仍放不下时保留溢出状态。 */
export function layoutText(text: string, box: TextBox, measure: MeasureText): TextLayout {
  // 同一次排版的候选字号共用字素切分结果，结束后释放分词数据。
  const paragraphs = text === "" ? [] : splitParagraphs(text);
  const atSize = (fontSize: number): TextLayout => {
    const lines = wrapParagraphs(paragraphs, box.width, fontSize, measure);
    const lineHeight = fontSize * box.lineHeight;
    return {
      lines,
      fontSize,
      lineHeight,
      overflow:
        lines.length > box.maxLines ||
        lines.length * lineHeight > box.height + 1e-7 ||
        lines.some((line) => measure(line, fontSize) > box.width + 1e-7),
    };
  };
  const full = atSize(box.fontSize);
  if (!full.overflow || box.fontSize === box.minFontSize) return full;
  let best = atSize(box.minFontSize);
  if (best.overflow) return best;
  // 搜索以 0.01px 为单位的最大可用字号，避免长文本逐像素重复排版。
  let low = 1;
  let high = Math.floor((box.fontSize - box.minFontSize) * 100);
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidateSize = box.minFontSize + middle / 100;
    const candidate = candidateSize === box.fontSize ? full : atSize(candidateSize);
    if (candidate.overflow) high = middle - 1;
    else {
      best = candidate;
      low = middle + 1;
    }
  }
  return best;
}
