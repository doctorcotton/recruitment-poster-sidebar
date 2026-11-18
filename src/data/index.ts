import type { PosterRepository } from "../domain/types";
import { FeishuPosterRepository } from "./feishu-repository";
import { LocalPosterRepository } from "./local-repository";

export { createPosterAsset } from "./assets";
export { LocalPosterRepository } from "./local-repository";
export { FeishuPosterRepository } from "./feishu-repository";
export { PosterError, PlatformPosterError } from "./errors";
export type { FeishuSdkFacade, FeishuRepositoryOptions } from "./feishu-repository";

/** 同步选择仓储；构造飞书仓储不会加载 SDK，更不会失败后偷偷回到示例数据。 */
export function createRepository(): PosterRepository {
  const inBrowser = typeof window !== "undefined";
  const explicitFeishu =
    inBrowser && new URLSearchParams(window.location.search).get("mode") === "feishu";
  const embedded = inBrowser && window !== window.parent;
  return explicitFeishu || embedded ? new FeishuPosterRepository() : new LocalPosterRepository();
}
