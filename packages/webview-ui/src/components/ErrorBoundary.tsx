import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | undefined;
}

/**
 * Last-resort boundary: a render crash in any panel component (malformed
 * markdown, unexpected entry shape) degrades to a visible error message
 * instead of a blank white panel.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: undefined };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[dsh] panel render error:', error.message, info.componentStack);
  }

  override render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="error-boundary">
          <i className="codicon codicon-error" />
          <span>面板渲染出现异常：{this.state.error.message}</span>
          <button
            className="link-button"
            onClick={() => this.setState({ error: undefined })}
          >
            重试
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
