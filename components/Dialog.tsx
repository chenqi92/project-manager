import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { Button, Input, Modal } from './ui';

interface ConfirmOptions {
  title?: string;
  message: ReactNode;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}
interface PromptOptions {
  title?: string;
  message?: ReactNode;
  defaultValue?: string;
  placeholder?: string;
  confirmText?: string;
}

interface DialogApi {
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  prompt: (opts: PromptOptions) => Promise<string | null>;
}

const Ctx = createContext<DialogApi | null>(null);

export function useDialog(): DialogApi {
  const c = useContext(Ctx);
  if (!c) throw new Error('useDialog 必须在 <DialogProvider> 内使用');
  return c;
}

type State =
  | { kind: 'confirm'; opts: ConfirmOptions; resolve: (v: boolean) => void }
  | { kind: 'prompt'; opts: PromptOptions; resolve: (v: string | null) => void }
  | null;

/** 替代原生 window.confirm / window.prompt 的样式化弹框（Promise 化）。 */
export function DialogProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>(null);
  const [input, setInput] = useState('');

  const confirm = useCallback(
    (opts: ConfirmOptions) =>
      new Promise<boolean>((resolve) => setState({ kind: 'confirm', opts, resolve })),
    [],
  );
  const prompt = useCallback(
    (opts: PromptOptions) =>
      new Promise<string | null>((resolve) => {
        setInput(opts.defaultValue ?? '');
        setState({ kind: 'prompt', opts, resolve });
      }),
    [],
  );

  const settle = (result: boolean | string | null) => {
    if (!state) return;
    if (state.kind === 'confirm') state.resolve(result as boolean);
    else state.resolve(result as string | null);
    setState(null);
  };

  return (
    <Ctx.Provider value={{ confirm, prompt }}>
      {children}
      {state?.kind === 'confirm' && (
        <Modal title={state.opts.title ?? '确认'} onClose={() => settle(false)}>
          <div className="text-sm leading-relaxed text-gray-600">{state.opts.message}</div>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="subtle" onClick={() => settle(false)}>
              {state.opts.cancelText ?? '取消'}
            </Button>
            <Button
              variant={state.opts.danger ? 'danger' : 'primary'}
              autoFocus
              onClick={() => settle(true)}
            >
              {state.opts.confirmText ?? '确定'}
            </Button>
          </div>
        </Modal>
      )}
      {state?.kind === 'prompt' && (
        <Modal title={state.opts.title ?? '输入'} onClose={() => settle(null)}>
          {state.opts.message && <div className="mb-2 text-sm text-gray-600">{state.opts.message}</div>}
          <Input
            autoFocus
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={state.opts.placeholder}
            onKeyDown={(e) => {
              if (e.key === 'Enter') settle(input);
            }}
          />
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="subtle" onClick={() => settle(null)}>
              取消
            </Button>
            <Button onClick={() => settle(input)}>{state.opts.confirmText ?? '确定'}</Button>
          </div>
        </Modal>
      )}
    </Ctx.Provider>
  );
}
