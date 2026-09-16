/**
 * Structured logging to a VS Code output channel. Kept dependency-light so it
 * can also be used by backend classes in tests (pass a channel-like stub).
 */
export interface LogSink {
  appendLine(value: string): void;
}

export class Logger {
  constructor(private readonly sink: LogSink, private readonly context = 'dsh') {}

  info(message: string): void {
    this.write('INFO', message);
  }

  warn(message: string): void {
    this.write('WARN', message);
  }

  error(message: string, err?: unknown): void {
    const detail = err instanceof Error ? ` :: ${err.stack ?? err.message}` : '';
    this.write('ERROR', message + detail);
  }

  debug(message: string): void {
    this.write('DEBUG', message);
  }

  private write(level: string, message: string): void {
    const time = new Date().toISOString();
    this.sink.appendLine(`[${time}] [${this.context}] [${level}] ${message}`);
  }
}
