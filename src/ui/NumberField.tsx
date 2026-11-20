import { InputNumber } from "./semi";

interface Props {
  /** 无障碍名称，也是快捷定位该控件的唯一标识。 */
  label: string;
  value: number;
  onChange(value: number): void;
  /** 点一次步进按钮的变化量，按住 Shift 走 10 倍。 */
  step?: number;
  /** 保留小数位；0 表示只接受整数。 */
  precision?: number;
  min?: number;
  max?: number;
  disabled?: boolean;
}

/** toFixed 补出的尾零（12.0）不该出现在输入框里。 */
function trimZeros(text: string): string {
  return text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text;
}

/** 项目里所有数值调整的唯一入口：步进器、精度和范围只有这一处定义。 */
export function NumberField({
  label,
  value,
  onChange,
  step = 1,
  precision = 0,
  min,
  max,
  disabled,
}: Props) {
  return (
    <InputNumber
      aria-label={label}
      value={value}
      min={min}
      max={max}
      step={step}
      shiftStep={step * 10}
      precision={precision}
      formatter={(text) => trimZeros(String(text))}
      // 空输入和非法输入不回调，避免把 NaN 或 0 写进模板。
      onNumberChange={(next) => {
        if (Number.isFinite(next) && next !== value) onChange(next);
      }}
      disabled={disabled}
      style={{ width: "100%" }}
    />
  );
}
