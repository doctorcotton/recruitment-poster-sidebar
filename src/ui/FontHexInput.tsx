import { useEffect, useState } from "react";
import { Input } from "./semi";

export function FontHexInput({
  value,
  disabled,
  onChange,
}: {
  value: string;
  disabled: boolean;
  onChange(value: string): void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  // 允许逐字输入中间态，完整 HEX 才提交；离开时恢复无效输入。
  return (
    <Input
      aria-label="字体颜色 HEX"
      value={draft}
      disabled={disabled}
      onChange={(text) => {
        setDraft(text);
        if (/^#[0-9a-f]{6}$/i.test(text)) onChange(text);
      }}
      onBlur={() => {
        if (!/^#[0-9a-f]{6}$/i.test(draft)) setDraft(value);
      }}
    />
  );
}
