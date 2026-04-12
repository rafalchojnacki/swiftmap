import * as vscode from 'vscode';

type Flag = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

interface MindMapNode {
  name: string;
  collapsed: boolean;
  flags: Flag[];
  children: MindMapNode[];
}

interface ParsedDocument {
  root: MindMapNode;
}

interface SerializedNode {
  path: string;
  name: string;
  collapsed: boolean;
  flags: Flag[];
  children: SerializedNode[];
}

interface DocumentStateMessage {
  type: 'document';
  tree: SerializedNode;
}

interface ErrorMessage {
  type: 'error';
  message: string;
}

type WebviewMessage =
  | { type: 'ready' }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'copyNodeText'; path: string }
  | { type: 'pasteNodeText'; path: string }
  | { type: 'setName'; path: string; name: string }
  | { type: 'addChild'; path: string }
  | { type: 'addSibling'; path: string; position: 'before' | 'after' }
  | { type: 'reparentNode'; path: string; targetPath: string }
  | { type: 'reparentNodes'; paths: string[]; targetPath: string }
  | { type: 'toggleCollapse'; path: string }
  | { type: 'deleteNode'; path: string }
  | { type: 'toggleFlag'; path: string; flag: Flag }
  | { type: 'moveNode'; path: string; direction: 'up' | 'down' };

