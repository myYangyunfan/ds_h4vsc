/**
 * Access to the VS Code webview messaging API. In standalone `vite dev` mode
 * (outside of VS Code) a console mock keeps the UI fully explorable.
 */
interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare global {
  interface Window {
    acquireVsCodeApi?: () => VsCodeApi;
  }
}

function acquire(): VsCodeApi {
  if (window.acquireVsCodeApi) {
    return window.acquireVsCodeApi();
  }
  console.warn('[dsh] running outside VS Code - using mock messaging API');
  return {
    postMessage: () => undefined,
    getState: () => undefined,
    setState: () => undefined,
  };
}

export const vscodeApi: VsCodeApi = acquire();

export function postToHost(message: unknown): void {
  vscodeApi.postMessage(message);
}
