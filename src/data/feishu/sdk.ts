import type {
  IAttachmentField,
  IBase,
  IFieldMeta,
  IOpenAttachment,
  IRecord,
  IRecordValue,
  ITable,
  ITableMeta,
} from "@lark-base-open/js-sdk";

export type SdkFieldMeta = Pick<IFieldMeta, "id" | "name" | "type"> & { property?: unknown };
export type SdkRecord = IRecord;
export type SdkAttachment = IOpenAttachment;
export type SdkAttachmentField = Pick<IAttachmentField, "getValue" | "setValue">;
export type SdkRecordInput = IRecordValue;
export type SdkTable = Pick<
  ITable,
  | "id"
  | "getName"
  | "getRecordsByPage"
  | "getRecordById"
  | "getFieldById"
  | "getCellAttachmentUrls"
  | "addRecord"
  | "setRecord"
  | "deleteRecord"
  | "addField"
> & {
  getFieldMetaList(): Promise<SdkFieldMeta[]>;
};

/** 将 SDK 边界限制在本应用所需能力，测试无需加载真实宿主。 */
export interface FeishuSdkFacade {
  bridge?: Pick<(typeof import("@lark-base-open/js-sdk").bitable)["bridge"], "getData" | "setData">;
  base: Pick<IBase, "getSelection" | "addTable" | "batchUploadFile"> & {
    getTableById(id: string): Promise<SdkTable>;
    getTableMetaList(): Promise<Pick<ITableMeta, "id" | "name">[]>;
  };
}