type OperationResult =
  | { selectedPath?: string; selectedPaths?: string[]; editPath?: string }
  | undefined;

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(SwiftMapEditorProvider.register(context));

  context.subscriptions.push(
    vscode.commands.registerCommand('swiftmap.newDocument', async () => {
      const doc = await vscode.workspace.openTextDocument({
        language: 'swiftmap',
        content: '+ [] Root',
      });
      await vscode.window.showTextDocument(doc, { preview: false });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('swiftmap.openSource', async (uri?: vscode.Uri) => {
      const targetUri = uri ?? getActiveSwiftMapUri();
      if (!targetUri) {
        void vscode.window.showErrorMessage('No SwiftMap document is currently active.');
        return;
      }

      await vscode.commands.executeCommand(
        'vscode.openWith',
        targetUri,
        'default',
        vscode.window.activeTextEditor?.viewColumn,
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('swiftmap.openVisualEditor', async (uri?: vscode.Uri) => {
      const targetUri = uri ?? getActiveSwiftMapUri();
      if (!targetUri) {
        void vscode.window.showErrorMessage('No SwiftMap document is currently active.');
        return;
      }

      await vscode.commands.executeCommand(
        'vscode.openWith',
        targetUri,
        SwiftMapEditorProvider.viewType,
        vscode.window.activeTextEditor?.viewColumn,
      );
    }),
  );
}

export function deactivate(): void {}

function getActiveSwiftMapUri(): vscode.Uri | undefined {
  const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
  if (activeTab?.input instanceof vscode.TabInputCustom) {
    return activeTab.input.uri;
  }
  return vscode.window.activeTextEditor?.document.uri;
}

class SwiftMapEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = 'swiftmap.editor';

  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new SwiftMapEditorProvider(context);
    return vscode.window.registerCustomEditorProvider(SwiftMapEditorProvider.viewType, provider, {
      webviewOptions: {
        retainContextWhenHidden: true,
      },
      supportsMultipleEditorsPerDocument: false,
    });
  }

  private constructor(private readonly context: vscode.ExtensionContext) {}

  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
  ): Promise<void> {
    webviewPanel.webview.options = {
      enableScripts: true,
    };
    webviewPanel.webview.html = this.getHtml(webviewPanel.webview);

    const updateWebview = () => {
      try {
        const parsed = parseDocument(document.getText());
        const tree = serializeForWebview(parsed.root, '0');
        const message: DocumentStateMessage = { type: 'document', tree };
        void webviewPanel.webview.postMessage(message);
      } catch (error) {
        const message: ErrorMessage = {
          type: 'error',
          message: error instanceof Error ? error.message : 'Failed to parse SwiftMap document.',
        };
        void webviewPanel.webview.postMessage(message);
      }
    };

    const changeDocumentSubscription = vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.uri.toString() === document.uri.toString()) {
        updateWebview();
      }
    });

    const messageSubscription = webviewPanel.webview.onDidReceiveMessage(async (message: WebviewMessage) => {
      try {
        switch (message.type) {
          case 'ready':
            updateWebview();
            return;
          case 'undo':
            await vscode.commands.executeCommand('undo');
            return;
          case 'redo':
            await vscode.commands.executeCommand('redo');
            return;
          case 'copyNodeText': {
            const parsed = parseDocument(document.getText());
            const node = getNodeByPath(parsed.root, parsePath(message.path));
            await vscode.env.clipboard.writeText(node.name);
            return;
          }
          case 'pasteNodeText': {
            const text = await vscode.env.clipboard.readText();
            const result = await this.applyMessage(document, {
              type: 'setName',
              path: message.path,
              name: text,
            });
            if (result) {
              await webviewPanel.webview.postMessage({ type: 'operationResult', ...result });
            }
            return;
          }
          default: {
            const result = await this.applyMessage(document, message);
            if (result) {
              await webviewPanel.webview.postMessage({ type: 'operationResult', ...result });
            }
            return;
          }
        }
      } catch (error) {
        const text = error instanceof Error ? error.message : 'SwiftMap operation failed.';
        void vscode.window.showErrorMessage(text);
        await webviewPanel.webview.postMessage({ type: 'operationError', message: text });
      }
    });

    webviewPanel.onDidDispose(() => {
      changeDocumentSubscription.dispose();
      messageSubscription.dispose();
    });
  }

  private async applyMessage(document: vscode.TextDocument, message: Exclude<WebviewMessage, { type: 'ready' | 'undo' | 'redo' }>): Promise<OperationResult> {
    const parsed = parseDocument(document.getText());
    const path = 'path' in message ? parsePath(message.path) : [];

    let result: OperationResult;
    switch (message.type) {
      case 'setName':
        getNodeByPath(parsed.root, path).name = sanitizeName(message.name);
        result = { selectedPath: message.path };
        break;
      case 'addChild': {
        const parent = getNodeByPath(parsed.root, path);
        parent.collapsed = false;
        const childIndex = parent.children.length;
        parent.children.push({
          name: '',
          collapsed: false,
          flags: [],
          children: [],
        });
        result = { selectedPath: `${message.path}.${childIndex}`, editPath: `${message.path}.${childIndex}` };
        break;
      }
      case 'addSibling': {
        if (path.length === 0) {
          throw new Error('Root node cannot have sibling nodes added.');
        }
        const parentPath = path.slice(0, -1);
        const parent = getNodeByPath(parsed.root, parentPath);
        parent.collapsed = false;
        const currentIndex = path[path.length - 1];
        const insertIndex = message.position === 'before' ? currentIndex : currentIndex + 1;
        parent.children.splice(insertIndex, 0, {
          name: '',
          collapsed: false,
          flags: [],
          children: [],
        });
        const nextPath = formatPath([...parentPath, insertIndex]);
        result = { selectedPath: nextPath, editPath: nextPath };
        break;
      }
      case 'reparentNode': {
        if (path.length === 0) {
          throw new Error('Root node cannot be moved.');
        }
        const targetPath = parsePath(message.targetPath);
        if (pathsEqual(path, targetPath)) {
          throw new Error('A node cannot be dropped onto itself.');
        }
        if (isDescendantPath(targetPath, path)) {
          throw new Error('A node cannot be moved into its own subtree.');
        }

        const sourceParent = getNodeByPath(parsed.root, path.slice(0, -1));
        const sourceIndex = path[path.length - 1];
        const movingNode = sourceParent.children[sourceIndex];
        if (!movingNode) {
          throw new Error('Selected node no longer exists.');
        }

        const targetNode = getNodeByPath(parsed.root, targetPath);
        targetNode.collapsed = false;
        sourceParent.children.splice(sourceIndex, 1);
        targetNode.children.push(movingNode);

        const movedPath = findPathToNode(parsed.root, movingNode);
        if (!movedPath) {
          throw new Error('Failed to locate moved node.');
        }
        result = { selectedPath: formatPath(movedPath) };
        break;
      }
      case 'reparentNodes': {
        const sourcePaths = message.paths.map(parsePath);
        if (sourcePaths.length === 0) {
          throw new Error('No nodes selected.');
        }
        if (sourcePaths.some((sourcePath) => sourcePath.length === 0)) {
          throw new Error('Root node cannot be moved.');
        }

        const targetPath = parsePath(message.targetPath);
        for (const sourcePath of sourcePaths) {
          if (pathsEqual(sourcePath, targetPath)) {
            throw new Error('A node cannot be dropped onto itself.');
          }
          if (isDescendantPath(targetPath, sourcePath)) {
            throw new Error('A node cannot be moved into its own subtree.');
          }
        }
        for (let leftIndex = 0; leftIndex < sourcePaths.length; leftIndex += 1) {
          for (let rightIndex = leftIndex + 1; rightIndex < sourcePaths.length; rightIndex += 1) {
            if (isDescendantPath(sourcePaths[leftIndex], sourcePaths[rightIndex]) || isDescendantPath(sourcePaths[rightIndex], sourcePaths[leftIndex])) {
              throw new Error('Selected nodes cannot contain one another.');
            }
          }
        }

        const movingEntries = sourcePaths.map((sourcePath) => {
          const sourceParent = getNodeByPath(parsed.root, sourcePath.slice(0, -1));
          const sourceIndex = sourcePath[sourcePath.length - 1];
          const movingNode = sourceParent.children[sourceIndex];
          if (!movingNode) {
            throw new Error('Selected node no longer exists.');
          }
          return { path: sourcePath, parent: sourceParent, node: movingNode };
        });

        const targetNode = getNodeByPath(parsed.root, targetPath);
        const movingNodes = movingEntries
          .slice()
          .sort((left, right) => comparePaths(left.path, right.path))
          .map((entry) => entry.node);

        for (const entry of movingEntries) {
          const currentIndex = entry.parent.children.indexOf(entry.node);
          if (currentIndex < 0) {
            throw new Error('Selected node no longer exists.');
          }
          entry.parent.children.splice(currentIndex, 1);
        }

        targetNode.collapsed = false;
        targetNode.children.push(...movingNodes);

        const movedPaths = movingNodes.map((movingNode) => {
          const movedPath = findPathToNode(parsed.root, movingNode);
          if (!movedPath) {
            throw new Error('Failed to locate moved node.');
          }
          return formatPath(movedPath);
        });
        result = { selectedPath: movedPaths[0], selectedPaths: movedPaths };
        break;
      }
      case 'toggleCollapse': {
        const node = getNodeByPath(parsed.root, path);
        node.collapsed = !node.collapsed;
        result = { selectedPath: message.path };
        break;
      }
      case 'deleteNode': {
        if (path.length === 0) {
          throw new Error('Root node cannot be deleted.');
        }
        const parent = getNodeByPath(parsed.root, path.slice(0, -1));
        const index = path[path.length - 1];
        parent.children.splice(index, 1);
        result = { selectedPath: path.length === 1 ? '0' : formatPath(path.slice(0, -1)) };
        break;
      }
      case 'toggleFlag': {
        const node = getNodeByPath(parsed.root, path);
        const current = new Set(node.flags);
        if (current.has(message.flag)) {
          current.delete(message.flag);
        } else {
          current.add(message.flag);
        }
        node.flags = Array.from(current).sort((a, b) => a - b) as Flag[];
        result = { selectedPath: message.path };
        break;
      }
      case 'moveNode': {
        if (path.length === 0) {
          throw new Error('Root node cannot be reordered.');
        }
        const parent = getNodeByPath(parsed.root, path.slice(0, -1));
        const index = path[path.length - 1];
        const targetIndex =
          message.direction === 'up'
            ? (index - 1 + parent.children.length) % parent.children.length
            : (index + 1) % parent.children.length;
        if (targetIndex !== index) {
          const [node] = parent.children.splice(index, 1);
          parent.children.splice(targetIndex, 0, node);
        }
        const movedPath = [...path.slice(0, -1), targetIndex];
        result = { selectedPath: formatPath(movedPath) };
        break;
      }
    }

    await replaceDocument(document, serializeDocument(parsed.root));
    return result;
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const csp = [
      "default-src 'none'",
      `script-src 'nonce-${nonce}'`,
      "style-src 'unsafe-inline'",
      'img-src data:',
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>SwiftMap</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-editor-foreground);
      --muted: color-mix(in srgb, var(--fg) 42%, transparent);
      --surface: color-mix(in srgb, var(--bg) 88%, var(--fg) 12%);
      --surface-active: color-mix(in srgb, var(--vscode-focusBorder) 22%, var(--surface) 78%);
      --border: color-mix(in srgb, var(--fg) 16%, transparent);
      --accent: var(--vscode-focusBorder);
      --done: #2ea043;
      --rejected: #cf222e;
      --question: #1f6feb;
      --task: #7c3aed;
      --idea: #d29922;
      --priority-low: #8b949e;
      --priority-medium: #d29922;
      --priority-high: #fb8500;
      --danger: #da3633;
      --shadow: 0 8px 24px rgba(0, 0, 0, 0.16);
      --font: var(--vscode-font-family, "Segoe UI", sans-serif);
    }

    * {
      box-sizing: border-box;
    }

    html, body {
      margin: 0;
      width: 100%;
      height: 100%;
      overflow: hidden;
      background: radial-gradient(circle at top left, color-mix(in srgb, var(--surface) 70%, transparent) 0%, transparent 40%), var(--bg);
      color: var(--fg);
      font-family: var(--font);
    }

    #app {
      width: 100%;
      height: 100%;
      position: relative;
      overflow: hidden;
      cursor: grab;
      user-select: none;
    }

    #app.dragging {
      cursor: grabbing;
    }

    #status {
      position: absolute;
      top: 12px;
      left: 12px;
      z-index: 20;
      max-width: min(440px, calc(100% - 24px));
      padding: 10px 12px;
      border-radius: 10px;
      background: color-mix(in srgb, var(--bg) 76%, var(--danger) 24%);
      border: 1px solid color-mix(in srgb, var(--danger) 50%, transparent);
      color: var(--fg);
      font-size: 12px;
      line-height: 1.4;
      display: none;
      white-space: pre-wrap;
    }

    #hud {
      position: absolute;
      right: 12px;
      bottom: 12px;
      z-index: 20;
      display: flex;
      gap: 8px;
      align-items: center;
      padding: 8px 10px;
      border-radius: 999px;
      background: color-mix(in srgb, var(--bg) 84%, transparent);
      border: 1px solid var(--border);
      font-size: 12px;
      backdrop-filter: blur(10px);
    }

    #viewport {
      position: absolute;
      inset: 0;
      overflow: hidden;
    }

    #canvas {
      position: absolute;
      left: 0;
      top: 0;
      transform-origin: 0 0;
      min-width: 100%;
      min-height: 100%;
    }

    #edges {
      position: absolute;
      inset: 0;
      overflow: visible;
      pointer-events: none;
    }

    .edge {
      fill: none;
      stroke: color-mix(in srgb, var(--fg) 28%, transparent);
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }

    .node {
      position: absolute;
      width: 184px;
      padding: 8px 10px;
      border-radius: 12px;
      border: 1px solid var(--border);
      background: var(--surface);
      box-shadow: var(--shadow);
      transition: transform 120ms ease, border-color 120ms ease, background 120ms ease;
      cursor: pointer;
    }

    .node:hover {
      transform: translateY(-1px);
    }

    .node.selected {
      border-color: color-mix(in srgb, var(--accent) 70%, white 12%);
      background: var(--surface-active);
    }

    .node.editing {
      border-color: color-mix(in srgb, var(--accent) 78%, white 18%);
    }

    .node.dragging-node {
      opacity: 0.58;
      transform: scale(0.98);
    }

    .node.drop-target {
      border-color: color-mix(in srgb, var(--accent) 82%, white 18%);
      box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 35%, transparent), var(--shadow);
    }

    .node-root {
      background: color-mix(in srgb, var(--accent) 12%, var(--surface) 88%);
    }

    .node-header {
      display: flex;
      align-items: center;
      gap: 6px;
      min-height: 18px;
    }

    .name {
      flex: 1;
      white-space: normal;
      overflow-wrap: anywhere;
      font-size: 12px;
      line-height: 1.35;
      min-width: 0;
    }

    .editor {
      width: 100%;
      border: none;
      outline: none;
      background: transparent;
      color: inherit;
      padding: 0;
      margin: 0;
      font: inherit;
      font-size: 12px;
      line-height: 1.35;
      resize: none;
      overflow: hidden;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }

    .meta {
      display: flex;
      align-items: center;
      gap: 4px;
      flex-wrap: wrap;
    }

    .meta.has-flags {
      margin-top: 4px;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      min-width: 0;
      padding: 1px 5px;
      border-radius: 999px;
      background: color-mix(in srgb, var(--bg) 80%, transparent);
      border: 1px solid color-mix(in srgb, var(--fg) 12%, transparent);
      font-size: 10px;
      line-height: 1.2;
      white-space: nowrap;
    }

    .flag-done {
      color: var(--done);
    }

    .flag-idea {
      color: var(--idea);
    }

    .flag-rejected {
      color: var(--rejected);
    }

    .flag-question {
      color: var(--question);
    }

    .flag-task {
      color: var(--task);
    }

    .flag-priority-low {
      color: var(--priority-low);
    }

    .flag-priority-medium {
      color: var(--priority-medium);
    }

    .flag-priority-high {
      color: var(--priority-high);
    }

    .collapse {
      color: var(--muted);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 18px;
      height: 18px;
      font-size: 13px;
      font-weight: 700;
      line-height: 1;
      min-width: 18px;
      border-radius: 5px;
      border: 1px solid color-mix(in srgb, var(--fg) 18%, transparent);
      background: color-mix(in srgb, var(--bg) 86%, transparent);
    }

    .hint {
      position: absolute;
      left: 12px;
      bottom: 12px;
      z-index: 20;
      max-width: 460px;
      color: var(--muted);
      font-size: 11px;
      line-height: 1.45;
      background: color-mix(in srgb, var(--bg) 82%, transparent);
      padding: 8px 10px;
      border-radius: 12px;
      border: 1px solid var(--border);
      backdrop-filter: blur(10px);
    }

    .hint-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }

    .hint-title {
      font-weight: 600;
    }

    .hint-toggle {
      border: 1px solid var(--border);
      background: color-mix(in srgb, var(--bg) 88%, transparent);
      color: var(--muted);
      border-radius: 8px;
      padding: 2px 8px;
      font: inherit;
      line-height: 1.2;
      cursor: pointer;
    }

    .hint-toggle:hover {
      color: var(--fg);
    }

    .hint-body {
      margin-top: 6px;
    }

    .hint.collapsed .hint-body {
      display: none;
    }

    .context-menu {
      position: fixed;
      z-index: 40;
      min-width: 220px;
      max-width: min(280px, calc(100vw - 16px));
      max-height: min(680px, calc(100vh - 16px));
      overflow-y: auto;
      display: none;
      padding: 4px;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: color-mix(in srgb, var(--bg) 92%, var(--fg) 8%);
      box-shadow: var(--shadow);
      color: var(--fg);
      font-size: 12px;
    }

    .context-menu.open {
      display: block;
    }

    .context-menu-section {
      padding: 4px 0;
      border-top: 1px solid var(--border);
    }

    .context-menu-section:first-child {
      border-top: none;
    }

    .context-menu-item {
      width: 100%;
      min-height: 26px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      border: none;
      border-radius: 5px;
      padding: 4px 8px;
      background: transparent;
      color: inherit;
      font: inherit;
      text-align: left;
      cursor: pointer;
    }

    .context-menu-item:hover:not(:disabled),
    .context-menu-item:focus-visible {
      outline: none;
      background: color-mix(in srgb, var(--accent) 20%, transparent);
    }

    .context-menu-item:disabled {
      color: var(--muted);
      cursor: default;
    }

    .context-menu-icon {
      color: var(--muted);
      flex-shrink: 0;
      width: 16px;
      text-align: center;
      opacity: 0.7;
    }

    .context-menu-check {
      color: var(--accent);
      min-width: 12px;
      text-align: right;
    }

    .context-menu-label {
      min-width: 0;
      flex: 1;
    }
  </style>
