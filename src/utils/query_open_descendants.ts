/** Queries physical descendants and nested open shadow trees, including `root`'s own. */
export function queryOpenDescendants<T extends Element = Element>(
  root: ParentNode,
  selector: string,
): T[] {
  const matches: T[] = [];
  const roots: ParentNode[] = [root];
  for (const scope of roots) {
    matches.push(...scope.querySelectorAll<T>(selector));
    if (scope.nodeType === Node.ELEMENT_NODE) {
      const shadow = (scope as Element).shadowRoot;
      if (shadow) roots.push(shadow);
    }
    for (const element of scope.querySelectorAll("*")) {
      if (element.shadowRoot) roots.push(element.shadowRoot);
    }
  }
  return matches;
}
