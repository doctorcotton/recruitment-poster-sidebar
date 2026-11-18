import { PosterError } from "../domain/types";

/** 同一条数据在同毫秒内继续写入时，修订号仍然递增。 */
export function nextRevision(previous?: number): number {
  return Math.max(Date.now(), (previous ?? 0) + 1);
}

/** 乐观版本检查；undefined 仅兼容旧调用方，业务界面应始终传 number 或 null。 */
export function assertRevisionUnchanged(
  expected: number | null | undefined,
  actual: number | undefined,
  label: string,
): void {
  if (expected === undefined) return;
  const matches =
    expected === null
      ? actual === undefined
      : expected === 0
        ? actual === undefined || actual === 0
        : actual === expected;
  if (!matches)
    throw new PosterError(
      "REVISION_CONFLICT",
      `${label}已被其他窗口或设备修改，请重新读取后再保存，或另存副本。`,
    );
}