</head>
<body>
  <div id="app">
    <div id="status"></div>
    <div id="viewport">
      <div id="canvas">
        <svg id="edges"></svg>
        <div id="nodes"></div>
      </div>
    </div>
    <div id="hud">
      <span id="zoomLabel">100%</span>
    </div>
    <div class="hint" id="hint">
      <div class="hint-header">
        <span class="hint-title">Keyboard Hints</span>
        <button class="hint-toggle" id="hintToggle" type="button">Hide</button>
      </div>
      <div class="hint-body" id="hintBody"></div>
    </div>
    <div class="context-menu" id="contextMenu" role="menu"></div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const app = document.getElementById('app');
    const canvas = document.getElementById('canvas');
    const nodesLayer = document.getElementById('nodes');
    const edgesLayer = document.getElementById('edges');
    const statusEl = document.getElementById('status');
    const zoomLabel = document.getElementById('zoomLabel');
    const hintEl = document.getElementById('hint');
    const hintBodyEl = document.getElementById('hintBody');
    const hintToggleEl = document.getElementById('hintToggle');
    const contextMenuEl = document.getElementById('contextMenu');

    const state = {
      tree: null,
      selectedPath: '0',
      selectedPaths: new Set(['0']),
      editingPath: null,
      editValue: '',
      panX: 80,
      panY: 80,
      zoom: 1,
      pendingSelection: null,
      pendingSelectedPaths: null,
      pendingEdit: null,
      pendingCreatedNodePath: null,
      hintCollapsed: true,
      layoutByPath: new Map(),
      measuredHeights: new Map(),
      flatNodes: [],
      drag: null,
      nodeDrag: null,
      draggedNodePath: null,
      draggedNodePaths: null,
      dropTargetPath: null,
      contextMenuPath: null,
    };

    let focusFrame = 0;
    let rerenderFrame = 0;

    const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
    const altLabel = isMac ? 'Option' : 'Alt';

    const layoutConfig = {
      nodeWidth: 184,
      nodeHeight: 34,
      horizontalGap: 88,
      verticalGap: 14,
      padding: 120,
    };

    function post(message) {
      vscode.postMessage(message);
    }

    function escapeHtml(value) {
      return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
    }

    function showError(message) {
      statusEl.style.display = message ? 'block' : 'none';
      statusEl.textContent = message || '';
    }

    function renderHint() {
      hintBodyEl.textContent =
        'Enter/F2 edit, Shift+Enter add child, ' +
        altLabel + '+Enter add sibling below, Shift+' + altLabel + '+Enter add sibling above, ' +
        'Space collapse, Delete remove, ' +
        'Ctrl+' + altLabel + '+1 done, ' +
        'Ctrl+' + altLabel + '+2 rejected, ' +
        'Ctrl+' + altLabel + '+3 question, ' +
        'Ctrl+' + altLabel + '+4 task, ' +
        'Ctrl+' + altLabel + '+5 idea, ' +
        'Ctrl+' + altLabel + '+6 low priority, ' +
        'Ctrl+' + altLabel + '+7 medium priority, ' +
        'Ctrl+' + altLabel + '+8 high priority, Ctrl+Up/Down reorder.';
      hintEl.classList.toggle('collapsed', state.hintCollapsed);
      hintToggleEl.textContent = state.hintCollapsed ? 'Show' : 'Hide';
    }

    function setTransform() {
      canvas.style.transform = 'translate(' + state.panX + 'px, ' + state.panY + 'px) scale(' + state.zoom + ')';
      zoomLabel.textContent = Math.round(state.zoom * 100) + '%';
    }

    function collectVisible(node, parentPath, depth, list) {
      list.push({ node, path: node.path, depth, parentPath });
      if (!node.collapsed) {
        for (const child of node.children) {
          collectVisible(child, node.path, depth + 1, list);
        }
      }
    }

    function layoutTree(root) {
      const layoutByPath = new Map();
      let cursorY = 0;

      function shiftSubtree(path, deltaY) {
        for (const [key, layout] of layoutByPath.entries()) {
          if (key === path || key.startsWith(path + '.')) {
            layoutByPath.set(key, { ...layout, y: layout.y + deltaY });
          }
        }
      }

      function visit(node, depth, parentPath) {
        const x = depth * (layoutConfig.nodeWidth + layoutConfig.horizontalGap);
        const height = getNodeHeight(node.path, node);
        if (!node.children.length || node.collapsed) {
          const y = cursorY;
          cursorY += height + layoutConfig.verticalGap;
          layoutByPath.set(node.path, { x, y, height, parentPath, depth });
          return { top: y, bottom: y + height, center: y + height / 2 };
        }

        const startY = cursorY;
        let childTop = Number.POSITIVE_INFINITY;
        let childBottom = Number.NEGATIVE_INFINITY;
        const childCenters = [];
        for (const child of node.children) {
          const childLayout = visit(child, depth + 1, node.path);
          childTop = Math.min(childTop, childLayout.top);
          childBottom = Math.max(childBottom, childLayout.bottom);
          childCenters.push(childLayout.center);
        }
        let centerY = (childCenters[0] + childCenters[childCenters.length - 1]) / 2;
        let y = centerY - height / 2;

        if (y < startY) {
          const deltaY = startY - y;
          shiftSubtree(node.path, deltaY);
          childTop += deltaY;
          childBottom += deltaY;
          centerY += deltaY;
          y += deltaY;
        }

        layoutByPath.set(node.path, { x, y, height, parentPath, depth });
        const top = Math.min(y, childTop);
        const bottom = Math.max(y + height, childBottom);
        cursorY = bottom + layoutConfig.verticalGap;
        return { top, bottom, center: centerY };
      }

      visit(root, 0, null);
      return layoutByPath;
    }

    function setSingleSelection(path) {
      state.selectedPath = path;
      state.selectedPaths = new Set([path]);
    }

    function toggleSelection(path) {
      const next = new Set(state.selectedPaths);
      if (next.has(path) && next.size > 1) {
        next.delete(path);
      } else {
        next.add(path);
        state.selectedPath = path;
      }
      state.selectedPaths = next;
    }

    function normalizeSelection() {
      const paths = new Set(state.flatNodes.map((entry) => entry.path));
      if (state.pendingSelection && paths.has(state.pendingSelection)) {
        state.selectedPath = state.pendingSelection;
        state.pendingSelection = null;
      } else if (!paths.has(state.selectedPath)) {
        state.selectedPath = '0';
      }

      if (state.pendingSelectedPaths) {
        const selectedPaths = state.pendingSelectedPaths.filter((path) => paths.has(path));
        state.selectedPaths = new Set(selectedPaths.length > 0 ? selectedPaths : [state.selectedPath]);
        state.pendingSelectedPaths = null;
      } else {
        const selectedPaths = Array.from(state.selectedPaths).filter((path) => paths.has(path));
        state.selectedPaths = new Set(selectedPaths.length > 0 ? selectedPaths : [state.selectedPath]);
      }
      if (!state.selectedPaths.has(state.selectedPath)) {
        state.selectedPaths.add(state.selectedPath);
      }

      if (state.pendingEdit && paths.has(state.pendingEdit)) {
        state.editingPath = state.pendingEdit;
        const node = state.flatNodes.find((entry) => entry.path === state.pendingEdit);
        state.editValue = node ? node.node.name : '';
        state.pendingEdit = null;
      } else if (state.editingPath && !paths.has(state.editingPath)) {
        state.editingPath = null;
        state.editValue = '';
      }

      if (state.pendingCreatedNodePath && !paths.has(state.pendingCreatedNodePath)) {
        state.pendingCreatedNodePath = null;
      }
    }

    function render() {
      nodesLayer.innerHTML = '';
      edgesLayer.innerHTML = '';
      if (!state.tree) {
        return;
      }

      let layoutDirty = false;

      state.layoutByPath = layoutTree(state.tree);
      state.flatNodes = [];
      collectVisible(state.tree, null, 0, state.flatNodes);
      normalizeSelection();

      let maxX = 0;
      let maxY = 0;
      for (const entry of state.flatNodes) {
        const layout = state.layoutByPath.get(entry.path);
        maxX = Math.max(maxX, layout.x);
        maxY = Math.max(maxY, layout.y + layout.height);
      }

      edgesLayer.setAttribute('width', String(maxX + layoutConfig.nodeWidth + layoutConfig.padding));
      edgesLayer.setAttribute('height', String(maxY + layoutConfig.padding));
      canvas.style.width = maxX + layoutConfig.nodeWidth + layoutConfig.padding + 'px';
      canvas.style.height = maxY + layoutConfig.padding + 'px';

      for (const entry of state.flatNodes) {
        const layout = state.layoutByPath.get(entry.path);
        if (layout.parentPath) {
          const parentLayout = state.layoutByPath.get(layout.parentPath);
          const startX = parentLayout.x + layoutConfig.nodeWidth;
          const startY = parentLayout.y + parentLayout.height / 2;
          const endX = layout.x;
          const endY = layout.y + layout.height / 2;
          const midX = startX + (endX - startX) / 2;
          const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          path.setAttribute('class', 'edge');
          path.setAttribute('d', 'M ' + startX + ' ' + startY + ' C ' + midX + ' ' + startY + ', ' + midX + ' ' + endY + ', ' + endX + ' ' + endY);
          edgesLayer.appendChild(path);
        }

        const nodeEl = document.createElement('div');
        const selected = state.selectedPaths.has(entry.path);
        const editing = entry.path === state.editingPath;
        nodeEl.className = 'node' + (selected ? ' selected' : '') + (editing ? ' editing' : '') + (entry.path === '0' ? ' node-root' : '');
        if (state.draggedNodePaths && state.draggedNodePaths.includes(entry.path)) {
          nodeEl.className += ' dragging-node';
        }
        if (entry.path === state.dropTargetPath) {
          nodeEl.className += ' drop-target';
        }
        nodeEl.style.left = layout.x + 'px';
        nodeEl.style.top = layout.y + 'px';
        nodeEl.dataset.path = entry.path;

        const hasChildren = entry.node.children.length > 0;
        const collapseIndicator = hasChildren ? (entry.node.collapsed ? '+' : '−') : '';
        const doneBadge = entry.node.flags.includes(1) ? '<span class="badge flag-done">✓ Done</span>' : '';
        const rejectedBadge = entry.node.flags.includes(2) ? '<span class="badge flag-rejected">✕ Rejected</span>' : '';
        const questionBadge = entry.node.flags.includes(3) ? '<span class="badge flag-question">? Question</span>' : '';
        const taskBadge = entry.node.flags.includes(4) ? '<span class="badge flag-task">☰ Task</span>' : '';
        const ideaBadge = entry.node.flags.includes(5) ? '<span class="badge flag-idea">💡 Idea</span>' : '';
        const lowPriorityBadge = entry.node.flags.includes(6) ? '<span class="badge flag-priority-low">Low priority</span>' : '';
        const mediumPriorityBadge = entry.node.flags.includes(7) ? '<span class="badge flag-priority-medium">Medium priority</span>' : '';
        const highPriorityBadge = entry.node.flags.includes(8) ? '<span class="badge flag-priority-high">High priority</span>' : '';
        const flagsMarkup = doneBadge + rejectedBadge + questionBadge + taskBadge + ideaBadge + lowPriorityBadge + mediumPriorityBadge + highPriorityBadge;
        const metaMarkup = flagsMarkup ? '<div class="meta has-flags">' + flagsMarkup + '</div>' : '';

        nodeEl.innerHTML =
          '<div class="node-header">' +
            '<span class="collapse">' + collapseIndicator + '</span>' +
            (editing
              ? '<textarea class="editor" spellcheck="false" rows="1">' + escapeHtml(state.editValue) + '</textarea>'
              : '<div class="name">' + escapeHtml(entry.node.name || ' ') + '</div>') +
          '</div>' +
          metaMarkup;

        nodeEl.addEventListener('mousedown', (event) => {
          event.stopPropagation();
          if (editing || entry.path === '0' || event.button !== 0) {
            return;
          }
          if (!state.selectedPaths.has(entry.path) && !event.ctrlKey && !event.metaKey) {
            setSingleSelection(entry.path);
          }
          state.nodeDrag = {
            path: entry.path,
            startX: event.clientX,
            startY: event.clientY,
            selectedPaths: Array.from(state.selectedPaths),
          };
        });
        nodeEl.addEventListener('click', (event) => {
          event.stopPropagation();
          if (state.draggedNodePath) {
            return;
          }
          closeContextMenu();
          if (event.ctrlKey || event.metaKey) {
            toggleSelection(entry.path);
          } else {
            setSingleSelection(entry.path);
          }
          render();
        });
        nodeEl.addEventListener('contextmenu', (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (!state.selectedPaths.has(entry.path)) {
            setSingleSelection(entry.path);
          } else {
            state.selectedPath = entry.path;
          }
          state.editingPath = null;
          render();
          openContextMenu(entry.path, event.clientX, event.clientY);
        });
        nodesLayer.appendChild(nodeEl);

        if (!editing) {
          layoutDirty = updateMeasuredHeight(entry.path, nodeEl, layout.height) || layoutDirty;
        }

        if (editing) {
          const input = nodeEl.querySelector('textarea');
          scheduleEditorFocus(input);
          autoSizeEditor(input);
          if (updateMeasuredHeight(entry.path, nodeEl, layout.height)) {
            scheduleRerender();
          }
          input.addEventListener('input', () => {
            autoSizeEditor(input);
            if (updateMeasuredHeight(entry.path, nodeEl, layout.height)) {
              scheduleRerender();
            }
            state.editValue = input.value;
          });
          input.addEventListener('keydown', (event) => {
            event.stopPropagation();
            if (event.key === 'Enter') {
              event.preventDefault();
              commitEdit();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              cancelEdit();
            }
          });
        }
      }

      setTransform();
      if (layoutDirty) {
        scheduleRerender();
      }
    }

    function scheduleEditorFocus(input) {
      if (focusFrame) {
        cancelAnimationFrame(focusFrame);
      }
      focusFrame = requestAnimationFrame(() => {
        input.focus();
        autoSizeEditor(input);
        input.setSelectionRange(input.value.length, input.value.length);
        focusFrame = 0;
      });
    }

    function scheduleRerender() {
      if (rerenderFrame) {
        return;
      }
      rerenderFrame = requestAnimationFrame(() => {
        rerenderFrame = 0;
        render();
      });
    }

    function autoSizeEditor(input) {
      input.style.height = '0px';
      input.style.height = input.scrollHeight + 'px';
    }

    function updateMeasuredHeight(path, nodeEl, fallbackHeight) {
      if (state.editingPath === path) {
        const liveHeight = Math.ceil(nodeEl.getBoundingClientRect().height);
        nodeEl.style.minHeight = Math.max(fallbackHeight, liveHeight) + 'px';
        if (state.measuredHeights.get(path) !== liveHeight) {
          state.measuredHeights.set(path, liveHeight);
          return true;
        }
        return false;
      }
      const naturalHeight = Math.ceil(nodeEl.getBoundingClientRect().height);
      nodeEl.style.minHeight = Math.max(fallbackHeight, naturalHeight) + 'px';
      if (state.measuredHeights.get(path) !== naturalHeight) {
        state.measuredHeights.set(path, naturalHeight);
        return true;
      }
      return false;
    }

    function closeContextMenu() {
      state.contextMenuPath = null;
      contextMenuEl.classList.remove('open');
      contextMenuEl.innerHTML = '';
    }

    function appendContextMenuSection(items) {
      const section = document.createElement('div');
      section.className = 'context-menu-section';
      for (const item of items) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'context-menu-item';
        button.disabled = Boolean(item.disabled);
        button.setAttribute('role', 'menuitem');

        if (item.icon) {
          const icon = document.createElement('span');
          icon.className = 'context-menu-icon';
          icon.textContent = item.icon;
          button.appendChild(icon);
        }

        const label = document.createElement('span');
        label.className = 'context-menu-label' + (item.className ? ' ' + item.className : '');
        label.textContent = item.label;
        button.appendChild(label);

        const check = document.createElement('span');
        check.className = 'context-menu-check';
        check.textContent = item.checked ? '✓' : '';
        button.appendChild(check);

        button.addEventListener('click', (event) => {
          event.stopPropagation();
          if (item.disabled) {
            return;
          }
          closeContextMenu();
          item.run();
        });
        section.appendChild(button);
      }
      contextMenuEl.appendChild(section);
    }

    function openContextMenu(path, clientX, clientY) {
      const entry = state.flatNodes.find((candidate) => candidate.path === path);
      if (!entry) {
        return;
      }

      const isRoot = path === '0';
      const hasChildren = entry.node.children.length > 0;
      state.contextMenuPath = path;
      contextMenuEl.innerHTML = '';

      appendContextMenuSection([
        { label: 'Edit', icon: '✎', run: () => startEdit(path) },
        { label: 'Copy text', icon: '📋', run: () => post({ type: 'copyNodeText', path }) },
        { label: 'Paste text', icon: '📋', run: () => post({ type: 'pasteNodeText', path }) },
        { label: 'Undo', icon: '↶', run: () => post({ type: 'undo' }) },
        { label: 'Redo', icon: '↷', run: () => post({ type: 'redo' }) },
      ]);

      appendContextMenuSection([
        { label: 'Add child', icon: '➕', run: () => post({ type: 'addChild', path }) },
        { label: 'Add sibling above', icon: '➕', disabled: isRoot, run: () => post({ type: 'addSibling', path, position: 'before' }) },
        { label: 'Add sibling below', icon: '➕', disabled: isRoot, run: () => post({ type: 'addSibling', path, position: 'after' }) },
      ]);

      appendContextMenuSection([
        { label: entry.node.collapsed ? 'Expand' : 'Collapse', icon: entry.node.collapsed ? '⌄' : '⌃', disabled: !hasChildren, run: () => post({ type: 'toggleCollapse', path }) },
        { label: 'Move up', icon: '⬆', disabled: isRoot, run: () => post({ type: 'moveNode', path, direction: 'up' }) },
        { label: 'Move down', icon: '⬇', disabled: isRoot, run: () => post({ type: 'moveNode', path, direction: 'down' }) },
        { label: 'Delete', icon: '🗑', disabled: isRoot, run: () => post({ type: 'deleteNode', path }) },
      ]);

      appendContextMenuSection([
        { label: '✓ Done', className: 'flag-done', checked: entry.node.flags.includes(1), run: () => post({ type: 'toggleFlag', path, flag: 1 }) },
        { label: '✕ Rejected', className: 'flag-rejected', checked: entry.node.flags.includes(2), run: () => post({ type: 'toggleFlag', path, flag: 2 }) },
        { label: '? Question', className: 'flag-question', checked: entry.node.flags.includes(3), run: () => post({ type: 'toggleFlag', path, flag: 3 }) },
        { label: '☰ Task', className: 'flag-task', checked: entry.node.flags.includes(4), run: () => post({ type: 'toggleFlag', path, flag: 4 }) },
        { label: '💡 Idea', className: 'flag-idea', checked: entry.node.flags.includes(5), run: () => post({ type: 'toggleFlag', path, flag: 5 }) },
        { label: 'Low priority', className: 'flag-priority-low', checked: entry.node.flags.includes(6), run: () => post({ type: 'toggleFlag', path, flag: 6 }) },
        { label: 'Medium priority', className: 'flag-priority-medium', checked: entry.node.flags.includes(7), run: () => post({ type: 'toggleFlag', path, flag: 7 }) },
        { label: 'High priority', className: 'flag-priority-high', checked: entry.node.flags.includes(8), run: () => post({ type: 'toggleFlag', path, flag: 8 }) },
      ]);

      contextMenuEl.classList.add('open');
      contextMenuEl.style.left = '0px';
      contextMenuEl.style.top = '0px';
      const menuRect = contextMenuEl.getBoundingClientRect();
      const left = Math.min(clientX, window.innerWidth - menuRect.width - 8);
      const top = Math.min(clientY, window.innerHeight - menuRect.height - 8);
      contextMenuEl.style.left = Math.max(8, left) + 'px';
      contextMenuEl.style.top = Math.max(8, top) + 'px';
    }

    function currentIndex() {
      return state.flatNodes.findIndex((entry) => entry.path === state.selectedPath);
    }

    function selectedEntry() {
      return state.flatNodes.find((entry) => entry.path === state.selectedPath) || null;
    }

    function ensureSelectedVisible() {
      const layout = state.layoutByPath.get(state.selectedPath);
      if (!layout) {
        return;
      }
      const scaledX = layout.x * state.zoom + state.panX;
      const scaledY = layout.y * state.zoom + state.panY;
      const width = layoutConfig.nodeWidth * state.zoom;
      const height = layout.height * state.zoom;
      const margin = 40;
      if (scaledX < margin) {
        state.panX += margin - scaledX;
      } else if (scaledX + width > window.innerWidth - margin) {
        state.panX -= scaledX + width - (window.innerWidth - margin);
      }
      if (scaledY < margin) {
        state.panY += margin - scaledY;
      } else if (scaledY + height > window.innerHeight - margin) {
        state.panY -= scaledY + height - (window.innerHeight - margin);
      }
      setTransform();
    }

    function moveSelectionVertical(direction) {
      const entry = selectedEntry();
      if (!entry) {
        return;
      }

      const segments = entry.path.split('.');
      if (segments.length === 1) {
        if (entry.node.children.length > 0) {
          const childIndex = direction > 0 ? 0 : entry.node.children.length - 1;
          setSingleSelection(entry.node.children[childIndex].path);
        }
        state.editingPath = null;
        ensureSelectedVisible();
        render();
        return;
      }

      const selfIndex = Number(segments[segments.length - 1]);
      const parentPath = segments.slice(0, -1).join('.');
      const parentEntry = state.flatNodes.find((candidate) => candidate.path === parentPath);
      if (!parentEntry || parentEntry.node.children.length === 0) {
        return;
      }

      const siblingCount = parentEntry.node.children.length;
      const nextIndex = (selfIndex + direction + siblingCount) % siblingCount;
      setSingleSelection(parentEntry.node.children[nextIndex].path);
      state.editingPath = null;
      ensureSelectedVisible();
      render();
    }

    function navigateHorizontal(direction) {
      const entry = selectedEntry();
      if (!entry) {
        return;
      }
      if (direction > 0) {
        if (!entry.node.collapsed && entry.node.children.length > 0) {
          setSingleSelection(entry.node.children[0].path);
        }
      } else {
        const segments = entry.path.split('.');
        if (segments.length > 1) {
          segments.pop();
          setSingleSelection(segments.join('.'));
        }
      }
      ensureSelectedVisible();
      render();
    }

    function startEdit(path) {
      const entry = state.flatNodes.find((candidate) => candidate.path === path);
      if (!entry) {
        return;
      }
      setSingleSelection(path);
      state.editingPath = path;
      state.editValue = entry.node.name;
      state.pendingCreatedNodePath = null;
      state.measuredHeights.delete(path);
      render();
    }

    function commitEdit() {
      if (!state.editingPath) {
        return;
      }
      const path = state.editingPath;
      const value = state.editValue;
      state.editingPath = null;
      state.pendingCreatedNodePath = null;
      state.pendingSelection = path;
      state.measuredHeights.delete(path);
      post({ type: 'setName', path, name: value });
    }

    function copySelectedNodeText() {
      const entry = selectedEntry();
      if (!entry) {
        return;
      }
      post({ type: 'copyNodeText', path: entry.path });
    }

    function pasteIntoSelectedNodeText() {
      const entry = selectedEntry();
      if (!entry) {
        return;
      }
      post({ type: 'pasteNodeText', path: entry.path });
    }

    function cancelEdit() {
      const path = state.editingPath;
      const shouldDeleteCreatedNode = path && state.pendingCreatedNodePath === path;
      state.editingPath = null;
      state.editValue = '';
      state.pendingCreatedNodePath = null;
      if (path) {
        state.measuredHeights.delete(path);
      }
      render();
      if (shouldDeleteCreatedNode) {
        post({ type: 'deleteNode', path });
      }
    }

    function zoomAt(nextZoom, clientX, clientY) {
      const bounded = Math.min(2.2, Math.max(0.35, nextZoom));
      const worldX = (clientX - state.panX) / state.zoom;
      const worldY = (clientY - state.panY) / state.zoom;
      state.zoom = bounded;
      state.panX = clientX - worldX * state.zoom;
      state.panY = clientY - worldY * state.zoom;
      setTransform();
    }

    function canDropNodes(sourcePaths, targetPath) {
      if (!sourcePaths || sourcePaths.length === 0 || !targetPath) {
        return false;
      }
      for (const sourcePath of sourcePaths) {
        if (sourcePath === '0' || sourcePath === targetPath || targetPath.startsWith(sourcePath + '.')) {
          return false;
        }
      }
      return true;
    }

    function findDropTargetPath(clientX, clientY) {
      const element = document.elementFromPoint(clientX, clientY);
      const node = element ? element.closest('.node') : null;
      const targetPath = node ? node.dataset.path || null : null;
      return canDropNodes(state.draggedNodePaths, targetPath) ? targetPath : null;
    }

    function getNodeHeight(path, node) {
      const measuredHeight = state.measuredHeights.get(path);
      if (measuredHeight) {
        return measuredHeight;
      }
      const charsPerLine = 22;
      const lines = Math.max(1, Math.ceil((node.name || ' ').length / charsPerLine));
      const nameHeight = lines * 16;
      const flagCount = node.flags.length;
      const flagRows = flagCount > 0 ? Math.ceil(flagCount / 2) : 0;
      const flagsHeight = flagRows > 0 ? flagRows * 15 + 4 : 0;
      return Math.max(layoutConfig.nodeHeight, 16 + nameHeight + flagsHeight);
    }

    app.addEventListener('mousedown', (event) => {
      if (event.target.closest('.context-menu')) {
        return;
      }
      closeContextMenu();
      if (event.target.closest('.node')) {
        return;
      }
      state.drag = {
        x: event.clientX,
        y: event.clientY,
        panX: state.panX,
        panY: state.panY,
      };
      app.classList.add('dragging');
    });

    window.addEventListener('mousemove', (event) => {
      if (state.nodeDrag) {
        const moved = Math.abs(event.clientX - state.nodeDrag.startX) + Math.abs(event.clientY - state.nodeDrag.startY);
        if (!state.draggedNodePath && moved > 6) {
          state.draggedNodePath = state.nodeDrag.path;
          state.draggedNodePaths = state.nodeDrag.selectedPaths && state.nodeDrag.selectedPaths.length > 0 ? state.nodeDrag.selectedPaths : [state.nodeDrag.path];
          state.selectedPath = state.nodeDrag.path;
          state.selectedPaths = new Set(state.draggedNodePaths);
          render();
        }
      }

      if (state.draggedNodePath) {
        const nextDropTargetPath = findDropTargetPath(event.clientX, event.clientY);
        if (state.dropTargetPath !== nextDropTargetPath) {
          state.dropTargetPath = nextDropTargetPath;
          render();
        }
        return;
      }

      if (!state.drag) {
        return;
      }
      state.panX = state.drag.panX + (event.clientX - state.drag.x);
      state.panY = state.drag.panY + (event.clientY - state.drag.y);
      setTransform();
    });

    window.addEventListener('mouseup', () => {
      if (state.draggedNodePath) {
        const draggedPath = state.draggedNodePath;
        const draggedPaths = state.draggedNodePaths || [draggedPath];
        const targetPath = state.dropTargetPath;
        state.nodeDrag = null;
        state.draggedNodePath = null;
        state.draggedNodePaths = null;
        state.dropTargetPath = null;
        render();
        if (canDropNodes(draggedPaths, targetPath)) {
          if (draggedPaths.length === 1) {
            post({ type: 'reparentNode', path: draggedPath, targetPath });
          } else {
            post({ type: 'reparentNodes', paths: draggedPaths, targetPath });
          }
        }
        return;
      }

      state.nodeDrag = null;
      state.drag = null;
      app.classList.remove('dragging');
    });

    app.addEventListener('wheel', (event) => {
      event.preventDefault();
      const delta = event.deltaY < 0 ? 1.08 : 0.92;
      zoomAt(state.zoom * delta, event.clientX, event.clientY);
    }, { passive: false });

    window.addEventListener('keydown', (event) => {
      if (!state.tree) {
        return;
      }

      if (event.key === 'Escape' && state.contextMenuPath) {
        event.preventDefault();
        closeContextMenu();
        return;
      }

      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        return;
      }

      if (state.editingPath) {
        if (event.key === 'Escape') {
          event.preventDefault();
          cancelEdit();
        }
        return;
      }

      if (event.ctrlKey || event.metaKey) {
        if (!event.altKey && (event.key === 'c' || event.key === 'C')) {
          event.preventDefault();
          copySelectedNodeText();
          return;
        }
        if (!event.altKey && (event.key === 'v' || event.key === 'V')) {
          event.preventDefault();
          pasteIntoSelectedNodeText();
          return;
        }
        if (event.key === 'z' || event.key === 'Z') {
          event.preventDefault();
          post({ type: 'undo' });
          return;
        }
        if (event.key === 'y' || event.key === 'Y') {
          event.preventDefault();
          post({ type: 'redo' });
          return;
        }
        if (event.altKey && /^[1-8]$/.test(event.key)) {
          event.preventDefault();
          post({
            type: 'toggleFlag',
            path: state.selectedPath,
            flag: Number(event.key),
          });
          return;
        }
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          event.preventDefault();
          post({ type: 'moveNode', path: state.selectedPath, direction: event.key === 'ArrowUp' ? 'up' : 'down' });
          return;
        }
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        moveSelectionVertical(-1);
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        moveSelectionVertical(1);
        return;
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        navigateHorizontal(-1);
        return;
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        navigateHorizontal(1);
        return;
      }
      if (event.key === 'Enter' && event.shiftKey && event.altKey) {
        event.preventDefault();
        post({ type: 'addSibling', path: state.selectedPath, position: 'before' });
        return;
      }
      if (event.key === 'Enter' && event.altKey) {
        event.preventDefault();
        post({ type: 'addSibling', path: state.selectedPath, position: 'after' });
        return;
      }
      if (event.key === 'Enter' && event.shiftKey) {
        event.preventDefault();
        state.pendingSelection = state.selectedPath;
        post({ type: 'addChild', path: state.selectedPath });
        return;
      }
      if (event.key === 'Enter' || event.key === 'F2') {
        event.preventDefault();
        startEdit(state.selectedPath);
        return;
      }
      if (event.key === ' ') {
        event.preventDefault();
        post({ type: 'toggleCollapse', path: state.selectedPath });
        return;
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        post({ type: 'deleteNode', path: state.selectedPath });
      }
    });

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.type === 'document') {
        showError('');
        state.tree = message.tree;
        state.measuredHeights.clear();
        render();
        ensureSelectedVisible();
      } else if (message.type === 'error') {
        showError(message.message);
      } else if (message.type === 'operationResult') {
        if (message.selectedPath) {
          state.pendingSelection = message.selectedPath;
        }
        if (message.selectedPaths) {
          state.pendingSelectedPaths = message.selectedPaths;
        } else if (message.selectedPath) {
          state.pendingSelectedPaths = [message.selectedPath];
        }
        if (message.editPath) {
          state.pendingEdit = message.editPath;
          state.pendingSelection = message.editPath;
          state.pendingSelectedPaths = [message.editPath];
          state.pendingCreatedNodePath = message.editPath;
        }
        render();
        ensureSelectedVisible();
      } else if (message.type === 'operationError') {
        showError(message.message);
      }
    });

    hintToggleEl.addEventListener('click', () => {
      state.hintCollapsed = !state.hintCollapsed;
      renderHint();
    });

    renderHint();
    post({ type: 'ready' });
    setTransform();
  </script>
