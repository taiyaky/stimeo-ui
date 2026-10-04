/**
 * Makes a one-task replacement deliver its Stimulus callbacks in the order browsers do.
 *
 * Browsers report `replaceWith` and `replaceChild` as one childList record that removes
 * the old node and adds its replacements, and Stimulus processes a record's removals
 * before its additions, so the departing target's `<name>TargetDisconnected` runs before
 * the arriving target's `<name>TargetConnected`. A replacement that already has a parent
 * is first removed from it in a record of its own, in argument order, the old node
 * included where it is one of them. happy-dom reports the insertion before the removal,
 * which delivers the callbacks the other way round. Removing each replacement from its
 * parent, then the old node, then inserting the replacements where the old node was
 * yields the browsers' callback order and tree; the records still differ, one insertion
 * per node. A single replacement that is the parent or one of its ancestors goes to
 * happy-dom's own method, which throws before the tree changes, as browsers do. With
 * several replacements browsers can change the tree before throwing, which this does not
 * reproduce.
 */
const toNodes = (doc: Document, items: (Node | string)[]): Node[] =>
  items.map((item) => (typeof item === "string" ? doc.createTextNode(item) : item));

const elementProto = Element.prototype as Element & {
  replaceWith(...nodes: (Node | string)[]): void;
};
const nativeReplaceWith = elementProto.replaceWith;
elementProto.replaceWith = function replaceWith(this: Element, ...items: (Node | string)[]): void {
  const parent = this.parentNode;
  if (!parent) return;
  const nodes = toNodes(this.ownerDocument, items);
  if (nodes.some((node) => node.contains(parent))) {
    nativeReplaceWith.apply(this, items);
    return;
  }
  let anchor: Node | null = this.nextSibling;
  while (anchor && nodes.includes(anchor)) anchor = anchor.nextSibling;
  for (const node of nodes) node.parentNode?.removeChild(node);
  this.remove();
  for (const node of nodes) parent.insertBefore(node, anchor);
};

const nativeReplaceChild = Node.prototype.replaceChild;
Node.prototype.replaceChild = function replaceChild<T extends Node>(
  this: Node,
  node: Node,
  child: T,
): T {
  if (child.parentNode !== this || node.contains(this)) {
    return nativeReplaceChild.call(this, node, child) as T;
  }
  const anchor = child.nextSibling === node ? node.nextSibling : child.nextSibling;
  node.parentNode?.removeChild(node);
  child.parentNode?.removeChild(child);
  this.insertBefore(node, anchor);
  return child;
};
