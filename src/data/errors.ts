import { PosterError } from "../domain/types";

export { PosterError } from "../domain/types";

/** 保留平台错误码供日志和界面诊断，不把 SDK 失败伪装成成功。 */
export class PlatformPosterError extends PosterError {
  constructor(
    code: "PERMISSION_DENIED" | "PLATFORM_ERROR",
    message: string,
    public readonly platformCode?: string,
    public readonly retryable = false,
    public readonly cause?: unknown,
  ) {
    super(code, message);
  }
}

const PERMISSION_CODES = new Set([
  "403",
  "91403",
  "99991672",
  "99991679",
  "1254302",
  "10212003",
  "10212997",
  "10213997",
  "10214997",
  "10215997",
  "10216997",
  "10217997",
  "PERMISSION_DENIED",
  "FORBIDDEN",
]);
const RATE_CODES = new Set([
  "429",
  "99991400",
  "1254290",
  "1254291",
  "RATE_LIMIT",
  "RATE_LIMITED",
  "TOO_MANY_REQUESTS",
]);

export function platformError(error: unknown, action: string): PosterError {
  if (error instanceof PosterError) return error;
  const detail = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  const rawCode = detail.code ?? detail.errorCode ?? detail.status;
  const code = rawCode === undefined ? undefined : String(rawCode);
  const name = typeof detail.name === "string" ? detail.name : "";
  const message =
    typeof detail.message === "string"
      ? detail.message
      : typeof detail.msg === "string"
        ? detail.msg
        : "";
  const suffix = code ? `（平台错误码 ${code}）` : "";
  if ((code && PERMISSION_CODES.has(code)) || /PermissionDenied|NoFAPermission/.test(name)) {
    return new PlatformPosterError(
      "PERMISSION_DENIED",
      `${action}：没有所需的多维表权限${suffix}。`,
      code,
      false,
      error,
    );
  }
  if (
    (code && RATE_CODES.has(code)) ||
    /rate.?limit|too many requests/i.test(`${name} ${message}`)
  ) {
    return new PlatformPosterError(
      "PLATFORM_ERROR",
      `${action}：请求频率受限，请稍后重试${suffix}。`,
      code,
      true,
      error,
    );
  }
  return new PlatformPosterError(
    "PLATFORM_ERROR",
    `${action}失败${suffix}${message ? `：${message}` : "。"}`,
    code,
    false,
    error,
  );
}
