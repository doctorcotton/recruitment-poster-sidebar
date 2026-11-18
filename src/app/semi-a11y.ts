const closedSelect = '.semi-select[role="combobox"][aria-expanded="false"][aria-activedescendant]';
const emptyIcon = '.semi-icon[role="img"][aria-label=""]';
const selector = `${closedSelect}, ${emptyIcon}`;

function normalize(element: Element): void {
  if (element.matches(closedSelect)) element.removeAttribute("aria-activedescendant");
  if (element.matches(emptyIcon)) {
    element.removeAttribute("role");
    element.removeAttribute("aria-label");
    element.setAttribute("aria-hidden", "true");
  }
}

/** 仅处理新增子树和被修改的元素，拖拽和批量进度更新无需扫描整页。 */
export function observeSemiA11y(): () => void {
  document.querySelectorAll(selector).forEach(normalize);
  const observer = new MutationObserver((changes) => {
    for (const change of changes) {
      if (change.type === "attributes" && change.target instanceof Element)
        normalize(change.target);
      for (const node of change.addedNodes) {
        if (node instanceof Element) {
          normalize(node);
          node.querySelectorAll(selector).forEach(normalize);
        }
      }
    }
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["aria-expanded", "aria-activedescendant", "aria-label", "role"],
  });
  return () => observer.disconnect();
}
