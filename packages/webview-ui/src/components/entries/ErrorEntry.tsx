export function ErrorEntry({ text }: { text: string }) {
  return (
    <div className="entry entry-error" role="alert">
      <i className="codicon codicon-error" />
      <span>{text}</span>
    </div>
  );
}
