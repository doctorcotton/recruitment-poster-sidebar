import { Button, Modal } from "../../ui/semi";

interface Props {
  title: string | null;
  busy: string | null;
  error: string | null;
  onCancel(): void;
  onDiscard(): void;
  onSave(): void;
}

export function UnsavedNavigationModal({ title, busy, error, onCancel, onDiscard, onSave }: Props) {
  return (
    <Modal
      title={title ? `${title}：未保存修改` : "未保存修改"}
      visible={Boolean(title)}
      onCancel={onCancel}
      footer={
        <div className="navigation-actions">
          <Button onClick={onCancel}>取消</Button>
          <Button type="danger" onClick={onDiscard}>
            不保存并继续
          </Button>
          <Button
            theme="solid"
            type="primary"
            loading={busy === "save"}
            disabled={Boolean(busy && busy !== "save")}
            onClick={onSave}
          >
            保存并继续
          </Button>
        </div>
      }
    >
      <p>
        当前模板或输出设置尚未保存。可选择保存后继续，或不写入当前修改并继续；目标没有已保存模板时，当前版式会保留为新草稿。
      </p>
      {error && (
        <p role="alert" className="setup-error">
          {error}
        </p>
      )}
    </Modal>
  );
}
