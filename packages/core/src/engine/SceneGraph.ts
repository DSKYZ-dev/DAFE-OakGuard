import type { BaseBar, VolumeBin, BarGeometry } from '@dafe/types';

export interface SceneNode {
  id: string;
  type: 'bar' | 'volume' | 'indicator' | 'grid' | 'label';
  visible: boolean;
  data: unknown;
  children: SceneNode[];
}

export class SceneGraph {
  private root: SceneNode = { id: 'root', type: 'grid', visible: true, data: null, children: [] };
  private nodeMap: Map<string, SceneNode> = new Map();

  addNode(parentId: string, node: SceneNode): void {
    const parent = this.nodeMap.get(parentId) ?? this.root;
    parent.children.push(node);
    this.nodeMap.set(node.id, node);
  }

  removeNode(id: string): void {
    const node = this.nodeMap.get(id);
    if (!node) return;
    const parent = this.findParent(id);
    if (parent) {
      parent.children = parent.children.filter(c => c.id !== id);
    }
    this.nodeMap.delete(id);
  }

  private findParent(id: string, node: SceneNode = this.root): SceneNode | null {
    if (node.children.some(c => c.id === id)) return node;
    for (const child of node.children) {
      const found = this.findParent(id, child);
      if (found) return found;
    }
    return null;
  }

  getNode(id: string): SceneNode | undefined {
    return this.nodeMap.get(id);
  }

  traverse(fn: (node: SceneNode) => void): void {
    const walk = (node: SceneNode) => {
      fn(node);
      for (const child of node.children) {
        walk(child);
      }
    };
    walk(this.root);
  }

  clear(): void {
    this.root.children = [];
    this.nodeMap.clear();
  }
}
