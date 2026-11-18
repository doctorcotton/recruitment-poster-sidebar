import type { PosterTemplate, TextBox } from "./types";

const box = (
  id: string,
  label: string,
  x: number,
  y: number,
  width: number,
  height: number,
  fontSize: number,
  maxLines = 1,
  color = "#16191c",
): TextBox => ({
  id,
  label,
  fieldId: id,
  text: "",
  x,
  y,
  width,
  height,
  fontId: "noto-bold",
  fontSize,
  minFontSize: 16,
  color,
  align: "left",
  lineHeight: 1.25,
  maxLines,
});

export const DEFAULT_TEMPLATE: PosterTemplate = {
  schemaVersion: 1,
  id: "recruitment-default",
  name: "元气招聘",
  width: 882,
  height: 1783,
  backgroundId: "clean-background",
  fontIds: ["noto-bold"],
  boxes: [
    box("job", "岗位", 294, 489, 530, 60, 44),
    box("location", "地点", 294, 588, 530, 62, 36),
    box("responsibilities", "职责", 74, 782, 744, 190, 32, 4),
    box("benefits", "待遇", 375, 1019, 455, 73, 31, 2),
    box("contact", "联系人", 651, 1366, 196, 38, 24, 1, "#ffffff"),
    box("phone", "电话 / 微信", 664, 1420, 186, 38, 21, 1, "#ffffff"),
  ],
};
