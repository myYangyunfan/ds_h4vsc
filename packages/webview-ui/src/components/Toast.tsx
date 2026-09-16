import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useT, type StringKey } from '../strings.js';

export type ToastTone = 'info' | 'success' | 'danger';

interface ToastItem {
  id: number;
  text: string;
  tone: ToastTone;
}

interface ToastContextValue {
  toast: (key: StringKey, tone?: ToastTone) => void;
}

const ToastContext = createContext<ToastContextValue>({ toast: () => undefined });

export function useToast(): ToastContextValue {
  return useContext(ToastContext);
}

const TOAST_TTL_MS = 2_200;
const MAX_TOASTS = 3;

export function ToastProvider({ children }: { children: ReactNode }) {
  const t = useT();
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(0);

  const toast = useCallback(
    (key: StringKey, tone: ToastTone = 'info') => {
      const id = (nextId.current += 1);
      setItems((prev) => [...prev.slice(-MAX_TOASTS + 1), { id, text: t(key), tone }]);
    },
    [t],
  );

  // Auto-dismiss: each toast gets its own timer.
  useEffect(() => {
    if (items.length === 0) {
      return;
    }
    const timers = items.map((item) =>
      setTimeout(() => {
        setItems((prev) => prev.filter((entry) => entry.id !== item.id));
      }, TOAST_TTL_MS),
    );
    return () => timers.forEach(clearTimeout);
  }, [items]);

  const value = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-container" role="status" aria-live="polite">
        {items.map((item) => (
          <div key={item.id} className={`toast toast-${item.tone}`}>
            <i
              className={`codicon ${
                item.tone === 'success'
                  ? 'codicon-check'
                  : item.tone === 'danger'
                    ? 'codicon-close'
                    : 'codicon-info'
              }`}
            />
            <span>{item.text}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
