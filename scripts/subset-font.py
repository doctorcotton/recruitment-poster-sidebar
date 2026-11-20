"""生成内置字体的常用字子集（首屏先出图，完整字体随后替换）。

依赖：pip install fonttools brotli
用法：python3 scripts/subset-font.py public/fonts/NotoSansSC-Bold.woff2 public/fonts/NotoSansSC-Bold-common.woff2

子集 = ASCII + Latin-1 + 常用标点 + 全角符号 + GB2312 全部汉字。
子集缺字不会显示空白方块：画布字体串带 sans-serif 兜底，缺字由系统字体渲染，
完整字体到货后自动重绘一次，最终效果与全字符集一致。
"""

import sys

from fontTools import subset


def gb2312_characters() -> list[str]:
    """GB2312 一二级汉字（6763 字），按区位码逐码位解码。"""
    characters: list[str] = []
    for high in range(0xA1, 0xF8):
        for low in range(0xA1, 0xFF):
            try:
                character = bytes([high, low]).decode("gb2312")
            except UnicodeDecodeError:
                continue
            if "\u4e00" <= character <= "\u9fff":
                characters.append(character)
    return characters


def character_set() -> str:
    ranges = [
        (0x0020, 0x007E),  # ASCII 可见字符
        (0x00A0, 0x00FF),  # Latin-1
        (0x2000, 0x206F),  # 通用标点（破折号、省略号、引号）
        (0x2100, 0x21FF),  # 箭头与字母式符号
        (0x2460, 0x24FF),  # 带圈数字
        (0x2500, 0x257F),  # 制表符
        (0x25A0, 0x25FF),  # 几何图形
        (0x2600, 0x26FF),  # 杂项符号
        (0x3000, 0x303F),  # 中文标点
        (0xFE30, 0xFE4F),  # 兼容形式（竖排标点）
        (0xFF00, 0xFFEF),  # 全角/半角形式
    ]
    characters = {chr(code) for start, end in ranges for code in range(start, end + 1)}
    characters.update(gb2312_characters())
    return "".join(sorted(characters))


def main(source: str, target: str) -> None:
    options = subset.Options()
    options.flavor = "woff2"
    options.layout_features = ["*"]
    options.name_IDs = ["*"]
    options.notdef_outline = True
    font = subset.load_font(source, options)
    subsetter = subset.Subsetter(options=options)
    subsetter.populate(text=character_set())
    subsetter.subset(font)
    subset.save_font(font, target, options)
    print(f"{target}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("用法：subset-font.py <全字符集 woff2> <子集 woff2>")
    main(sys.argv[1], sys.argv[2])