</body>
</html>`;
  }
}

async function replaceDocument(document: vscode.TextDocument, text: string): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  const start = new vscode.Position(0, 0);
  const end = document.lineCount === 0
    ? new vscode.Position(0, 0)
    : document.lineAt(document.lineCount - 1).rangeIncludingLineBreak.end;
  edit.replace(document.uri, new vscode.Range(start, end), text);
  await vscode.workspace.applyEdit(edit);
}

function parseDocument(text: string): ParsedDocument {
  const lines = text.length === 0 ? ['+ [] Root'] : text.replace(/\r/g, '').split('\n');
  const stack: Array<{ indent: number; node: MindMapNode }> = [];
  let root: MindMapNode | undefined;

  for (const rawLine of lines) {
    if (rawLine.trim().length === 0) {
      continue;
    }
    const indentMatch = rawLine.match(/^\s*/);
    const indentText = indentMatch ? indentMatch[0] : '';
    const indent = indentText.replace(/\t/g, '  ').length;
    const content = rawLine.slice(indentText.length);
    const match = content.match(/^([+-])\s+(\[(?:Done|Rejected|Question|Task|Idea|Low priority|Medium priority|High priority)?(?:,(?:Done|Rejected|Question|Task|Idea|Low priority|Medium priority|High priority))*\])\s?(.*)$/);
    if (!match) {
      throw new Error(`Invalid SwiftMap line: "${rawLine}"`);
    }

    const collapsed = match[1] === '-';
    const flags = parseFlags(match[2]);
    const name = sanitizeName(match[3]);
    const node: MindMapNode = {
      name,
      collapsed,
      flags,
      children: [],
    };

    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }

    if (!root) {
      if (indent !== 0) {
        throw new Error('Root node must not be indented.');
      }
      root = node;
      stack.push({ indent, node });
      continue;
    }

    const parentEntry = stack[stack.length - 1];
    if (!parentEntry) {
      throw new Error(`Invalid indentation near "${rawLine}"`);
    }

    parentEntry.node.children.push(node);
    stack.push({ indent, node });
  }

  if (!root) {
    root = {
      name: 'Root',
      collapsed: false,
      flags: [],
      children: [],
    };
  }

  return { root };
}

function parseFlags(input: string): Flag[] {
  if (input === '[]') {
    return [];
  }
  if (!/^\[(Done|Rejected|Question|Task|Idea|Low priority|Medium priority|High priority)(,(Done|Rejected|Question|Task|Idea|Low priority|Medium priority|High priority))*\]$/.test(input)) {
    throw new Error(`Invalid flags token "${input}"`);
  }

  const names = input.slice(1, -1).split(',');
  const flags = names.map((name) => {
    if (name === 'Done') {
      return 1;
    }
    if (name === 'Rejected') {
      return 2;
    }
    if (name === 'Question') {
      return 3;
    }
    if (name === 'Task') {
      return 4;
    }
    if (name === 'Idea') {
      return 5;
    }
    if (name === 'Low priority') {
      return 6;
    }
    if (name === 'Medium priority') {
      return 7;
    }
    if (name === 'High priority') {
      return 8;
    }
    throw new Error(`Unknown flag "${name}"`);
  }) as Flag[];

  if (new Set(flags).size !== flags.length) {
    throw new Error(`Duplicated flags token "${input}"`);
  }
  if (flags.some((flag, index) => index > 0 && flags[index - 1] > flag)) {
    throw new Error(`Flags must be ordered as [Done,Rejected,Question,Task,Idea,Low priority,Medium priority,High priority], got "${input}"`);
  }
  return flags;
}

function serializeDocument(root: MindMapNode): string {
  const lines: string[] = [];

  const visit = (node: MindMapNode, depth: number) => {
    const indent = '  '.repeat(depth);
    const status = node.collapsed ? '-' : '+';
    const flags = node.flags.length > 0 ? `[${node.flags.map(formatFlag).join(',')}]` : '[]';
    lines.push(`${indent}${status} ${flags} ${sanitizeName(node.name)}`);
    for (const child of node.children) {
      visit(child, depth + 1);
    }
  };

  visit(root, 0);
  return lines.join('\n');
}

function serializeForWebview(node: MindMapNode, path: string): SerializedNode {
  return {
    path,
    name: node.name,
    collapsed: node.collapsed,
    flags: [...node.flags],
    children: node.children.map((child, index) => serializeForWebview(child, `${path}.${index}`)),
  };
}

function getNodeByPath(root: MindMapNode, path: number[]): MindMapNode {
  let current = root;
  for (const index of path) {
    const next = current.children[index];
    if (!next) {
      throw new Error('Selected node no longer exists.');
    }
    current = next;
  }
  return current;
}

function parsePath(path: string): number[] {
  if (path === '0') {
    return [];
  }
  const parts = path.split('.').slice(1);
  return parts.map((part) => {
    const value = Number(part);
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`Invalid path "${path}"`);
    }
    return value;
  });
}

function formatPath(path: number[]): string {
  return path.length === 0 ? '0' : `0.${path.join('.')}`;
}

function pathsEqual(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function comparePaths(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] - right[index];
    }
  }
  return left.length - right.length;
}

function isDescendantPath(candidate: number[], ancestor: number[]): boolean {
  return candidate.length > ancestor.length && ancestor.every((value, index) => candidate[index] === value);
}

function findPathToNode(root: MindMapNode, target: MindMapNode): number[] | undefined {
  if (root === target) {
    return [];
  }

  const visit = (node: MindMapNode, path: number[]): number[] | undefined => {
    for (let index = 0; index < node.children.length; index += 1) {
      const child = node.children[index];
      const childPath = [...path, index];
      if (child === target) {
        return childPath;
      }
      const nested = visit(child, childPath);
      if (nested) {
        return nested;
      }
    }
    return undefined;
  };

  return visit(root, []);
}

function sanitizeName(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

function formatFlag(flag: Flag): 'Done' | 'Rejected' | 'Question' | 'Task' | 'Idea' | 'Low priority' | 'Medium priority' | 'High priority' {
  if (flag === 1) {
    return 'Done';
  }
  if (flag === 2) {
    return 'Rejected';
  }
  if (flag === 3) {
    return 'Question';
  }
  if (flag === 4) {
    return 'Task';
  }
  if (flag === 5) {
    return 'Idea';
  }
  if (flag === 6) {
    return 'Low priority';
  }
  if (flag === 7) {
    return 'Medium priority';
  }
  return 'High priority';
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';
  for (let i = 0; i < 16; i += 1) {
    value += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return value;
}
